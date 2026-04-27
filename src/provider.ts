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
import { fetchModels, streamChatCompletion } from "./api";
import {
  CONTEXT_WINDOW_SAFETY_MARGIN,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  SECRET_STORAGE_KEY,
} from "./constants";
import {
  isNormalizedNvidiaModel,
  NormalizedNvidiaModel,
  normalizeNvidiaModels,
} from "./model-catalog";
import { getModelRequestProfile } from "./model-profile";
import { debugLog, outputLog } from "./output-channel";
import { OcGoChatMessage, OcGoChatRequest } from "./types";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateTokens,
  LegacyPart,
} from "./utils";

const DEFAULT_MAX_TOKENS = 65536;

interface NvidiaProviderConfiguration {
  apiKey?: string;
}

interface NvidiaLanguageModelChatInformation extends LanguageModelChatInformation {
  apiKey?: string;
  isUserSelectable?: boolean;
}

function getApiKeyFromConfiguration(
  options: PrepareLanguageModelChatModelOptions,
): string | undefined {
  const configuration = (options as { configuration?: NvidiaProviderConfiguration }).configuration;
  return getNonEmptyApiKey(configuration?.apiKey);
}

function getApiKeyFromModel(model: LanguageModelChatInformation): string | undefined {
  return getNonEmptyApiKey((model as NvidiaLanguageModelChatInformation).apiKey);
}

function getProviderGroupName(options: PrepareLanguageModelChatModelOptions): string | undefined {
  const group = (options as { group?: unknown }).group;
  if (typeof group === "string" && group.trim().length > 0) {
    return group.trim();
  }
  if (typeof group === "object" && group !== null) {
    const name = (group as { name?: unknown }).name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  }
  return undefined;
}

function hasProviderGroupConfiguration(options: PrepareLanguageModelChatModelOptions): boolean {
  const configuration = (options as { configuration?: unknown }).configuration;
  return typeof configuration === "object" && configuration !== null;
}

function getNonEmptyApiKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

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

interface ParsedTextSegmentInvalidToolCall {
  type: "invalidToolCall";
  name: string;
}

type ParsedTextSegment =
  | ParsedTextSegmentText
  | ParsedTextSegmentToolCall
  | ParsedTextSegmentInvalidToolCall;

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
  if (skippedWithRequiredArgs) {
    const requiredArgs = skippedWithRequiredArgs.required.map((arg) => `\`${arg}\``).join(", ");
    return `The model tried to call \`${skippedWithRequiredArgs.name}\` without the required argument(s) ${requiredArgs}. Please retry the request and provide those arguments explicitly.`;
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return `The model tried to call \`${firstSkippedToolCall.name}\` with invalid arguments. Please retry the request and provide a valid JSON object for that tool call.`;
}

function buildInvalidToolCallRetryMessage(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    return [
      `Your previous response tried to call ${skippedWithRequiredArgs.name} without the required arguments ${skippedWithRequiredArgs.required.join(", ")}.`,
      "Retry the response now.",
      "If you call a tool, return a valid JSON object and include every required argument explicitly.",
      "Do not call any tool with an empty object.",
      "Do not ask the user to retry.",
    ].join(" ");
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return [
    `Your previous response tried to call ${firstSkippedToolCall.name} with invalid arguments.`,
    "Retry the response now.",
    "If you call a tool, return a valid JSON object.",
    "Do not emit malformed JSON.",
    "Do not ask the user to retry.",
  ].join(" ");
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

function findTrailingTokenPrefixStartAny(text: string, tokens: readonly string[]): number {
  let bestMatch = -1;

  for (const token of tokens) {
    const matchIndex = findTrailingTokenPrefixStart(text, token);
    if (matchIndex !== -1 && (bestMatch === -1 || matchIndex < bestMatch)) {
      bestMatch = matchIndex;
    }
  }

  return bestMatch;
}

function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function stripKnownControlText(text: string): string {
  return text.replace(/<｜DSML｜[^\s<]*/g, "").replace(/<\|DSML\|>[^\s<]*/g, "");
}

function findControlTextTerminatorIndex(text: string): number {
  const terminatorMatch = text.match(/[\s<]/);
  return terminatorMatch?.index ?? -1;
}

function parseDeepSeekTextEmbeddedToolCallContent(
  content: string,
): { name: string; argsText: string } | undefined {
  const separatorToken = "<｜tool▁sep｜>";
  const separatorIndex = content.indexOf(separatorToken);
  if (separatorIndex === -1) {
    return undefined;
  }

  const afterSeparator = content.slice(separatorIndex + separatorToken.length).trim();
  if (!afterSeparator) {
    return undefined;
  }

  const newlineIndex = afterSeparator.indexOf("\n");
  const name =
    newlineIndex === -1 ? afterSeparator.trim() : afterSeparator.slice(0, newlineIndex).trim();
  const argsText =
    newlineIndex === -1 ? "" : unwrapJsonCodeFence(afterSeparator.slice(newlineIndex).trim());

  if (!name) {
    return undefined;
  }

  return {
    name,
    argsText,
  };
}

function parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
  const beginToken = "<|tool_call_begin|>";
  const argBeginToken = "<|tool_call_argument_begin|>";
  const endToken = "<|tool_call_end|>";
  const deepSeekCallsBeginToken = "<｜tool▁calls▁begin｜>";
  const deepSeekCallBeginToken = "<｜tool▁call▁begin｜>";
  const deepSeekCallEndToken = "<｜tool▁call▁end｜>";
  const deepSeekCallsEndToken = "<｜tool▁calls▁end｜>";
  const unicodeDsmlToken = "<｜DSML｜";
  const asciiDsmlToken = "<|DSML|>";
  const partialTokens = [
    beginToken,
    deepSeekCallsBeginToken,
    deepSeekCallBeginToken,
    deepSeekCallsEndToken,
    unicodeDsmlToken,
    asciiDsmlToken,
  ] as const;

  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const appendText = (value: string): void => {
    const sanitizedValue = stripKnownControlText(value);
    if (!sanitizedValue) {
      return;
    }
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text") {
      lastSegment.text += sanitizedValue;
      return;
    }
    segments.push({ type: "text", text: sanitizedValue });
  };

  while (remaining.length > 0) {
    const tokenMatches = [
      { kind: "openai", token: beginToken, index: remaining.indexOf(beginToken) },
      {
        kind: "strip",
        token: deepSeekCallsBeginToken,
        index: remaining.indexOf(deepSeekCallsBeginToken),
      },
      {
        kind: "deepseek",
        token: deepSeekCallBeginToken,
        index: remaining.indexOf(deepSeekCallBeginToken),
      },
      {
        kind: "strip",
        token: deepSeekCallsEndToken,
        index: remaining.indexOf(deepSeekCallsEndToken),
      },
      {
        kind: "control",
        token: unicodeDsmlToken,
        index: remaining.indexOf(unicodeDsmlToken),
      },
      {
        kind: "control",
        token: asciiDsmlToken,
        index: remaining.indexOf(asciiDsmlToken),
      },
    ].filter((match) => match.index !== -1);

    tokenMatches.sort((left, right) => left.index - right.index);
    const nextTokenMatch = tokenMatches[0];

    if (!nextTokenMatch) {
      const partialBeginIndex = findTrailingTokenPrefixStartAny(remaining, partialTokens);
      if (partialBeginIndex === -1) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialBeginIndex));
        incompleteText = remaining.slice(partialBeginIndex);
      }
      break;
    }

    appendText(remaining.slice(0, nextTokenMatch.index));
    remaining = remaining.slice(nextTokenMatch.index + nextTokenMatch.token.length);

    if (nextTokenMatch.kind === "strip") {
      continue;
    }

    if (nextTokenMatch.kind === "control") {
      const terminatorIndex = findControlTextTerminatorIndex(remaining);
      if (terminatorIndex === -1) {
        incompleteText = nextTokenMatch.token + remaining;
        break;
      }

      remaining = remaining.slice(terminatorIndex);
      continue;
    }

    if (nextTokenMatch.kind === "deepseek") {
      const endIndex = remaining.indexOf(deepSeekCallEndToken);
      if (endIndex === -1) {
        incompleteText = nextTokenMatch.token + remaining;
        break;
      }

      const callText = remaining.slice(0, endIndex);
      remaining = remaining.slice(endIndex + deepSeekCallEndToken.length);

      const parsedToolCallContent = parseDeepSeekTextEmbeddedToolCallContent(callText);

      if (parsedToolCallContent) {
        try {
          const parsedArgs = parsedToolCallContent.argsText
            ? JSON.parse(parsedToolCallContent.argsText)
            : {};
          segments.push({
            type: "toolCall",
            toolCall: { name: parsedToolCallContent.name, args: parsedArgs },
          });
          continue;
        } catch {
          segments.push({ type: "invalidToolCall", name: parsedToolCallContent.name });
          continue;
        }
      }

      appendText(`${nextTokenMatch.token}${callText}${deepSeekCallEndToken}`);
      continue;
    }

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
      segments.push({ type: "invalidToolCall", name });
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
  /** Cleared at the start of each VS Code resolution cycle (groupless call). */
  private readonly _selectableModelIdsInCycle = new Set<string>();
  private _infoCallCounter = 0;
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

  private async getAvailableModels(
    apiKey?: string,
    options: { refreshStaleCache?: boolean } = {},
  ): Promise<NormalizedNvidiaModel[]> {
    const cachedModels = this.getNormalizedModels();
    const cacheVersion = this.globalState?.get<number>(MODELS_CACHE_VERSION_STATE_KEY);
    if (
      cachedModels.length > 0 &&
      (cacheVersion === MODELS_CACHE_VERSION || !apiKey || !options.refreshStaleCache)
    ) {
      return cachedModels;
    }

    const refreshedModels = await this.fetchAvailableModels(apiKey);
    return refreshedModels ?? cachedModels;
  }

  private async fetchAvailableModels(
    configuredApiKey?: string,
  ): Promise<NormalizedNvidiaModel[] | undefined> {
    const apiKey = configuredApiKey ?? (await this.secrets.get(SECRET_STORAGE_KEY));
    if (!apiKey) {
      return undefined;
    }

    const rawModels = await fetchModels(apiKey, undefined, this.userAgent);
    if (!Array.isArray(rawModels)) {
      debugLog("modelPicker", "Unable to fetch models on demand.");
      return undefined;
    }

    const normalizedModels = normalizeNvidiaModels(rawModels);
    await this.globalState?.update(MODELS_STATE_KEY, normalizedModels);
    await this.globalState?.update(MODELS_CACHE_VERSION_STATE_KEY, MODELS_CACHE_VERSION);
    return normalizedModels;
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

  private calculateRequestedMaxTokens(options: {
    requestedMaxTokens: number;
    modelMaxOutputTokens: number;
    contextWindow: number;
    inputTokenCount: number;
  }): number {
    const availableCompletionTokens = Math.max(
      1,
      options.contextWindow - options.inputTokenCount - CONTEXT_WINDOW_SAFETY_MARGIN,
    );

    return Math.min(
      options.requestedMaxTokens,
      options.modelMaxOutputTokens,
      availableCompletionTokens,
    );
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
  ): Promise<NvidiaLanguageModelChatInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    const callNum = ++this._infoCallCounter;
    const groupName = getProviderGroupName(options);
    const hasProviderGroup = groupName !== undefined || hasProviderGroupConfiguration(options);
    const configuredApiKey = getApiKeyFromConfiguration(options);

    if (!hasProviderGroup) {
      outputLog(
        "resolution",
        `call #${callNum}: groupless - new resolution cycle, resetting duplicate guard`,
      );
      this._selectableModelIdsInCycle.clear();
      return [];
    }

    const legacyApiKey = configuredApiKey ? undefined : await this.secrets.get(SECRET_STORAGE_KEY);
    const apiKey = configuredApiKey ?? legacyApiKey;

    if (!apiKey) {
      const groupLabel = groupName ? ` "${groupName}"` : "";
      outputLog(
        "resolution",
        `call #${callNum}: provider group${groupLabel} has no configured or legacy API key`,
      );
      return [];
    }

    const models = await this.getAvailableModels(apiKey, { refreshStaleCache: true });
    const chatInformation = this._mapToChatInformation(models, apiKey);
    let duplicateCount = 0;
    for (const model of chatInformation) {
      if (this._selectableModelIdsInCycle.has(model.id)) {
        model.isUserSelectable = false;
        duplicateCount += 1;
        continue;
      }
      this._selectableModelIdsInCycle.add(model.id);
    }

    const keySource = configuredApiKey ? "configured API key" : "legacy API key fallback";
    const duplicateNote =
      duplicateCount > 0
        ? `; hid ${duplicateCount} duplicate picker entr${duplicateCount === 1 ? "y" : "ies"}`
        : "";
    const providerContext = groupName ? `provider group "${groupName}"` : "provider group";
    outputLog(
      "resolution",
      `call #${callNum}: returning ${models.length} models for ${providerContext} using ${keySource}${duplicateNote}`,
    );
    return chatInformation;
  }

  private _mapToChatInformation(
    models: readonly NormalizedNvidiaModel[],
    apiKey?: string,
  ): NvidiaLanguageModelChatInformation[] {
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
        isUserSelectable: true,
        capabilities: {
          toolCalling: info.supportsTools ? 128 : false,
          imageInput: info.supportsVision,
        },
        ...(apiKey ? { apiKey } : {}),
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
      const apiKey = await this.ensureApiKey(false, getApiKeyFromModel(model));
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

      const modelInfo = (await this.getAvailableModels(apiKey)).find(
        (entry) => entry.id === model.id,
      );
      const supportsTools = modelInfo?.supportsTools ?? false;
      const supportsVision = modelInfo?.supportsVision ?? false;
      const contextWindow =
        modelInfo?.contextWindow ?? model.maxInputTokens + model.maxOutputTokens;
      const maxTokensVal = (options.modelOptions as Record<string, unknown>)?.max_tokens;
      const requestedMaxTokens = this.calculateRequestedMaxTokens({
        requestedMaxTokens:
          typeof maxTokensVal === "number" && maxTokensVal > 0 ? maxTokensVal : DEFAULT_MAX_TOKENS,
        modelMaxOutputTokens: model.maxOutputTokens,
        contextWindow,
        inputTokenCount,
      });

      const hasImages = this.hasImageInput(messages);
      if (hasImages && !supportsVision) {
        progress.report(
          new vscode.LanguageModelTextPart(
            "The selected NVIDIA NIM model does not support image input.",
          ),
        );
        return;
      }

      const maxToolResultChars = this.calculateMaxToolResultChars(contextWindow);

      const toolConfig = supportsTools ? convertTools(options) : {};
      const toolsEnabled = Boolean(toolConfig.tools?.length);
      const requestProfile = getModelRequestProfile(model.id, {
        toolsEnabled,
      });
      const userTemperature = (options.modelOptions as Record<string, unknown>)?.temperature;
      const profileTemperature =
        toolsEnabled && requestProfile.toolTemperature !== undefined
          ? requestProfile.toolTemperature
          : requestProfile.defaultTemperature;
      const temperatureVal =
        typeof userTemperature === "number" ? userTemperature : profileTemperature;

      let apiMessages = convertMessages(messages, {
        maxToolResultChars,
        supportsVision,
      });
      apiMessages = applyReasoningContentWorkaround(apiMessages, model.id);
      if (requestProfile.extraSystemMessages.length > 0) {
        apiMessages = [
          ...requestProfile.extraSystemMessages.map(
            (content): OcGoChatMessage => ({ role: "system", content }),
          ),
          ...apiMessages,
        ];
      }

      const requestBody: OcGoChatRequest = {
        model: model.id,
        messages: apiMessages,
        stream: true,
        max_tokens: requestedMaxTokens,
        temperature: temperatureVal,
      };

      const modelOpts = options.modelOptions as Record<string, unknown>;
      if (typeof modelOpts?.top_p === "number") {
        requestBody.top_p = Math.min(1, Math.max(0, modelOpts.top_p));
      }
      if (typeof modelOpts?.frequency_penalty === "number") {
        requestBody.frequency_penalty = Math.min(2, Math.max(-2, modelOpts.frequency_penalty));
      }
      if (typeof modelOpts?.presence_penalty === "number") {
        requestBody.presence_penalty = Math.min(2, Math.max(-2, modelOpts.presence_penalty));
      }
      const stopVal = modelOpts?.stop;
      if (typeof stopVal === "string" || (Array.isArray(stopVal) && stopVal.length > 0)) {
        requestBody.stop = stopVal as string | string[];
      }

      if (toolConfig.tools) {
        requestBody.tools = toolConfig.tools;
      }
      if (toolConfig.tool_choice) {
        requestBody.tool_choice = toolConfig.tool_choice;
      }

      debugLog("Outgoing request messages", requestBody.messages);

      const toolSchemas = getToolSchemaMap(options);
      const requestContext = extractChatRequestContext(messages);
      const emittedTextToolCallKeys = getCompletedToolCallKeys(
        messages,
        requestContext,
        toolSchemas,
      );
      let activeRequestBody = requestBody;
      let deferredInvalidToolFallbackText: string | undefined;
      let retryReason: "invalid_tool_call" | undefined;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptStartedAtMs = Date.now();
        const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
        const completedToolCallIndices = new Set<number>();
        const skippedToolCalls: SkippedToolCall[] = [];
        let pendingTextEmbeddedContent = "";
        let pendingText = "";
        let sawToolCall = false;
        let emittedToolCall = false;
        let reportedContent = false;
        let firstResponseAtMs: number | undefined;
        let lastUsage:
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        const markFirstResponse = (): void => {
          if (firstResponseAtMs === undefined) {
            firstResponseAtMs = Date.now();
          }
        };
        const reportPart = (part: LanguageModelResponsePart): void => {
          progress.report(part);
          reportedContent = true;
        };
        const flushPendingText = (): void => {
          if (!pendingText) {
            return;
          }
          reportPart(new vscode.LanguageModelTextPart(pendingText));
          pendingText = "";
        };

        for await (const chunk of streamChatCompletion(
          apiKey,
          activeRequestBody,
          abortController.signal,
          this.userAgent,
        )) {
          if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
          }

          const choice = chunk.choices?.[0];

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

          if (choice?.delta?.content) {
            markFirstResponse();
            const { segments, incompleteText } = parseTextEmbeddedToolCalls(
              pendingTextEmbeddedContent + choice.delta.content,
            );
            pendingTextEmbeddedContent = incompleteText;

            for (const segment of segments) {
              if (segment.type === "text") {
                pendingText += segment.text;
                continue;
              }

              if (segment.type === "invalidToolCall") {
                sawToolCall = true;
                const schema = toolSchemas.get(segment.name);
                skippedToolCalls.push({
                  name: segment.name,
                  required: schema?.required ?? [],
                });
                debugLog("Skipped invalid text tool call", { name: segment.name });
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
                reportPart(
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
            markFirstResponse();
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
                  reportPart(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
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
              reportPart(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
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

        const fallbackText = sawToolCall
          ? buildInvalidToolCallFallback(skippedToolCalls)
          : undefined;
        const retryMessage = sawToolCall
          ? buildInvalidToolCallRetryMessage(skippedToolCalls)
          : undefined;
        const willRetryAfterInvalidToolCall =
          sawToolCall &&
          !emittedToolCall &&
          attempt === 0 &&
          !reportedContent &&
          Boolean(fallbackText && retryMessage);
        const currentRetryReason =
          retryReason ?? (willRetryAfterInvalidToolCall ? "invalid_tool_call" : undefined);

        if (firstResponseAtMs !== undefined) {
          const totalDurationMs = Date.now() - attemptStartedAtMs;
          const generationDurationMs = Math.max(
            0,
            totalDurationMs - (firstResponseAtMs - attemptStartedAtMs),
          );
          const promptTokens = lastUsage?.prompt_tokens;
          const completionTokens = lastUsage?.completion_tokens;
          const totalTokens = lastUsage?.total_tokens;
          debugLog("stream timing", {
            attempt: attempt + 1,
            model: model.id,
            inputTokenCount,
            requestedMaxTokens,
            temperature: temperatureVal,
            toolsEnabled,
            isRetryAttempt: attempt > 0,
            willRetryAfterInvalidToolCall,
            ...(currentRetryReason ? { retryReason: currentRetryReason } : {}),
            firstTokenLatencyMs: firstResponseAtMs - attemptStartedAtMs,
            totalDurationMs,
            generationDurationMs,
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {}),
            ...(completionTokens !== undefined && generationDurationMs > 0
              ? {
                  completionTokensPerSecond: Number(
                    (completionTokens / (generationDurationMs / 1000)).toFixed(2),
                  ),
                }
              : {}),
            reportedContent,
            emittedToolCall,
          });
        }

        if (lastUsage) {
          debugLog("stream usage", lastUsage);
        }

        if (sawToolCall && !emittedToolCall) {
          if (attempt === 0 && !reportedContent && fallbackText && retryMessage) {
            deferredInvalidToolFallbackText = fallbackText;
            retryReason = "invalid_tool_call";
            activeRequestBody = {
              ...activeRequestBody,
              messages: [
                ...activeRequestBody.messages,
                {
                  role: "system",
                  content: retryMessage,
                },
              ],
            };
            continue;
          }
          if (fallbackText) {
            reportPart(new vscode.LanguageModelTextPart(fallbackText));
          }
        }

        if (reportedContent || emittedToolCall) {
          deferredInvalidToolFallbackText = undefined;
        }
        break;
      }

      if (deferredInvalidToolFallbackText) {
        progress.report(new vscode.LanguageModelTextPart(deferredInvalidToolFallbackText));
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
      return Promise.resolve(estimateTokens(text));
    }
    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += estimateTokens(part.value);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "value" in part &&
        typeof (part as { value?: unknown }).value === "string"
      ) {
        total += estimateTokens((part as { value: string }).value);
      } else {
        total += 2; // rough estimate for non-text parts
      }
    }
    return Promise.resolve(total);
  }

  private async ensureApiKey(
    silent: boolean,
    configuredApiKey?: string,
  ): Promise<string | undefined> {
    let apiKey = configuredApiKey ?? (await this.secrets.get(SECRET_STORAGE_KEY));
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
