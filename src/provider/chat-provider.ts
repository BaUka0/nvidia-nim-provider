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
import {
  buildInvalidToolCallFallback,
  buildInvalidToolCallRetryMessage,
  buildToolCallCanonicalKey,
  hasRequiredToolArguments,
  parseTextEmbeddedToolCalls,
  repairToolArguments,
  SkippedToolCall,
} from "../tools/parser";
import { streamChatCompletion } from "../api/client";
import {
  DEBUG_ENV_VAR,
  MANAGE_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { getFallbackModel } from "../models/catalog";
import { getModelAdapter } from "../models/adapters";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { StatusBarManager, TokenBreakdown } from "../shared/status-bar";
import {
  estimateMessagesTokensByCategory,
  estimateToolsTokens,
  estimateMessageTokens,
  estimateTokens,
  LegacyPart,
} from "../messages/converter";
import { ReasoningStreamRouter } from "../messages/reasoning-router";
import {
  NvidiaModelDiscoveryService,
  NvidiaLanguageModelChatInformation,
} from "../models/discovery";
import { NimRequestBuilder } from "./request-builder";
import { ToolCallStreamAggregator } from "./tool-call-aggregator";

const DEFAULT_MAX_TOKENS = 65536;

interface NvidiaProviderConfiguration {
  apiKey?: string;
  reasoningMode?: string;
}

type SelectedModelRuntimeCapabilities = LanguageModelChatInformation & {
  capabilities?: {
    toolCalling?: unknown;
    imageInput?: unknown;
  };
};

type ChatRuntimeMetadataSource = "cache" | "selected-model" | "fetched-model";

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

function buildMissingApiKeyFallback(): string {
  return `${PROVIDER_DISPLAY_NAME} API key is not configured. Run "${PROVIDER_DISPLAY_NAME}: Manage ${PROVIDER_DISPLAY_NAME} API Key" from the Command Palette, or retry this request and enter the key when prompted.`;
}

export class NimChatModelProvider implements LanguageModelChatProvider {
  private readonly discoveryService: NvidiaModelDiscoveryService;
  private readonly runtimeInfoCache = new Map<
    string,
    {
      supportsTools: boolean;
      supportsVision: boolean;
      contextWindow: number;
      runtimeMetadataSource: ChatRuntimeMetadataSource;
    }
  >();
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
    private readonly statusBar?: StatusBarManager,
  ) {
    this.discoveryService = new NvidiaModelDiscoveryService(secrets, userAgent, globalState);
  }

  fireModelInfoChanged(): void {
    this.runtimeInfoCache.clear();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  private async resolveChatModelRuntimeInfo(
    model: LanguageModelChatInformation,
    apiKey?: string,
  ): Promise<{
    supportsTools: boolean;
    supportsVision: boolean;
    contextWindow: number;
    runtimeMetadataSource: ChatRuntimeMetadataSource;
  }> {
    const cachedRuntimeInfo = this.runtimeInfoCache.get(model.id);
    if (cachedRuntimeInfo) {
      return cachedRuntimeInfo;
    }

    const cachedModel = this.discoveryService
      .getNormalizedModels()
      .find((entry) => entry.id === model.id);
    if (cachedModel) {
      const runtimeInfo = {
        supportsTools: cachedModel.supportsTools,
        supportsVision: cachedModel.supportsVision,
        contextWindow: cachedModel.contextWindow,
        runtimeMetadataSource: "cache" as const,
      };
      this.runtimeInfoCache.set(model.id, runtimeInfo);
      return runtimeInfo;
    }

    const capabilities = (model as SelectedModelRuntimeCapabilities).capabilities;
    if (capabilities) {
      const runtimeInfo = {
        supportsTools: Boolean(capabilities.toolCalling),
        supportsVision: capabilities.imageInput === true,
        contextWindow: model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
        runtimeMetadataSource: "selected-model" as const,
      };
      this.runtimeInfoCache.set(model.id, runtimeInfo);
      return runtimeInfo;
    }

    const fetchedModel = (await this.discoveryService.getAvailableModels(apiKey)).find(
      (entry) => entry.id === model.id,
    );
    const runtimeInfo = {
      supportsTools: fetchedModel?.supportsTools ?? false,
      supportsVision: fetchedModel?.supportsVision ?? false,
      contextWindow:
        fetchedModel?.contextWindow ??
        model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
      runtimeMetadataSource: "fetched-model" as const,
    };
    this.runtimeInfoCache.set(model.id, runtimeInfo);
    return runtimeInfo;
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

    const models = await this.discoveryService.getAvailableModels(apiKey, {
      refreshStaleCache: true,
    });
    const chatInformation = this.discoveryService.mapToChatInformation(models, apiKey);
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

      const requestPreparationStartedAtMs =
        process.env[DEBUG_ENV_VAR] === "1" ? Date.now() : undefined;

      const { supportsTools, supportsVision, contextWindow, runtimeMetadataSource } =
        await this.resolveChatModelRuntimeInfo(model, apiKey);
      const adapter = getModelAdapter(model.id);

      if (NimRequestBuilder.hasImageInput(messages) && !supportsVision) {
        progress.report(
          new vscode.LanguageModelTextPart(
            "The selected NVIDIA NIM model does not support image input.",
          ),
        );
        return;
      }

      const {
        requestBody,
        reasoningIsolationExpected,
        inputTokenCount,
        requestedMaxTokens,
        temperatureVal,
        toolsEnabled,
        extraSystemMessages,
        tools,
      } = await NimRequestBuilder.prepareRequest({
        model,
        messages,
        options,
        contextWindow,
        supportsTools,
        supportsVision,
        apiKey,
        userAgent: this.userAgent,
        signal: abortController.signal,
      });

      let activeRequestBody = requestBody;
      let deferredInvalidToolFallbackText: string | undefined;
      let retryReason: "invalid_tool_call" | undefined;
      const retryReasonHistory: string[] = [];
      let totalAttempts = 0;
      let requestPreparationDurationMs: number | undefined;
      let toolParsingStateInitDurationMs: number | undefined;
      let finalUsage:
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        | undefined;
      let networkRetryCount = 0;
      const MAX_NETWORK_RETRIES = 2;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        totalAttempts += 1;
        const attemptStartedAtMs = Date.now();
        if (
          requestPreparationDurationMs === undefined &&
          requestPreparationStartedAtMs !== undefined
        ) {
          requestPreparationDurationMs = attemptStartedAtMs - requestPreparationStartedAtMs;
        }

        const skippedToolCalls: SkippedToolCall[] = [];
        let pendingTextEmbeddedContent = "";
        let pendingText = "";
        let sawToolCall = false;
        let emittedToolCall = false;
        let reportedContent = false;
        let firstResponseAtMs: number | undefined;
        let firstToolCallAtMs: number | undefined;
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

        let toolAggregator: ToolCallStreamAggregator | undefined;
        const getToolAggregator = (): ToolCallStreamAggregator => {
          if (toolAggregator) {
            return toolAggregator;
          }
          const toolParsingStateStartedAtMs =
            process.env[DEBUG_ENV_VAR] === "1" ? Date.now() : undefined;

          toolAggregator = new ToolCallStreamAggregator({
            options,
            messages,
            onEmitToolCall: (id, name, args) => {
              flushPendingText();
              reportPart(new vscode.LanguageModelToolCallPart(id, name, args));
              emittedToolCall = true;
              if (firstToolCallAtMs === undefined) {
                firstToolCallAtMs = Date.now();
              }
            },
            onSkipToolCall: (name, required) => {
              skippedToolCalls.push({ name, required });
            },
          });

          if (toolParsingStateStartedAtMs !== undefined) {
            toolParsingStateInitDurationMs = Date.now() - toolParsingStateStartedAtMs;
          }
          return toolAggregator;
        };

        const router = new ReasoningStreamRouter({
          reasoningIsolationExpected,
          onThinking: (text) => {
            const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
            if (ThinkingPart) {
              reportPart(new ThinkingPart(text));
            } else {
              const showReasoning = vscode.workspace
                .getConfiguration("nvidia-nim")
                .get<boolean>("showReasoning", false);
              if (showReasoning) {
                reportPart(
                  new vscode.LanguageModelTextPart(text.startsWith(" ") ? text : ` ${text}`),
                );
              }
            }
          },
          onText: (text) => {
            processAnswerText(text);
          },
          onFirstResponse: () => {
            markFirstResponse();
          },
        });

        const processFilteredText = (text: string): void => {
          if (!text) {
            return;
          }

          const { segments, incompleteText } = parseTextEmbeddedToolCalls(
            pendingTextEmbeddedContent + text,
          );
          pendingTextEmbeddedContent = incompleteText;

          for (const segment of segments) {
            if (segment.type === "text") {
              pendingText += segment.text;
              continue;
            }

            if (segment.type === "invalidToolCall") {
              sawToolCall = true;
              const schema = getToolAggregator().getToolSchemas().get(segment.name);
              skippedToolCalls.push({
                name: segment.name,
                required: schema?.required ?? [],
              });
              debugLog("Skipped invalid text tool call", { name: segment.name });
              continue;
            }

            const toolCall = segment.toolCall;
            sawToolCall = true;
            const schema = getToolAggregator().getToolSchemas().get(toolCall.name);
            const repairedArgs = repairToolArguments(
              toolCall.name,
              toolCall.args,
              getToolAggregator().getRequestContext(),
              schema,
            );
            const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
            if (getToolAggregator().getEmittedTextToolCallKeys().has(canonicalKey)) {
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
              if (firstToolCallAtMs === undefined) {
                firstToolCallAtMs = Date.now();
              }
              getToolAggregator().getEmittedTextToolCallKeys().add(canonicalKey);
            } else {
              skippedToolCalls.push({
                name: toolCall.name,
                required: schema?.required ?? [],
              });
              debugLog("Skipped invalid text tool call", toolCall);
            }
          }
        };
        const processAnswerText = (text: string): void => {
          if (!text) {
            return;
          }
          markFirstResponse();
          processFilteredText(text);
        };

        try {
          for await (const chunk of streamChatCompletion(
            apiKey,
            activeRequestBody,
            abortController.signal,
            this.userAgent,
            { maxOutputTokens: model.maxOutputTokens },
          )) {
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }

            const choice = chunk.choices?.[0];

            if (chunk.usage) {
              lastUsage = chunk.usage;
              finalUsage = chunk.usage;
            }

            const reasoningContent = (choice?.delta as { reasoning_content?: string })
              ?.reasoning_content;
            const rawContent = choice?.delta?.content;
            const content = rawContent
              ? (adapter.sanitizeResponseText?.(rawContent) ?? rawContent)
              : rawContent;

            if (debugEnabled()) {
              debugLog("stream chunk", {
                rc: Boolean(reasoningContent),
                rcTail: reasoningContent?.slice(-32),
                content: Boolean(content),
                contentHead: content?.slice(0, 64),
                contentTail: content?.slice(-32),
                finish: choice?.finish_reason ?? null,
              });
            }

            if (reasoningContent) {
              router.handleReasoningContent(reasoningContent);
            }

            if (content) {
              router.handleContent(content);
              if (!reasoningIsolationExpected || router.isAnswerStarted()) {
                flushPendingText();
              }
            }

            // Handle tool calls
            if (choice?.delta?.tool_calls) {
              markFirstResponse();
              sawToolCall = true;
              getToolAggregator().handleToolCalls(choice.delta.tool_calls);
            }
          }

          // Flush any remaining buffered tool calls at stream end
          if (toolAggregator) {
            toolAggregator.flushRemaining();
          }
        } catch (streamErr) {
          if (
            token.isCancellationRequested ||
            (streamErr instanceof Error && streamErr.name === "AbortError")
          ) {
            throw new vscode.CancellationError();
          }

          const isNetworkError =
            streamErr instanceof Error &&
            (streamErr.name === "TypeError" ||
              streamErr.message.includes("fetch") ||
              streamErr.message.includes("network") ||
              streamErr.message.includes("ECONNRESET") ||
              streamErr.message.includes("socket"));

          if (
            isNetworkError &&
            !reportedContent &&
            networkRetryCount < MAX_NETWORK_RETRIES &&
            attempt < 2
          ) {
            networkRetryCount += 1;
            debugLog(
              "streamRetry",
              `Network error during stream (retry ${networkRetryCount}/${MAX_NETWORK_RETRIES}): ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            );
            activeRequestBody = {
              ...activeRequestBody,
              messages: [
                ...activeRequestBody.messages,
                {
                  role: "system",
                  content:
                    "Your previous response was interrupted by a network error. Please start over and provide a complete response.",
                },
              ],
            };
            continue;
          }

          throw streamErr;
        }
        router.flush();

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
        const skippedToolCallNames = Array.from(new Set(skippedToolCalls.map((call) => call.name)));

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
            totalAttempts,
            ...(requestPreparationDurationMs !== undefined ? { requestPreparationDurationMs } : {}),
            ...(toolParsingStateInitDurationMs !== undefined
              ? { toolParsingStateInitDurationMs }
              : {}),
            ...(retryReasonHistory.length > 0
              ? { retryReasonHistory: [...retryReasonHistory] }
              : {}),
            model: model.id,
            inputTokenCount,
            requestedMaxTokens,
            temperature: temperatureVal,
            toolsEnabled,
            runtimeMetadataSource,
            isRetryAttempt: attempt > 0,
            willRetryAfterInvalidToolCall,
            skippedToolCallCount: skippedToolCalls.length,
            ...(skippedToolCallNames.length > 0 ? { skippedToolCallNames } : {}),
            ...(currentRetryReason ? { retryReason: currentRetryReason } : {}),
            firstTokenLatencyMs: firstResponseAtMs - attemptStartedAtMs,
            ...(firstToolCallAtMs !== undefined
              ? { firstToolCallLatencyMs: firstToolCallAtMs - attemptStartedAtMs }
              : {}),
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
            retryReasonHistory.push("invalid_tool_call");
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

      if (this.statusBar) {
        const shortName = model.name ?? model.id.split("/").at(-1) ?? model.id;
        const categoryBreakdown = estimateMessagesTokensByCategory(
          messages as readonly {
            role: number;
            content: (vscode.LanguageModelInputPart | LegacyPart)[];
          }[],
        );
        const extraSystemTokens = extraSystemMessages.reduce(
          (sum, content) => sum + estimateTokens(content),
          0,
        );
        const toolsTokens = tools ? estimateToolsTokens(tools) : 0;
        const breakdown: TokenBreakdown = {
          modelName: shortName,
          systemPrompt: categoryBreakdown.system + extraSystemTokens,
          tools: toolsTokens,
          userMessages: categoryBreakdown.user,
          assistantMessages: categoryBreakdown.assistant,
          toolCalls: categoryBreakdown.toolCalls,
          toolResults: categoryBreakdown.toolResults,
          images: categoryBreakdown.images,
          actualPromptTokens: finalUsage?.prompt_tokens,
          output: finalUsage?.completion_tokens ?? 0,
          contextWindow,
        };
        this.statusBar.showTokenBreakdown(breakdown);
      }
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }

      if (err instanceof Error && err.message.includes("[RATE_LIMITED]")) {
        const fallbackModel = getFallbackModel(
          model.id,
          await this.discoveryService.getAvailableModels(getApiKeyFromModel(model)),
        );
        if (fallbackModel) {
          const fallbackInfo: LanguageModelChatInformation = {
            ...model,
            id: fallbackModel.id,
            name: fallbackModel.displayName,
            maxInputTokens: Math.max(
              1,
              fallbackModel.contextWindow -
                Math.min(fallbackModel.maxOutputTokens, DEFAULT_MAX_TOKENS),
            ),
            maxOutputTokens: fallbackModel.maxOutputTokens,
            capabilities: {
              toolCalling: fallbackModel.supportsTools ? 128 : false,
              imageInput: fallbackModel.supportsVision,
            },
          };
          const currentName = model.name ?? model.id;
          vscode.window.showInformationMessage(
            `Rate limited on ${currentName}. Falling back to ${fallbackModel.displayName}.`,
          );
          outputLog(
            "fallback",
            `Rate limited on ${model.id}, falling back to ${fallbackModel.id}.`,
          );
          await this.provideLanguageModelChatResponse(
            fallbackInfo,
            messages,
            options,
            progress,
            token,
          );
          return;
        }
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
    try {
      if (typeof text === "string") {
        return Promise.resolve(estimateTokens(text));
      }
      return Promise.resolve(
        estimateMessageTokens(
          text as unknown as { content: (vscode.LanguageModelInputPart | LegacyPart)[] },
        ),
      );
    } catch {
      // Never reject: a thrown token counter would hang VS Code's breakdown UI.
      return Promise.resolve(0);
    }
  }

  private async ensureApiKey(
    silent: boolean,
    configuredApiKey?: string,
  ): Promise<string | undefined> {
    let apiKey = configuredApiKey ?? (await this.secrets.get(SECRET_STORAGE_KEY));
    if (!apiKey && !silent) {
      const configureAction = "Configure API Key";
      const result = await vscode.window.showInformationMessage(
        `${PROVIDER_DISPLAY_NAME} API key is not configured.`,
        configureAction,
      );
      if (result === configureAction) {
        await vscode.commands.executeCommand(MANAGE_COMMAND_ID);
        apiKey = await this.secrets.get(SECRET_STORAGE_KEY);
        if (!apiKey) {
          return undefined;
        }
        return apiKey;
      }

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
