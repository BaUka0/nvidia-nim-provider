import * as vscode from "vscode";
import {
  CancellationToken,
  Event,
  EventEmitter,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { streamChatCompletion } from "./api";
import {
  CONTEXT_WINDOW_SAFETY_MARGIN,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  SECRET_STORAGE_KEY,
} from "./constants";
import { isNormalizedNvidiaModel, NormalizedNvidiaModel } from "./model-catalog";
import { debugLog } from "./output-channel";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  LegacyPart,
} from "./utils";

const DEFAULT_MAX_TOKENS = 65536;

interface ToolSchema {
  required?: string[];
  enumValues?: Record<string, string[]>;
}

interface SkippedToolCall {
  name: string;
  required: string[];
}

interface ParsedTextToolCall {
  name: string;
  args: unknown;
}

interface ParsedTextSegmentText {
  type: "text";
  text: string;
}

interface ParsedTextSegmentToolCall {
  type: "toolCall";
  toolCall: ParsedTextToolCall;
}

type ParsedTextSegment = ParsedTextSegmentText | ParsedTextSegmentToolCall;

interface ParsedTextToolCallResult {
  segments: ParsedTextSegment[];
  incompleteText: string;
}

interface ChatRequestContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
}

function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

function getCompletedToolCallKeys(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
): Set<string> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    const hasNonToolResultContent = message.content.some((part) => {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      return !(typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content));
    });
    if (hasNonToolResultContent) {
      startIndex = i + 1;
      break;
    }
  }

  const completedCallIds = new Set<string>();

  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
        completedCallIds.add(toolResultPart.callId);
      }
    }
  }

  const keys = new Set<string>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolCallPart = part as { callId?: unknown; name?: unknown; input?: unknown };
      if (
        typeof toolCallPart.callId !== "string" ||
        !completedCallIds.has(toolCallPart.callId) ||
        typeof toolCallPart.name !== "string"
      ) {
        continue;
      }

      const repairedArgs = repairToolArguments(
        toolCallPart.name,
        toolCallPart.input ?? {},
        requestContext,
        toolSchemas.get(toolCallPart.name),
      );
      keys.add(buildToolCallCanonicalKey(toolCallPart.name, repairedArgs));
    }
  }

  return keys;
}

function getToolSchemaMap(
  options: ProvideLanguageModelChatResponseOptions,
): Map<string, ToolSchema> {
  const map = new Map<string, ToolSchema>();
  for (const tool of options.tools ?? []) {
    const inputSchema = tool.inputSchema as
      | { required?: unknown; properties?: unknown }
      | undefined;
    const required = Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : undefined;
    const enumValues: Record<string, string[]> = {};
    const properties =
      typeof inputSchema?.properties === "object" && inputSchema.properties !== null
        ? (inputSchema.properties as Record<string, unknown>)
        : {};
    for (const [name, value] of Object.entries(properties)) {
      const propertySchema =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as { enum?: unknown })
          : undefined;
      if (Array.isArray(propertySchema?.enum)) {
        const allowed = propertySchema.enum.filter(
          (item): item is string => typeof item === "string",
        );
        if (allowed.length > 0) {
          enumValues[name] = allowed;
        }
      }
    }
    map.set(tool.name, { required, enumValues });
  }
  return map;
}

function hasRequiredToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  const required = schema?.required ?? [];
  if (required.length === 0) {
    return true;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const record = args as Record<string, unknown>;
  return required.every(
    (key) =>
      key in record && record[key] !== undefined && record[key] !== null && record[key] !== "",
  );
}

function buildInvalidToolCallFallback(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (!skippedWithRequiredArgs) {
    return undefined;
  }

  const requiredArgs = skippedWithRequiredArgs.required.map((arg) => `\`${arg}\``).join(", ");
  return `The model tried to call \`${skippedWithRequiredArgs.name}\` without the required argument(s) ${requiredArgs}. Please retry the request and provide those arguments explicitly.`;
}

function buildMissingApiKeyFallback(): string {
  return `${PROVIDER_DISPLAY_NAME} API key is not configured. Run "${PROVIDER_DISPLAY_NAME}: Manage ${PROVIDER_DISPLAY_NAME} API Key" from the Command Palette, or retry this request and enter the key when prompted.`;
}

function findTrailingTokenPrefixStart(text: string, token: string): number {
  const maxPrefixLength = Math.min(text.length, token.length - 1);
  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (text.endsWith(token.slice(0, prefixLength))) {
      return text.length - prefixLength;
    }
  }

  return -1;
}

function parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
  const beginToken = "<|tool_call_begin|>";
  const argBeginToken = "<|tool_call_argument_begin|>";
  const endToken = "<|tool_call_end|>";

  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const appendText = (value: string): void => {
    if (!value) {
      return;
    }
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text") {
      lastSegment.text += value;
      return;
    }
    segments.push({ type: "text", text: value });
  };

  while (remaining.length > 0) {
    const beginIndex = remaining.indexOf(beginToken);
    if (beginIndex === -1) {
      const partialBeginIndex = findTrailingTokenPrefixStart(remaining, beginToken);
      if (partialBeginIndex === -1) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialBeginIndex));
        incompleteText = remaining.slice(partialBeginIndex);
      }
      break;
    }

    appendText(remaining.slice(0, beginIndex));
    remaining = remaining.slice(beginIndex + beginToken.length);

    const argBeginIndex = remaining.indexOf(argBeginToken);
    const endIndex = remaining.indexOf(endToken);
    if (argBeginIndex === -1 || endIndex === -1 || argBeginIndex > endIndex) {
      incompleteText = beginToken + remaining;
      break;
    }

    const name = remaining.slice(0, argBeginIndex).trim();
    const argsText = remaining.slice(argBeginIndex + argBeginToken.length, endIndex).trim();
    remaining = remaining.slice(endIndex + endToken.length);

    if (!name) {
      continue;
    }

    try {
      segments.push({
        type: "toolCall",
        toolCall: { name, args: argsText ? JSON.parse(argsText) : {} },
      });
    } catch {
      appendText(`${beginToken}${name}${argBeginToken}${argsText}${endToken}`);
    }
  }

  return { segments, incompleteText };
}

function extractChatRequestContext(
  messages: readonly LanguageModelChatMessage[],
): ChatRequestContext | undefined {
  const filePattern = /The user's current file is\s+([^\n]+?)\.(?:\s|$)/;
  const selectionPattern = /The current selection is from line\s+(\d+)\s+to line\s+(\d+)/;
  const cwdPattern = /(?:^|\n)Cwd:\s+([^\n]+)/;
  const context: ChatRequestContext = {};

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.content) {
      const text =
        part instanceof vscode.LanguageModelTextPart
          ? part.value
          : typeof part === "object" &&
              part !== null &&
              "value" in part &&
              typeof (part as { value?: unknown }).value === "string"
            ? (part as { value: string }).value
            : undefined;

      if (!text) {
        continue;
      }

      const fileMatch = text.match(filePattern);
      const selectionMatch = text.match(selectionPattern);
      const cwdMatch = text.match(cwdPattern);

      if (fileMatch && !context.filePath) {
        context.filePath = fileMatch[1].trim();
      }
      if (cwdMatch && !context.cwd) {
        context.cwd = cwdMatch[1].trim();
      }
      if (selectionMatch && context.startLine === undefined && context.endLine === undefined) {
        const startLine = Number(selectionMatch[1]);
        const endLine = Number(selectionMatch[2]);
        if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
          context.startLine = startLine;
          context.endLine = endLine;
        }
      }

      if (
        context.filePath &&
        context.cwd &&
        context.startLine !== undefined &&
        context.endLine !== undefined
      ) {
        break;
      }
    }
  }

  return context.filePath ||
    context.cwd ||
    context.startLine !== undefined ||
    context.endLine !== undefined
    ? context
    : undefined;
}

function repairToolArguments(
  toolName: string,
  args: unknown,
  requestContext: ChatRequestContext | undefined,
  schema?: ToolSchema,
): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }

  const record = args as Record<string, unknown>;
  const required = new Set(schema?.required ?? []);
  const needsStringField = (value: unknown, field: string): boolean =>
    required.has(field) && (typeof value !== "string" || value.trim().length === 0);
  const needsNumberField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "number";
  const context = requestContext;

  if (!context) {
    return args;
  }

  if (toolName === "read_file") {
    return {
      ...record,
      ...(needsStringField(record.filePath, "filePath") && context.filePath
        ? { filePath: context.filePath }
        : {}),
      ...(needsNumberField(record.startLine, "startLine")
        ? { startLine: context.startLine ?? 1 }
        : {}),
      ...(needsNumberField(record.endLine, "endLine") ? { endLine: context.endLine ?? 200 } : {}),
    };
  }

  if (toolName === "list_dir") {
    return {
      ...record,
      ...(needsStringField(record.path, "path") && context.cwd ? { path: context.cwd } : {}),
    };
  }

  return args;
}

function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

export class OcGoChatModelProvider implements LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly globalState?: vscode.Memento,
  ) {}

  fireModelInfoChanged(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  private getNormalizedModels(): NormalizedNvidiaModel[] {
    const storedModels = this.globalState?.get<unknown>(MODELS_STATE_KEY);
    if (!Array.isArray(storedModels)) {
      return [];
    }

    return storedModels.every(isNormalizedNvidiaModel) ? storedModels : [];
  }

  private getAvailableModels(): NormalizedNvidiaModel[] {
    return this.getNormalizedModels();
  }

  private calculateMaxToolResultChars(contextWindow: number): number {
    if (contextWindow >= 500000) {
      return 50000;
    }
    if (contextWindow >= 200000) {
      return 30000;
    }
    if (contextWindow >= 100000) {
      return 20000;
    }
    return 10000;
  }

  /** Return true if any message contains image input parts. */
  private hasImageInput(messages: readonly LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        const p = part as { mimeType?: unknown; data?: unknown };
        if (typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) {
          return true;
        }
      }
    }
    return false;
  }

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    return this._mapToChatInformation(this.getAvailableModels());
  }

  private _mapToChatInformation(
    models: readonly NormalizedNvidiaModel[],
  ): LanguageModelChatInformation[] {
    return models.map((info) => {
      return {
        id: info.id,
        name: info.displayName,
        detail: PROVIDER_DISPLAY_NAME,
        tooltip: `${PROVIDER_DISPLAY_NAME} ${info.displayName}`,
        family: PROVIDER_VENDOR,
        version: "1.0.0",
        maxInputTokens: Math.max(
          1,
          info.contextWindow - Math.min(info.maxOutputTokens, DEFAULT_MAX_TOKENS),
        ),
        maxOutputTokens: info.maxOutputTokens,
        capabilities: {
          toolCalling: info.supportsTools ? 128 : false,
          imageInput: info.supportsVision,
        },
      };
    });
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const abortController = new AbortController();
    const cancellationSubscription = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const apiKey = await this.ensureApiKey(false);
      if (!apiKey) {
        progress.report(new vscode.LanguageModelTextPart(buildMissingApiKeyFallback()));
        return;
      }

      const inputTokenCount = estimateMessagesTokens(
        messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
      );
      const maxInputTokens = model.maxInputTokens;

      // Apply safety margin to maxInputTokens to prevent context overflow
      const effectiveMaxInputTokens = Math.max(1, maxInputTokens - CONTEXT_WINDOW_SAFETY_MARGIN);

      if (inputTokenCount > effectiveMaxInputTokens) {
        throw new Error(
          `Message exceeds token limit (${inputTokenCount} > ${effectiveMaxInputTokens}). Try reducing the conversation history or switching to a model with a larger context window.`,
        );
      }

      const maxTokensVal = (options.modelOptions as Record<string, unknown>)?.max_tokens;
      const requestedMaxTokens = Math.min(
        typeof maxTokensVal === "number" ? maxTokensVal : DEFAULT_MAX_TOKENS,
        model.maxOutputTokens,
      );

      const modelInfo = this.getAvailableModels().find((entry) => entry.id === model.id);
      const temperatureVal =
        typeof (options.modelOptions as Record<string, unknown>)?.temperature === "number"
          ? ((options.modelOptions as Record<string, unknown>).temperature as number)
          : 0.7;
      const supportsTools = modelInfo?.supportsTools ?? false;
      const supportsVision = modelInfo?.supportsVision ?? false;

      const hasImages = this.hasImageInput(messages);
      if (hasImages && !supportsVision) {
        progress.report(
          new vscode.LanguageModelTextPart(
            "The selected NVIDIA NIM model does not support image input.",
          ),
        );
        return;
      }

      const maxToolResultChars = this.calculateMaxToolResultChars(
        modelInfo?.contextWindow ?? model.maxInputTokens + model.maxOutputTokens,
      );

      let apiMessages = convertMessages(messages, {
        maxToolResultChars,
        supportsVision,
      });
      apiMessages = applyReasoningContentWorkaround(apiMessages, model.id);

      const toolConfig = supportsTools ? convertTools(options) : {};
      const requestBody: import("./types").OcGoChatRequest = {
        model: model.id,
        messages: apiMessages,
        stream: true,
        max_tokens: requestedMaxTokens,
        temperature: temperatureVal,
      };
      if (toolConfig.tools) {
        requestBody.tools = toolConfig.tools;
      }
      if (toolConfig.tool_choice) {
        requestBody.tool_choice = toolConfig.tool_choice;
      }

      debugLog("Outgoing request messages", requestBody.messages);

      // Buffers for assembling streamed tool calls by index
      const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
      const completedToolCallIndices = new Set<number>();
      const toolSchemas = getToolSchemaMap(options);
      const requestContext = extractChatRequestContext(messages);
      const skippedToolCalls: SkippedToolCall[] = [];
      const emittedTextToolCallKeys = getCompletedToolCallKeys(
        messages,
        requestContext,
        toolSchemas,
      );
      let pendingTextEmbeddedContent = "";
      let pendingText = "";
      let sawToolCall = false;
      let emittedToolCall = false;
      const flushPendingText = (): void => {
        if (!pendingText) {
          return;
        }
        progress.report(new vscode.LanguageModelTextPart(pendingText));
        pendingText = "";
      };

      for await (const chunk of streamChatCompletion(
        apiKey,
        requestBody,
        abortController.signal,
        this.userAgent,
      )) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const choice = chunk.choices?.[0];

        // Handle text content
        if (choice?.delta?.content) {
          const { segments, incompleteText } = parseTextEmbeddedToolCalls(
            pendingTextEmbeddedContent + choice.delta.content,
          );
          pendingTextEmbeddedContent = incompleteText;

          for (const segment of segments) {
            if (segment.type === "text") {
              pendingText += segment.text;
              continue;
            }

            const toolCall = segment.toolCall;
            sawToolCall = true;
            const schema = toolSchemas.get(toolCall.name);
            const repairedArgs = repairToolArguments(
              toolCall.name,
              toolCall.args,
              requestContext,
              schema,
            );
            const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
            if (emittedTextToolCallKeys.has(canonicalKey)) {
              continue;
            }

            if (hasRequiredToolArguments(repairedArgs, schema)) {
              flushPendingText();
              progress.report(
                new vscode.LanguageModelToolCallPart(
                  `text_tool_${Math.random().toString(36).slice(2, 10)}`,
                  toolCall.name,
                  repairedArgs as Record<string, unknown>,
                ),
              );
              emittedToolCall = true;
              emittedTextToolCallKeys.add(canonicalKey);
            } else {
              skippedToolCalls.push({
                name: toolCall.name,
                required: schema?.required ?? [],
              });
              debugLog("Skipped invalid text tool call", toolCall);
            }
          }
        }

        // Handle tool calls
        if (choice?.delta?.tool_calls) {
          sawToolCall = true;
          for (const tc of choice.delta.tool_calls) {
            const idx = (tc as { index?: number }).index ?? 0;
            if (completedToolCallIndices.has(idx)) {
              continue;
            }

            const buf = toolCallBuffers.get(idx) ?? { args: "" };
            if (tc.id && typeof tc.id === "string") {
              buf.id = tc.id;
            }
            const func = tc.function;
            if (func?.name && typeof func.name === "string") {
              buf.name = func.name;
            }
            if (typeof func?.arguments === "string") {
              buf.args += func.arguments;
            }
            toolCallBuffers.set(idx, buf);

            if (buf.args.trim().length === 0) {
              continue;
            }

            // Emit immediately once arguments become valid JSON
            try {
              const schema = toolSchemas.get(buf.name ?? "");
              const args = repairToolArguments(
                buf.name ?? "",
                buf.args ? JSON.parse(buf.args) : {},
                requestContext,
                schema,
              );
              if (
                buf.id &&
                buf.name &&
                isToolCallInput(args) &&
                hasRequiredToolArguments(args, schema)
              ) {
                const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
                if (emittedTextToolCallKeys.has(canonicalKey)) {
                  completedToolCallIndices.add(idx);
                  toolCallBuffers.delete(idx);
                  continue;
                }
                flushPendingText();
                progress.report(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
                emittedToolCall = true;
                emittedTextToolCallKeys.add(canonicalKey);
                completedToolCallIndices.add(idx);
                toolCallBuffers.delete(idx);
              } else if (buf.id && buf.name) {
                skippedToolCalls.push({
                  name: buf.name,
                  required: schema?.required ?? [],
                });
                debugLog("Skipped invalid tool call", { id: buf.id, name: buf.name, args });
                completedToolCallIndices.add(idx);
                toolCallBuffers.delete(idx);
              }
            } catch {
              // JSON incomplete — wait for next chunk
            }
          }
        }
      }

      if (pendingTextEmbeddedContent) {
        pendingText += pendingTextEmbeddedContent;
      }

      // Flush any remaining buffered tool calls at stream end
      for (const [idx, buf] of Array.from(toolCallBuffers.entries())) {
        if (completedToolCallIndices.has(idx)) {
          continue;
        }
        try {
          const schema = toolSchemas.get(buf.name ?? "");
          const args = repairToolArguments(
            buf.name ?? "",
            buf.args ? JSON.parse(buf.args) : {},
            requestContext,
            schema,
          );
          if (
            buf.id &&
            buf.name &&
            isToolCallInput(args) &&
            hasRequiredToolArguments(args, schema)
          ) {
            const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
            if (emittedTextToolCallKeys.has(canonicalKey)) {
              continue;
            }
            flushPendingText();
            progress.report(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
            emittedToolCall = true;
            emittedTextToolCallKeys.add(canonicalKey);
          } else if (buf.id && buf.name) {
            skippedToolCalls.push({
              name: buf.name,
              required: schema?.required ?? [],
            });
            debugLog("Skipped invalid tool call at stream end", {
              id: buf.id,
              name: buf.name,
              args,
            });
          }
        } catch {
          // Ignore incomplete JSON at stream end
        }
      }

      if (pendingText && (!sawToolCall || emittedToolCall || pendingText.trim().length > 0)) {
        flushPendingText();
      }

      if (sawToolCall && !emittedToolCall) {
        const fallbackText = buildInvalidToolCallFallback(skippedToolCalls);
        if (fallbackText) {
          progress.report(new vscode.LanguageModelTextPart(fallbackText));
        }
      }
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }
      throw err;
    } finally {
      cancellationSubscription.dispose();
    }
  }

  provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    _token: CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return Promise.resolve(Math.ceil(text.length / 2));
    }
    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += Math.ceil(part.value.length / 2);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "value" in part &&
        typeof (part as any).value === "string"
      ) {
        total += Math.ceil((part as any).value.length / 2);
      } else {
        total += 2; // rough estimate for non-text parts
      }
    }
    return Promise.resolve(total);
  }

  private async ensureApiKey(silent: boolean): Promise<string | undefined> {
    let apiKey = await this.secrets.get(SECRET_STORAGE_KEY);
    if (!apiKey && !silent) {
      const entered = await vscode.window.showInputBox({
        title: `${PROVIDER_DISPLAY_NAME} API Key`,
        prompt: `Enter your ${PROVIDER_DISPLAY_NAME} API key`,
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await this.secrets.store(SECRET_STORAGE_KEY, apiKey);
      }
    }
    return apiKey;
  }
}
