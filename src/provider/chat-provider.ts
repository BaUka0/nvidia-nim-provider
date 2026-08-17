import { randomUUID } from "node:crypto";

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
  getIncompleteTextToolCallName,
  hasRequiredToolArguments,
  parseTextEmbeddedToolCalls,
  repairToolArguments,
  SkippedToolCall,
} from "../tools/parser";
import { streamChatCompletion } from "../api/client";
import {
  calculateSafetyMargin,
  DEBUG_ENV_VAR,
  MANAGE_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { getFallbackModel } from "../models/catalog";
import { getModelAdapter, ModelAdapter } from "../models/adapters";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { StatusBarManager, TokenBreakdown } from "../shared/status-bar";
import {
  convertMessages,
  estimateNimMessagesTokens,
  estimateNimMessagesTokensByCategory,
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
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import { createStructuredError, NvidiaApiError, parseContextOverflowDetail } from "../api/errors";
import { NimRequestBuilder } from "./request-builder";
import { ToolCallStreamAggregator } from "./tool-call-aggregator";
import { splitMessagesForSummarization, summarizeOldMessages } from "../models/summarizer";
import { ContextLimitStore } from "./context-limit-store";

const DEFAULT_MAX_TOKENS = 65536;
const MAX_RUNTIME_INFO_CACHE_SIZE = 64;
/**
 * Total connection-attempt budget shared by every stream attempt of a single
 * response (initial tries, empty-stream/network retries, overflow retry).
 * Without this cap the nested retry layers could multiply into ~9+ requests
 * against an already rate-limited endpoint.
 */
const MAX_TOTAL_FETCH_ATTEMPTS = 6;

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
  private readonly apiKeyResolver: NvidiaApiKeyResolver;
  private readonly runtimeInfoCache = new Map<
    string,
    {
      supportsTools: boolean;
      supportsVision: boolean;
      contextWindow: number;
      runtimeMetadataSource: ChatRuntimeMetadataSource;
    }
  >();
  private readonly contextLimitStore = new ContextLimitStore();
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  /** Cleared at the start of each VS Code resolution cycle (groupless call). */
  private readonly _selectableModelIdsInCycle = new Set<string>();
  private readonly _resolutionKeyFingerprintsByGroup = new Map<string, string>();
  private _infoCallCounter = 0;
  private _apiKeyPrompt: Promise<string | undefined> | undefined;
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly globalState?: vscode.Memento,
    private readonly statusBar?: StatusBarManager,
    apiKeyResolver?: NvidiaApiKeyResolver,
  ) {
    this.apiKeyResolver = apiKeyResolver ?? new NvidiaApiKeyResolver(secrets);
    this.discoveryService = new NvidiaModelDiscoveryService(
      secrets,
      userAgent,
      globalState,
      this.apiKeyResolver,
    );
  }

  fireModelInfoChanged(options: { invalidateModelCache?: boolean } = {}): void {
    this.runtimeInfoCache.clear();
    this.contextLimitStore.clear();
    if (options.invalidateModelCache !== false) {
      this.apiKeyResolver.clearRuntimeBindings();
      this._resolutionKeyFingerprintsByGroup.clear();
      this.discoveryService.invalidateCache();
    } else {
      this.discoveryService.markCacheFresh();
    }
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
      this.runtimeInfoCache.delete(model.id);
      this.runtimeInfoCache.set(model.id, cachedRuntimeInfo);
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
      this.setRuntimeInfoCache(model.id, runtimeInfo);
      return runtimeInfo;
    }

    const providerModelInfo = model as LanguageModelChatInformation & {
      detail?: unknown;
      family?: unknown;
    };
    if (
      providerModelInfo.detail === PROVIDER_DISPLAY_NAME ||
      providerModelInfo.family === PROVIDER_VENDOR
    ) {
      const currentModels = await this.discoveryService.getAvailableModels(apiKey);
      const currentModel = currentModels.find((entry) => entry.id === model.id);
      if (currentModel) {
        const runtimeInfo = {
          supportsTools: currentModel.supportsTools,
          supportsVision: currentModel.supportsVision,
          contextWindow: currentModel.contextWindow,
          runtimeMetadataSource: "fetched-model" as const,
        };
        this.setRuntimeInfoCache(model.id, runtimeInfo);
        return runtimeInfo;
      }

      return {
        supportsTools: false,
        supportsVision: false,
        contextWindow: model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
        runtimeMetadataSource: "fetched-model" as const,
      };
    }

    const capabilities = (model as SelectedModelRuntimeCapabilities).capabilities;
    if (capabilities) {
      const runtimeInfo = {
        supportsTools: Boolean(capabilities.toolCalling),
        supportsVision: capabilities.imageInput === true,
        contextWindow: model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
        runtimeMetadataSource: "selected-model" as const,
      };
      this.setRuntimeInfoCache(model.id, runtimeInfo);
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
    this.setRuntimeInfoCache(model.id, runtimeInfo);
    return runtimeInfo;
  }

  private setRuntimeInfoCache(
    modelId: string,
    runtimeInfo: {
      supportsTools: boolean;
      supportsVision: boolean;
      contextWindow: number;
      runtimeMetadataSource: ChatRuntimeMetadataSource;
    },
  ): void {
    if (
      !this.runtimeInfoCache.has(modelId) &&
      this.runtimeInfoCache.size >= MAX_RUNTIME_INFO_CACHE_SIZE
    ) {
      const oldestKey = this.runtimeInfoCache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.runtimeInfoCache.delete(oldestKey);
      }
    }
    this.runtimeInfoCache.set(modelId, runtimeInfo);
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
      this.runtimeInfoCache.clear();
      this.apiKeyResolver.clearRuntimeBindings();
      this._resolutionKeyFingerprintsByGroup.clear();
      return [];
    }

    const resolvedApiKey = await this.apiKeyResolver.resolveConfiguredOrLegacy(configuredApiKey);
    if (!resolvedApiKey) {
      const groupLabel = groupName ? ` "${groupName}"` : "";
      const resolutionGroupKey = groupName ?? "<configured-provider-group>";
      this.runtimeInfoCache.clear();
      this.apiKeyResolver.clearRuntimeBindings(resolutionGroupKey);
      this._resolutionKeyFingerprintsByGroup.delete(resolutionGroupKey);
      this.discoveryService.invalidateCache();
      outputLog(
        "resolution",
        `call #${callNum}: provider group${groupLabel} has no configured or legacy API key`,
      );
      return [];
    }
    const apiKey = resolvedApiKey.value;

    const keyFingerprint = getApiKeyFingerprint(apiKey);
    const resolutionGroupKey = groupName ?? "<configured-provider-group>";
    const previousGroupFingerprint = this._resolutionKeyFingerprintsByGroup.get(resolutionGroupKey);
    const keyChanged =
      previousGroupFingerprint !== undefined && previousGroupFingerprint !== keyFingerprint;
    if (keyChanged) {
      this.runtimeInfoCache.clear();
      this.contextLimitStore.clear();
      this.apiKeyResolver.clearRuntimeBindings(resolutionGroupKey);
      this.discoveryService.invalidateCache();
      this._selectableModelIdsInCycle.clear();
    }
    this.apiKeyResolver.rememberRuntimeKey(apiKey, resolutionGroupKey);
    this._resolutionKeyFingerprintsByGroup.set(resolutionGroupKey, keyFingerprint);

    const models = await this.discoveryService.getAvailableModels(apiKey, {
      refreshStaleCache: true,
    });
    const chatInformation = this.discoveryService.mapToChatInformation(models);
    for (const model of chatInformation) {
      this.apiKeyResolver.registerModelKey(model, apiKey, resolutionGroupKey);
    }
    let duplicateCount = 0;
    for (const model of chatInformation) {
      if (this._selectableModelIdsInCycle.has(model.id)) {
        model.isUserSelectable = false;
        duplicateCount += 1;
        continue;
      }
      this._selectableModelIdsInCycle.add(model.id);
    }

    const keySource =
      resolvedApiKey.source === "configured" ? "configured API key" : "legacy API key fallback";
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
    let hasReportedContent = false;
    let hasReportedVisibleContent = false;
    let sawToolCallOverall = false;
    let hasRetriedContextOverflow = false;
    // Declared outside try so the catch-block context-overflow handler can access them.
    let apiKey: string | undefined;
    let keyFingerprint: string | undefined;
    let contextWindow = 0;
    let effectiveContextWindow = 0;
    let supportsVision = false;
    let adapter: ModelAdapter | undefined;
    let activeRequestBody: import("../types").NimChatRequest | undefined;
    let tools: import("../types").NimTool[] | undefined;
    let remainingFetchAttempts = MAX_TOTAL_FETCH_ATTEMPTS;
    const consumeFetchAttempts = (): number => {
      const attempts = Math.max(1, Math.min(3, remainingFetchAttempts));
      remainingFetchAttempts -= attempts;
      return attempts;
    };
    /**
     * Report a reasoning fragment as a thinking part when the runtime supports
     * it, otherwise fall back to plain text when showReasoning is enabled.
     * Returns what was emitted so the caller can mirror the original reportPart
     * flag semantics (the text fallback counts as visible content).
     */
    const reportThinkingPart = (text: string): { didReport: boolean; emittedVisible: boolean } => {
      type ThinkingPartConstructor = new (value: string) => LanguageModelResponsePart;
      const ThinkingPart = (
        vscode as unknown as { LanguageModelThinkingPart?: ThinkingPartConstructor }
      ).LanguageModelThinkingPart;
      if (ThinkingPart) {
        progress.report(new ThinkingPart(text));
        return { didReport: true, emittedVisible: false };
      }
      const showReasoning = vscode.workspace
        .getConfiguration("nvidia-nim")
        .get<boolean>("showReasoning", false);
      if (showReasoning) {
        progress.report(new vscode.LanguageModelTextPart(text.startsWith(" ") ? text : ` ${text}`));
        return { didReport: true, emittedVisible: true };
      }
      return { didReport: false, emittedVisible: false };
    };

    try {
      apiKey = await this.ensureApiKey(false, model);
      if (!apiKey) {
        progress.report(new vscode.LanguageModelTextPart(buildMissingApiKeyFallback()));
        return;
      }

      const requestPreparationStartedAtMs =
        process.env[DEBUG_ENV_VAR] === "1" ? Date.now() : undefined;

      const {
        supportsTools,
        supportsVision: visionSupport,
        contextWindow: cw,
        runtimeMetadataSource,
      } = await this.resolveChatModelRuntimeInfo(model, apiKey);
      contextWindow = cw;
      supportsVision = visionSupport;
      keyFingerprint = getApiKeyFingerprint(apiKey);
      const runtimeLimit = this.contextLimitStore.get(model.id, keyFingerprint);
      effectiveContextWindow =
        runtimeLimit !== undefined ? Math.min(contextWindow, runtimeLimit) : contextWindow;
      adapter = getModelAdapter(model.id);

      if (NimRequestBuilder.hasImageInput(messages) && !supportsVision) {
        progress.report(
          new vscode.LanguageModelTextPart(
            "The selected NVIDIA NIM model does not support image input.",
          ),
        );
        return;
      }

      const prepared = await NimRequestBuilder.prepareRequest({
        model,
        messages,
        options,
        contextWindow: effectiveContextWindow,
        supportsTools,
        supportsVision,
        apiKey,
        userAgent: this.userAgent,
        signal: abortController.signal,
      });

      activeRequestBody = prepared.requestBody;
      tools = prepared.tools;
      const {
        reasoningIsolationExpected,
        inputTokenCount,
        requestedMaxTokens,
        temperatureVal,
        toolsEnabled,
      } = prepared;

      const recalculateActiveRequestBudget = (): void => {
        const sentTools = activeRequestBody!.tools ?? tools;
        const payloadInputTokenCount =
          estimateNimMessagesTokens(activeRequestBody!.messages) +
          (sentTools ? estimateToolsTokens(sentTools) : 0);
        const maximumInputTokens = Math.max(
          1,
          effectiveContextWindow - calculateSafetyMargin(effectiveContextWindow),
        );
        if (payloadInputTokenCount > maximumInputTokens) {
          throw createStructuredError(
            "token_limit",
            `Retry payload exceeds context: ${payloadInputTokenCount} tokens, max: ${maximumInputTokens}`,
          );
        }

        const currentMaxTokens =
          typeof activeRequestBody!.max_tokens === "number" && activeRequestBody!.max_tokens > 0
            ? activeRequestBody!.max_tokens
            : requestedMaxTokens;
        activeRequestBody = {
          ...activeRequestBody!,
          max_tokens: NimRequestBuilder.calculateRequestedMaxTokens({
            requestedMaxTokens: currentMaxTokens,
            modelMaxOutputTokens: model.maxOutputTokens,
            contextWindow: effectiveContextWindow,
            inputTokenCount: payloadInputTokenCount,
          }),
        };
      };
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
      let emptyStreamRetryCount = 0;
      const MAX_EMPTY_STREAM_RETRIES = 2;
      let everSawReasoning = false;
      let lastFinishReasonOverall: string | null | undefined = undefined;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        totalAttempts += 1;
        finalUsage = undefined;
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
        let reportedVisibleContent = false;
        let sawReasoning = false;
        let lastFinishReason: string | null | undefined = undefined;
        let streamChunkCount = 0;
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
          hasReportedContent = true;
          if (
            part instanceof vscode.LanguageModelTextPart ||
            part instanceof vscode.LanguageModelToolCallPart
          ) {
            reportedVisibleContent = true;
            hasReportedVisibleContent = true;
          }
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
            sawReasoning = true;
            everSawReasoning = true;
            const thinkingResult = reportThinkingPart(text);
            if (thinkingResult.didReport) {
              reportedContent = true;
              hasReportedContent = true;
              if (thinkingResult.emittedVisible) {
                reportedVisibleContent = true;
                hasReportedVisibleContent = true;
              }
            }
          },
          onText: (text) => {
            processAnswerText(text);
            flushPendingText();
          },
          onFirstResponse: () => {
            markFirstResponse();
          },
        });

        const processFilteredText = (text: string): void => {
          if (!text) {
            return;
          }

          const parseEmbeddedToolCalls =
            adapter?.parseTextEmbeddedToolCalls ?? parseTextEmbeddedToolCalls;
          const { segments, incompleteText, extractedParams } = parseEmbeddedToolCalls(
            pendingTextEmbeddedContent + text,
          );
          pendingTextEmbeddedContent = incompleteText;
          if (extractedParams && Object.keys(extractedParams).length > 0) {
            getToolAggregator().recordExtractedParameters(extractedParams);
          }

          for (const segment of segments) {
            if (segment.type === "text") {
              pendingText += segment.text;
              continue;
            }

            if (segment.type === "invalidToolCall") {
              sawToolCall = true;
              sawToolCallOverall = true;
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
            sawToolCallOverall = true;
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
                  `text_tool_${randomUUID()}`,
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
            apiKey!,
            activeRequestBody!,
            abortController.signal,
            this.userAgent,
            {
              maxOutputTokens: model.maxOutputTokens,
              maxFetchAttempts: consumeFetchAttempts(),
            },
          )) {
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }

            const choice = chunk.choices?.[0];
            streamChunkCount += 1;
            if (choice?.finish_reason != null) {
              lastFinishReason = choice.finish_reason;
            }

            if (chunk.usage) {
              lastUsage = chunk.usage;
              finalUsage = chunk.usage;
            }

            const reasoningContent = (choice?.delta as { reasoning_content?: string })
              ?.reasoning_content;
            const rawContent = choice?.delta?.content;
            const content = rawContent
              ? (adapter?.sanitizeResponseText?.(rawContent) ?? rawContent)
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

            if (choice?.delta?.tool_calls) {
              markFirstResponse();
              sawToolCall = true;
              sawToolCallOverall = true;
              getToolAggregator().handleToolCalls(choice.delta.tool_calls);
            }
          }

          if (toolAggregator) {
            toolAggregator.flushRemaining();
          }
        } catch (streamErr) {
          if (
            token.isCancellationRequested ||
            abortController.signal.aborted ||
            (streamErr instanceof Error && streamErr.name === "AbortError")
          ) {
            throw new vscode.CancellationError();
          }

          const isNetworkError =
            (streamErr instanceof NvidiaApiError && streamErr.kind === "network_error") ||
            (streamErr instanceof Error &&
              (streamErr.name === "TypeError" ||
                streamErr.message.includes("fetch") ||
                streamErr.message.includes("network") ||
                streamErr.message.includes("ECONNRESET") ||
                streamErr.message.includes("socket")));

          if (
            !abortController.signal.aborted &&
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
              ...activeRequestBody!,
              messages: [
                ...activeRequestBody!.messages,
                {
                  // A trailing system message is rejected or mishandled by some
                  // OpenAI-compatible backends; a user turn is universally safe.
                  role: "user",
                  content:
                    "Your previous response was interrupted by a network error. Please start over and provide a complete response.",
                },
              ],
            };
            recalculateActiveRequestBudget();
            continue;
          }

          throw streamErr;
        }
        lastFinishReasonOverall = lastFinishReason;
        router.flush();

        const incompleteTextToolName = getIncompleteTextToolCallName(pendingTextEmbeddedContent);
        if (incompleteTextToolName) {
          sawToolCall = true;
          sawToolCallOverall = true;
          const schema = getToolAggregator().getToolSchemas().get(incompleteTextToolName);
          skippedToolCalls.push({
            name: incompleteTextToolName,
            required: schema?.required ?? [],
          });
          debugLog("Skipped truncated text tool call", { name: incompleteTextToolName });
        }
        pendingTextEmbeddedContent = "";

        if (pendingText) {
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
        const willRetryEmptyStream =
          !sawReasoning &&
          !sawToolCall &&
          !reportedVisibleContent &&
          !emittedToolCall &&
          emptyStreamRetryCount < MAX_EMPTY_STREAM_RETRIES &&
          attempt < 2;
        const currentRetryReason =
          retryReason ??
          (willRetryAfterInvalidToolCall
            ? "invalid_tool_call"
            : willRetryEmptyStream
              ? "empty_stream"
              : undefined);
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
            reportedVisibleContent,
            emittedToolCall,
            sawReasoning,
            lastFinishReason,
            streamChunkCount,
            willRetryEmptyStream,
            emptyStreamRetryCount,
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
              ...activeRequestBody!,
              messages: [
                ...activeRequestBody!.messages,
                {
                  role: "system",
                  content: retryMessage,
                },
              ],
            };
            recalculateActiveRequestBudget();
            continue;
          }
          if (fallbackText) {
            reportPart(new vscode.LanguageModelTextPart(fallbackText));
          }
        }

        if (reportedContent || emittedToolCall) {
          deferredInvalidToolFallbackText = undefined;
        }

        debugLog("stream finished", {
          attempt: attempt + 1,
          totalAttempts,
          model: model.id,
          reportedContent,
          reportedVisibleContent,
          emittedToolCall,
          sawToolCall,
          sawReasoning,
          lastFinishReason,
          streamChunkCount,
          willRetryAfterInvalidToolCall,
          willRetryEmptyStream,
          emptyStreamRetryCount,
        });

        if (willRetryEmptyStream) {
          emptyStreamRetryCount += 1;
          retryReasonHistory.push("empty_stream");
          debugLog(
            "emptyStreamRetry",
            `Empty stream (no text/tool/reasoning surfaced); retry ${emptyStreamRetryCount}/${MAX_EMPTY_STREAM_RETRIES}. lastFinishReason=${String(lastFinishReason)}, chunks=${streamChunkCount}`,
          );
          continue;
        }
        break;
      }

      if (deferredInvalidToolFallbackText) {
        progress.report(new vscode.LanguageModelTextPart(deferredInvalidToolFallbackText));
        hasReportedVisibleContent = true;
      }

      if (!hasReportedVisibleContent && !sawToolCallOverall && !deferredInvalidToolFallbackText) {
        throw createStructuredError(
          "empty_stream",
          [
            `Model: ${model.name ?? model.id}`,
            `Attempts: ${totalAttempts}`,
            everSawReasoning
              ? "The model emitted reasoning but no visible answer or tool call."
              : "The model returned no text, tool call, or reasoning.",
            lastFinishReasonOverall !== undefined
              ? `Last finish_reason: ${String(lastFinishReasonOverall)}`
              : null,
            "Try again, reduce reasoning effort, or switch to a different model.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (this.statusBar) {
        const shortName = model.name ?? model.id.split("/").at(-1) ?? model.id;
        const sentTools = activeRequestBody!.tools ?? tools;
        const categoryBreakdown = estimateNimMessagesTokensByCategory(activeRequestBody!.messages);
        const toolsTokens = sentTools ? estimateToolsTokens(sentTools) : 0;
        const breakdown: TokenBreakdown = {
          modelName: shortName,
          systemPrompt: categoryBreakdown.system,
          tools: toolsTokens,
          userMessages: categoryBreakdown.user,
          assistantMessages: categoryBreakdown.assistant,
          toolCalls: categoryBreakdown.toolCalls,
          toolResults: categoryBreakdown.toolResults,
          images: categoryBreakdown.images,
          actualPromptTokens: finalUsage?.prompt_tokens,
          actualCompletionTokens: finalUsage?.completion_tokens,
          output: finalUsage?.completion_tokens,
          contextWindow,
        };
        this.statusBar.showTokenBreakdown(breakdown);
      }
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }

      // Context overflow: server rejected prompt as too long.
      // Parse the reported limit, compact history once, and retry with a
      // smaller output reservation.  Only attempt when no content was emitted
      // yet and we haven't already retried for this reason.
      if (
        !hasReportedContent &&
        !hasRetriedContextOverflow &&
        err instanceof NvidiaApiError &&
        err.kind === "context_overflow" &&
        apiKey &&
        activeRequestBody
      ) {
        hasRetriedContextOverflow = true;
        const overflowInfo =
          err.contextOverflow ??
          (err.status === 400 ? parseContextOverflowDetail(err.message) : {});
        const reportedMax = overflowInfo.reportedMaximum;
        const actualUsage = overflowInfo.actualUsage;
        debugLog("contextOverflow", {
          model: model.id,
          reportedMax,
          actualUsage,
          catalogContextWindow: contextWindow,
        });

        if (
          typeof reportedMax === "number" &&
          reportedMax > 0 &&
          reportedMax < contextWindow &&
          keyFingerprint
        ) {
          this.contextLimitStore.set(model.id, reportedMax, keyFingerprint);
        }

        // Build a retry budget: use the server-reported limit if it is
        // explicitly trusted and smaller than the catalog value, otherwise
        // keep the catalog value and reduce output reservation aggressively.
        const retryContextWindow =
          typeof reportedMax === "number" && reportedMax > 0 && reportedMax < contextWindow
            ? reportedMax
            : contextWindow;
        const safetyMargin = calculateSafetyMargin(retryContextWindow);
        const compactedMaxOutput = Math.max(1024, Math.floor(retryContextWindow * 0.05));

        // Compact conversation history: summarise old turns, keep system +
        // current user turn + tool-call pairs.
        try {
          // Convert with the same options as the primary request so large
          // tool results are truncated and vision content is preserved.
          let apiMessages = convertMessages(Array.from(messages), {
            maxToolResultChars: NimRequestBuilder.calculateMaxToolResultChars(retryContextWindow),
            supportsVision,
          });
          if (adapter?.applyMessagesWorkaround) {
            apiMessages = adapter.applyMessagesWorkaround(apiMessages);
          }
          const maxRecentTokens = Math.floor(retryContextWindow * 0.4);
          const { oldMessages, recentMessages } = splitMessagesForSummarization(
            apiMessages,
            maxRecentTokens,
          );
          if (oldMessages.length > 0) {
            const summaryMessage = await summarizeOldMessages(
              oldMessages,
              apiKey,
              this.userAgent,
              abortController.signal,
            );
            const compactedMessages = [summaryMessage, ...recentMessages];
            const compactedTokenCount = estimateNimMessagesTokens(compactedMessages);
            const compactedMaxInput = Math.max(
              1,
              retryContextWindow - safetyMargin - compactedMaxOutput,
            );

            debugLog("contextOverflow", {
              action: "retryAfterCompaction",
              oldTurnCount: oldMessages.length,
              recentTurnCount: recentMessages.length,
              compactedTokens: compactedTokenCount,
              compactedMaxInput,
              compactedMaxOutput,
            });

            if (compactedTokenCount <= compactedMaxInput) {
              const retryRequestBody = {
                ...activeRequestBody,
                messages: compactedMessages,
                max_tokens: compactedMaxOutput,
              };
              vscode.window.showInformationMessage(
                `Context overflow on ${model.name ?? model.id}. Retrying with compacted history…`,
              );
              // Stream the retry directly — do not recurse into the full
              // provideLanguageModelChatResponse to avoid infinite loops.
              const retrySkippedToolCalls: SkippedToolCall[] = [];
              const retryToolAggregator = new ToolCallStreamAggregator({
                options,
                messages,
                onEmitToolCall: (id, name, args) => {
                  progress.report(new vscode.LanguageModelToolCallPart(id, name, args));
                  hasReportedContent = true;
                  hasReportedVisibleContent = true;
                },
                onSkipToolCall: (name, required) => {
                  retrySkippedToolCalls.push({ name, required });
                },
              });
              for await (const chunk of streamChatCompletion(
                apiKey,
                retryRequestBody,
                abortController.signal,
                this.userAgent,
                {
                  maxOutputTokens: compactedMaxOutput,
                  maxFetchAttempts: consumeFetchAttempts(),
                },
              )) {
                if (token.isCancellationRequested) {
                  throw new vscode.CancellationError();
                }
                const choice = chunk.choices?.[0];
                if (choice?.delta?.reasoning_content) {
                  const retryThinking = reportThinkingPart(choice.delta.reasoning_content);
                  if (retryThinking.didReport) {
                    hasReportedContent = true;
                    if (retryThinking.emittedVisible) {
                      hasReportedVisibleContent = true;
                    }
                  }
                }
                const rawContent = choice?.delta?.content;
                if (rawContent) {
                  const content = adapter?.sanitizeResponseText?.(rawContent) ?? rawContent;
                  progress.report(new vscode.LanguageModelTextPart(content));
                  hasReportedContent = true;
                  hasReportedVisibleContent = true;
                }
                if (choice?.delta?.tool_calls) {
                  retryToolAggregator.handleToolCalls(choice.delta.tool_calls);
                }
              }
              retryToolAggregator.flushRemaining();
              if (!hasReportedVisibleContent) {
                const retryFallbackText = buildInvalidToolCallFallback(retrySkippedToolCalls);
                if (retryFallbackText) {
                  progress.report(new vscode.LanguageModelTextPart(retryFallbackText));
                  hasReportedVisibleContent = true;
                } else {
                  throw createStructuredError(
                    "empty_stream",
                    `Compacted retry on ${model.name ?? model.id} produced no visible answer or tool call.`,
                  );
                }
              }
              return;
            }
          }
        } catch (compactErr) {
          if (compactErr instanceof Error && compactErr.name === "AbortError") {
            throw new vscode.CancellationError();
          }
          debugLog("contextOverflow", {
            action: "compactionFailed",
            error: compactErr instanceof Error ? compactErr.message : String(compactErr),
          });
        }

        // If we get here, compaction did not help — throw a clear message.
        throw createStructuredError(
          "context_overflow",
          [
            `Model: ${model.name ?? model.id}`,
            reportedMax !== undefined
              ? `Server-reported limit: ${reportedMax.toLocaleString()} tokens`
              : null,
            actualUsage !== undefined
              ? `Prompt used: ${actualUsage.toLocaleString()} tokens`
              : null,
            "Start a new chat, reduce attachments, or switch to a model with a larger context window.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (
        !hasReportedContent &&
        err instanceof NvidiaApiError &&
        (err.kind === "rate_limited" || err.kind === "model_unavailable")
      ) {
        const modelApiKey = (await this.apiKeyResolver.resolveForModel(model))?.value;
        const fallbackModel = getFallbackModel(
          model.id,
          await this.discoveryService.getAvailableModels(modelApiKey),
        );
        if (fallbackModel) {
          const fallbackInfo: LanguageModelChatInformation = {
            ...model,
            id: fallbackModel.id,
            name: fallbackModel.displayName,
            maxInputTokens: Math.max(
              1,
              fallbackModel.contextWindow -
                Math.min(fallbackModel.maxOutputTokens, DEFAULT_MAX_TOKENS) -
                calculateSafetyMargin(fallbackModel.contextWindow),
            ),
            maxOutputTokens: fallbackModel.maxOutputTokens,
            capabilities: {
              toolCalling: fallbackModel.supportsTools ? 128 : false,
              imageInput: fallbackModel.supportsVision,
            },
          };
          const currentName = model.name ?? model.id;
          const capacityLabel =
            err.kind === "model_unavailable"
              ? "Model unavailable"
              : err.status === 529
                ? "Overloaded"
                : "Rate limited";
          vscode.window.showInformationMessage(
            `${capacityLabel} on ${currentName}. Falling back to ${fallbackModel.displayName}.`,
          );
          outputLog(
            "fallback",
            `${capacityLabel} on ${model.id}, falling back to ${fallbackModel.id}.`,
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
    model: LanguageModelChatInformation,
  ): Promise<string | undefined> {
    const resolved = await this.apiKeyResolver.resolveForModel(model);
    if (resolved) {
      return resolved.value;
    }
    if (silent) {
      return undefined;
    }

    if (this._apiKeyPrompt) {
      const promptedKey = await this._apiKeyPrompt;
      if (promptedKey) {
        this.apiKeyResolver.registerModelKey(model, promptedKey);
      }
      return promptedKey;
    }

    this._apiKeyPrompt = this.promptForApiKey();
    try {
      const promptedKey = await this._apiKeyPrompt;
      if (promptedKey) {
        this.apiKeyResolver.registerModelKey(model, promptedKey);
      }
      return promptedKey;
    } finally {
      this._apiKeyPrompt = undefined;
    }
  }

  private async promptForApiKey(): Promise<string | undefined> {
    const configureAction = "Configure API Key";
    const result = await vscode.window.showInformationMessage(
      `${PROVIDER_DISPLAY_NAME} API key is not configured.`,
      configureAction,
    );
    if (result === configureAction) {
      await vscode.commands.executeCommand(MANAGE_COMMAND_ID);
      const apiKey = await this.apiKeyResolver.resolveLegacy();
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
      const apiKey = entered.trim();
      await this.secrets.store(SECRET_STORAGE_KEY, apiKey);
      this.apiKeyResolver.rememberRuntimeKey(apiKey);
      return apiKey;
    }
    return undefined;
  }
}
