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
import { buildInvalidToolCallFallback, buildInvalidToolCallRetryMessage } from "../tools/parser";
import { ConfigManager } from "../shared/config";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MANAGE_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { BoundedMap } from "../shared/bounded-map";
import { FetchAttemptBudget, httpAttemptsFromConfig } from "../shared/fetch-attempt-budget";
import { isLikelyNvidiaApiKey } from "../shared/api-key-format";
import { getFallbackModel } from "../models/catalog";
import { getModelAdapter } from "../models/adapters";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { StatusBarManager, TokenBreakdown } from "../shared/status-bar";
import {
  estimateNimMessagesTokensByCategory,
  estimateToolsTokens,
  estimateMessageTokens,
  estimateTokens,
  LegacyPart,
} from "../messages/converter";
import {
  NvidiaModelDiscoveryService,
  NvidiaLanguageModelChatInformation,
} from "../models/discovery";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import { createStructuredError, NvidiaApiError, parseContextOverflowDetail } from "../api/errors";
import { NimRequestBuilder } from "./request-builder";
import { ContextLimitStore } from "./context-limit-store";
import {
  FallbackChainOptions,
  buildFallbackModelInfo,
  isFallbackEligibleError,
  readFallbackDepth,
  readFetchAttemptBudget,
  readTriedFallbackModelIds,
  reportFallbackHop,
} from "./fallback-orchestrator";
import { injectHistoryLoopBreaker, LOOP_BREAKER_MARKER } from "./loop-breaker";
import { buildOverflowRetryRequest, notifyOverflowRetry } from "./overflow-compactor";
import { appendChatMessage, cloneNimChatRequest } from "./request-snapshot";
import {
  CONTENT_FILTER_NOTICE,
  NimStreamUsage,
  OUTPUT_TRUNCATED_NOTICE,
  REPETITION_STOP_NOTICE,
  runStreamAttempt,
  StreamAttemptResult,
} from "./stream-pump";
import { NimChatMessage, NimChatRequest } from "../types";

const MAX_RUNTIME_INFO_CACHE_SIZE = 64;

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

function toHostChatError(err: unknown): Error {
  if (!(err instanceof NvidiaApiError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const hostError = vscode.LanguageModelError as
    | {
        NoPermissions?: (message: string) => Error;
        NotFound?: (message: string) => Error;
      }
    | undefined;
  if (err.kind === "auth_failed" && typeof hostError?.NoPermissions === "function") {
    return hostError.NoPermissions(err.message);
  }
  if (err.kind === "model_unavailable" && typeof hostError?.NotFound === "function") {
    return hostError.NotFound(err.message);
  }
  return err;
}

/**
 * Wraps real stream usage into a Copilot-compatible data part.
 * Copilot Chat's extension-contributed endpoint wrapper scans streamed
 * LanguageModelDataPart chunks for the OpenAI usage shape
 * ({prompt_tokens, completion_tokens, total_tokens}) and feeds them into the
 * chat context-window widget; without this part the widget renders 0% forever.
 */
function createUsageDataPart(
  usage: NimStreamUsage | undefined,
): vscode.LanguageModelDataPart | undefined {
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  if (
    typeof promptTokens !== "number" &&
    typeof completionTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  if (typeof vscode.LanguageModelDataPart?.json !== "function") {
    return undefined;
  }
  const payload = {
    ...(typeof promptTokens === "number" ? { prompt_tokens: promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completion_tokens: completionTokens } : {}),
    ...(typeof totalTokens === "number" ? { total_tokens: totalTokens } : {}),
  };
  try {
    return vscode.LanguageModelDataPart.json(payload, "usage");
  } catch {
    return undefined;
  }
}

export class NimChatModelProvider implements LanguageModelChatProvider {
  private readonly discoveryService: NvidiaModelDiscoveryService;
  private readonly apiKeyResolver: NvidiaApiKeyResolver;
  private readonly runtimeInfoCache = new BoundedMap<
    string,
    {
      supportsTools: boolean;
      supportsVision: boolean;
      contextWindow: number;
      runtimeMetadataSource: ChatRuntimeMetadataSource;
    }
  >(MAX_RUNTIME_INFO_CACHE_SIZE);
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
        contextWindow:
          model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
        runtimeMetadataSource: "fetched-model" as const,
      };
    }

    const capabilities = (model as SelectedModelRuntimeCapabilities).capabilities;
    if (capabilities) {
      const runtimeInfo = {
        supportsTools: Boolean(capabilities.toolCalling),
        supportsVision: capabilities.imageInput === true,
        contextWindow:
          model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
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
        model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
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
      debugLog(
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
    if (token.isCancellationRequested) {
      return [];
    }
    if (!resolvedApiKey) {
      const groupLabel = groupName ? ` "${groupName}"` : "";
      const resolutionGroupKey = groupName ?? "<configured-provider-group>";
      this.runtimeInfoCache.clear();
      this.apiKeyResolver.clearRuntimeBindings(resolutionGroupKey);
      this._resolutionKeyFingerprintsByGroup.delete(resolutionGroupKey);
      this.discoveryService.invalidateCache();
      debugLog(
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
    if (token.isCancellationRequested) {
      return [];
    }
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
    debugLog(
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

    const fetchBudget = readFetchAttemptBudget(options) ?? new FetchAttemptBudget();
    let currentModel = model;
    let currentOptions: ProvideLanguageModelChatResponseOptions & FallbackChainOptions = {
      ...options,
      fetchAttemptBudget: fetchBudget,
      fallbackDepth: readFallbackDepth(options),
      triedFallbackModelIds: readTriedFallbackModelIds(options),
    };
    const reportState = { hasReportedContent: false, hasReportedVisibleContent: false };

    try {
      while (true) {
        try {
          await this.executeModelTurn(
            currentModel,
            messages,
            currentOptions,
            progress,
            token,
            abortController,
            fetchBudget,
            reportState,
          );
          return;
        } catch (err) {
          if (
            token.isCancellationRequested ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            throw new vscode.CancellationError();
          }

          const fallbackConfig = ConfigManager.getFallbackConfig();
          const priorDepth = currentOptions.fallbackDepth ?? 0;
          if (fetchBudget.exhausted) {
            throw toHostChatError(err);
          }
          if (
            !isFallbackEligibleError(
              err,
              fallbackConfig,
              priorDepth,
              reportState.hasReportedVisibleContent,
            )
          ) {
            throw toHostChatError(err);
          }

          const modelApiKey = (await this.apiKeyResolver.resolveForModel(currentModel))?.value;
          const hasImages = NimRequestBuilder.hasImageInput(messages);
          const triedFallbackModelIds = currentOptions.triedFallbackModelIds ?? [];
          const fallbackModel = getFallbackModel(
            currentModel.id,
            await this.discoveryService.getAvailableModels(modelApiKey),
            {
              configuredFallbackModelId: fallbackConfig.model,
              configuredVisionFallbackModelId: fallbackConfig.visionModel,
              requiresVision: hasImages,
              priorityList: fallbackConfig.priorityList,
              triedModelIds: triedFallbackModelIds,
            },
          );

          if (!fallbackModel) {
            if (priorDepth > 0) {
              throw toHostChatError(
                createStructuredError(
                  err instanceof NvidiaApiError ? err.kind : "rate_limited",
                  [
                    `All NVIDIA NIM failover candidates failed after ${priorDepth} step(s).`,
                    `Tried chain: ${[...triedFallbackModelIds, currentModel.id].join(" -> ")}`,
                    `Last error (${err instanceof NvidiaApiError ? err.kind : "unknown"}): ${err instanceof Error ? err.message : String(err)}`,
                    "Adjust nvidia-nim.fallback.priorityList or pick another model in the picker.",
                  ].join("\n"),
                ),
              );
            }
            throw toHostChatError(err);
          }

          reportFallbackHop({
            err,
            currentModel,
            fallbackModel,
            fallbackConfig,
            progress,
          });

          currentOptions = {
            ...currentOptions,
            fallbackDepth: priorDepth + 1,
            triedFallbackModelIds: [...triedFallbackModelIds, currentModel.id],
            fetchAttemptBudget: fetchBudget,
          };
          currentModel = buildFallbackModelInfo(currentModel, fallbackModel);
          if (modelApiKey) {
            this.apiKeyResolver.registerModelKey(currentModel, modelApiKey);
          }
        }
      }
    } finally {
      cancellationSubscription.dispose();
    }
  }

  /**
   * Run a single model turn: prepare the request, stream with bounded retries,
   * and compact once on context overflow. Fallback hops are handled by the
   * iterative loop in {@link provideLanguageModelChatResponse}.
   */
  private async executeModelTurn(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
    abortController: AbortController,
    fetchBudget: FetchAttemptBudget,
    reportState: { hasReportedContent: boolean; hasReportedVisibleContent: boolean },
  ): Promise<void> {
    let hasReportedContent = false;
    let hasReportedVisibleContent = false;
    let sawToolCallOverall = false;
    let apiKey: string | undefined;
    let keyFingerprint: string | undefined;
    let contextWindow = 0;
    let effectiveContextWindow = 0;
    let supportsVision = false;
    let activeRequestBody: NimChatRequest | undefined;
    let tools: import("../types").NimTool[] | undefined;
    let hasRetriedContextOverflow = false;
    let reasoningIsolationExpected = false;

    const markReported = (result: StreamAttemptResult): void => {
      if (result.reportedContent) {
        hasReportedContent = true;
        reportState.hasReportedContent = true;
      }
      if (result.reportedVisibleContent) {
        hasReportedVisibleContent = true;
        reportState.hasReportedVisibleContent = true;
      }
      if (result.sawToolCall) {
        sawToolCallOverall = true;
      }
    };

    try {
      apiKey = await this.ensureApiKey(false, model);
      if (!apiKey) {
        const message = buildMissingApiKeyFallback();
        if (typeof vscode.LanguageModelError?.NoPermissions === "function") {
          throw vscode.LanguageModelError.NoPermissions(message);
        }
        throw createStructuredError("auth_failed", message);
      }

      const requestPreparationStartedAtMs = debugEnabled() ? Date.now() : undefined;
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
      const adapter = getModelAdapter(model.id);

      if (NimRequestBuilder.hasImageInput(messages) && !supportsVision) {
        throw createStructuredError(
          "model_unavailable",
          "The selected NVIDIA NIM model does not support image input.",
        );
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
        fetchAttemptBudget: fetchBudget,
      });

      tools = prepared.tools;
      reasoningIsolationExpected = prepared.reasoningIsolationExpected;
      const { inputTokenCount, requestedMaxTokens, temperatureVal, toolsEnabled } = prepared;

      const applyBudget = (body: NimChatRequest): NimChatRequest =>
        NimRequestBuilder.applyRequestBudget(body, {
          tools,
          effectiveContextWindow,
          modelMaxOutputTokens: model.maxOutputTokens,
          requestedMaxTokens,
        });

      activeRequestBody = injectHistoryLoopBreaker({
        requestBody: prepared.requestBody,
        historyMessages: messages,
        modelId: model.id,
        applyBudget,
      });

      const baselineRequestBody = cloneNimChatRequest(activeRequestBody);
      let retryNudge: NimChatMessage | undefined;
      let retryReason: "invalid_tool_call" | undefined;
      const retryReasonHistory: string[] = [];
      let totalAttempts = 0;
      let requestPreparationDurationMs: number | undefined;
      let toolParsingStateInitDurationMs: number | undefined;
      let finalUsage: NimStreamUsage | undefined;
      let networkRetryCount = 0;
      const networkConfig = ConfigManager.getNetworkConfig();
      const fallbackConfig = ConfigManager.getFallbackConfig();
      const MAX_NETWORK_RETRIES = httpAttemptsFromConfig(networkConfig.maxHttpRetries);
      let emptyStreamRetryCount = 0;
      const MAX_EMPTY_STREAM_RETRIES = networkConfig.maxEmptyStreamRetries;
      const streamHttpAttempts = MAX_NETWORK_RETRIES;
      let everSawReasoning = false;
      let lastFinishReasonOverall: string | null | undefined = undefined;
      let hasRetriedRepetitionLoop = false;
      let hasRetriedInvalidToolCall = false;

      const firstTokenTimeoutMs =
        typeof fallbackConfig.firstTokenTimeoutSeconds === "number" &&
        fallbackConfig.firstTokenTimeoutSeconds > 0
          ? fallbackConfig.firstTokenTimeoutSeconds * 1000
          : undefined;

      const emitUsageAndStatus = (
        usage: NimStreamUsage | undefined,
        body: NimChatRequest,
      ): void => {
        const usagePart = createUsageDataPart(usage);
        if (usagePart) {
          progress.report(usagePart);
        }
        if (this.statusBar) {
          const shortName = model.name ?? model.id.split("/").at(-1) ?? model.id;
          const sentTools = body.tools ?? tools;
          const categoryBreakdown = estimateNimMessagesTokensByCategory(body.messages);
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
            actualPromptTokens: usage?.prompt_tokens,
            actualCompletionTokens: usage?.completion_tokens,
            output: usage?.completion_tokens,
            contextWindow,
          };
          this.statusBar.showTokenBreakdown(breakdown);
        }
      };

      const maxAttempts = Math.max(1, MAX_EMPTY_STREAM_RETRIES + 1, MAX_NETWORK_RETRIES + 1, 2);
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        totalAttempts += 1;
        finalUsage = undefined;
        const attemptStartedAtMs = Date.now();
        if (
          requestPreparationDurationMs === undefined &&
          requestPreparationStartedAtMs !== undefined
        ) {
          requestPreparationDurationMs = attemptStartedAtMs - requestPreparationStartedAtMs;
        }

        const allocated = fetchBudget.consume(streamHttpAttempts);
        if (allocated <= 0) {
          break;
        }

        // Snapshot the baseline so a failed attempt cannot stack mutations.
        let attemptBody = cloneNimChatRequest(baselineRequestBody);
        if (retryNudge) {
          attemptBody = appendChatMessage(attemptBody, retryNudge);
          try {
            attemptBody = applyBudget(attemptBody);
          } catch {
            debugLog("streamRetry", "retry nudge dropped: context budget exceeded");
            if (
              retryReasonHistory.at(-1) === "repetition_loop" ||
              retryReasonHistory.at(-1) === "hanging_colon"
            ) {
              progress.report(new vscode.LanguageModelTextPart(REPETITION_STOP_NOTICE));
            }
            break;
          }
        }
        activeRequestBody = attemptBody;

        let result: StreamAttemptResult;
        try {
          result = await runStreamAttempt({
            apiKey,
            requestBody: attemptBody,
            signal: abortController.signal,
            userAgent: this.userAgent,
            token,
            progress,
            model,
            options,
            messages,
            adapter,
            reasoningIsolationExpected,
            maxFetchAttempts: allocated,
            firstTokenTimeoutMs,
            hasRetriedRepetitionLoop,
            onContentReported: () => {
              hasReportedContent = true;
              reportState.hasReportedContent = true;
            },
            onVisibleContentReported: () => {
              hasReportedVisibleContent = true;
              reportState.hasReportedVisibleContent = true;
            },
          });
        } catch (streamErr) {
          const isNetworkError =
            (streamErr instanceof NvidiaApiError && streamErr.kind === "network_error") ||
            (streamErr instanceof Error && streamErr.name === "TypeError");

          if (
            !abortController.signal.aborted &&
            isNetworkError &&
            !hasReportedContent &&
            networkRetryCount < MAX_NETWORK_RETRIES
          ) {
            networkRetryCount += 1;
            debugLog(
              "streamRetry",
              `Network error during stream (retry ${networkRetryCount}/${MAX_NETWORK_RETRIES}): ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            );
            retryNudge = {
              role: "user",
              content:
                "Your previous response was interrupted by a network error. Please start over and provide a complete response.",
            };
            continue;
          }

          throw streamErr;
        }

        markReported(result);
        if (result.sawReasoning) {
          everSawReasoning = true;
        }
        lastFinishReasonOverall = result.lastFinishReason;
        finalUsage = result.lastUsage;
        if (result.toolParsingStateInitDurationMs !== undefined) {
          toolParsingStateInitDurationMs = result.toolParsingStateInitDurationMs;
        }

        const skippedToolCallNames = Array.from(
          new Set(result.skippedToolCalls.map((call) => call.name)),
        );
        const retryMessage = result.sawToolCall
          ? buildInvalidToolCallRetryMessage(result.skippedToolCalls)
          : undefined;
        const willRetryAfterInvalidToolCall =
          ConfigManager.getToolsConfig().autoRetryInvalidCalls &&
          result.sawToolCall &&
          !result.emittedToolCall &&
          !hasRetriedInvalidToolCall &&
          Boolean(retryMessage);
        const willRetryEmptyStream =
          !result.sawReasoning &&
          !result.sawToolCall &&
          !result.reportedVisibleContent &&
          !result.emittedToolCall &&
          emptyStreamRetryCount < MAX_EMPTY_STREAM_RETRIES &&
          !fetchBudget.exhausted;
        const isRepetitionLoop = result.repetitionTripped;
        const isHangingColon =
          !result.sawToolCall &&
          !result.emittedToolCall &&
          result.reportedVisibleContent &&
          toolsEnabled &&
          result.lastVisibleText.trimEnd().endsWith(":") &&
          (result.lastFinishReason === "stop" ||
            result.lastFinishReason === null ||
            result.lastFinishReason === undefined);
        const isTruncatedLength =
          result.lastFinishReason === "length" && !result.sawToolCall && !result.emittedToolCall;
        const autoContinueOnLoop = ConfigManager.getGenerationConfig().autoContinueOnLoop;
        const willRetryRepetitionLoop =
          isRepetitionLoop && autoContinueOnLoop && !hasRetriedRepetitionLoop && attempt === 0;
        const willRetryHangingColon =
          !isRepetitionLoop &&
          isHangingColon &&
          autoContinueOnLoop &&
          !hasRetriedRepetitionLoop &&
          attempt === 0;
        const willRetryTruncation =
          !isRepetitionLoop &&
          !isHangingColon &&
          isTruncatedLength &&
          autoContinueOnLoop &&
          !hasRetriedRepetitionLoop &&
          attempt === 0;
        const willRetryOnLoop =
          willRetryRepetitionLoop || willRetryHangingColon || willRetryTruncation;
        const currentRetryReason =
          retryReason ??
          (willRetryAfterInvalidToolCall
            ? "invalid_tool_call"
            : willRetryOnLoop
              ? willRetryRepetitionLoop
                ? "repetition_loop"
                : "hanging_colon"
              : willRetryEmptyStream
                ? "empty_stream"
                : undefined);

        if (result.firstResponseAtMs !== undefined) {
          const totalDurationMs = Date.now() - attemptStartedAtMs;
          const generationDurationMs = Math.max(
            0,
            totalDurationMs - (result.firstResponseAtMs - attemptStartedAtMs),
          );
          const promptTokens = result.lastUsage?.prompt_tokens;
          const completionTokens = result.lastUsage?.completion_tokens;
          const totalTokens = result.lastUsage?.total_tokens;
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
            skippedToolCallCount: result.skippedToolCalls.length,
            ...(skippedToolCallNames.length > 0 ? { skippedToolCallNames } : {}),
            ...(currentRetryReason ? { retryReason: currentRetryReason } : {}),
            firstTokenLatencyMs: result.firstResponseAtMs - attemptStartedAtMs,
            ...(result.firstToolCallAtMs !== undefined
              ? { firstToolCallLatencyMs: result.firstToolCallAtMs - attemptStartedAtMs }
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
            reportedContent: result.reportedContent,
            reportedVisibleContent: result.reportedVisibleContent,
            emittedToolCall: result.emittedToolCall,
            sawReasoning: result.sawReasoning,
            lastFinishReason: result.lastFinishReason,
            streamChunkCount: result.streamChunkCount,
            willRetryEmptyStream,
            willRetryOnLoop,
            isRepetitionLoop,
            isHangingColon,
            hasRetriedRepetitionLoop,
            emptyStreamRetryCount,
          });
        }

        if (result.lastUsage) {
          debugLog("stream usage", result.lastUsage);
        }

        if (willRetryOnLoop) {
          hasRetriedRepetitionLoop = true;
          retryReasonHistory.push(
            willRetryRepetitionLoop
              ? "repetition_loop"
              : willRetryHangingColon
                ? "hanging_colon"
                : "output_truncated",
          );
          retryNudge = {
            role: "user",
            content: willRetryRepetitionLoop
              ? `${LOOP_BREAKER_MARKER} hey you got stuck repeating the same output — continue working without repeating the preamble. Directly call the required tool or provide the final answer.`
              : willRetryHangingColon
                ? `${LOOP_BREAKER_MARKER} hey you got stuck — your previous turn ended with ":" with no tool call but a next action was expected. Continue working and take the next action.`
                : `${LOOP_BREAKER_MARKER} your previous reply was cut off at the output token limit. Continue from where you left off. Call a tool if needed or finish the answer.`,
          };
          debugLog("repetitionGuard", {
            action: "autoContinue",
            trippedLine: result.trippedLine,
            isHangingColon,
            lastVisibleText: result.lastVisibleText.slice(0, 120),
          });
          outputLog(
            "repetitionGuard",
            `Auto-continue after ${willRetryRepetitionLoop ? "repetition loop" : willRetryHangingColon ? "hanging ':'" : "truncated output"} on ${model.id}: "${(result.trippedLine ?? result.lastVisibleText).slice(0, 80)}"`,
          );
          continue;
        }

        if (
          result.sawToolCall &&
          !result.emittedToolCall &&
          willRetryAfterInvalidToolCall &&
          retryMessage
        ) {
          hasRetriedInvalidToolCall = true;
          retryReason = "invalid_tool_call";
          retryReasonHistory.push("invalid_tool_call");
          retryNudge = { role: "user", content: retryMessage };
          continue;
        }

        if (result.lastFinishReason === "content_filter") {
          if (!result.reportedVisibleContent && !result.sawToolCall && !result.emittedToolCall) {
            throw createStructuredError(
              "invalid_request",
              `NVIDIA NIM filtered the response from ${model.name ?? model.id} before any answer or tool call was produced.`,
            );
          }
          progress.report(new vscode.LanguageModelTextPart(CONTENT_FILTER_NOTICE));
          break;
        }

        if (isTruncatedLength && !willRetryTruncation && result.reportedVisibleContent) {
          progress.report(new vscode.LanguageModelTextPart(OUTPUT_TRUNCATED_NOTICE));
          break;
        }

        debugLog("stream finished", {
          attempt: attempt + 1,
          totalAttempts,
          model: model.id,
          reportedContent: result.reportedContent,
          reportedVisibleContent: result.reportedVisibleContent,
          emittedToolCall: result.emittedToolCall,
          sawToolCall: result.sawToolCall,
          sawReasoning: result.sawReasoning,
          lastFinishReason: result.lastFinishReason,
          streamChunkCount: result.streamChunkCount,
          willRetryAfterInvalidToolCall,
          willRetryEmptyStream,
          willRetryOnLoop,
          isRepetitionLoop,
          isHangingColon,
          emptyStreamRetryCount,
        });

        if (willRetryEmptyStream) {
          emptyStreamRetryCount += 1;
          retryReasonHistory.push("empty_stream");
          retryNudge = undefined;
          debugLog(
            "emptyStreamRetry",
            `Empty stream (no text/tool/reasoning surfaced); retry ${emptyStreamRetryCount}/${MAX_EMPTY_STREAM_RETRIES}. lastFinishReason=${String(result.lastFinishReason)}, chunks=${result.streamChunkCount}`,
          );
          continue;
        }
        break;
      }

      if (!hasReportedVisibleContent && !sawToolCallOverall) {
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

      emitUsageAndStatus(finalUsage, activeRequestBody!);
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }

      if (
        !hasReportedContent &&
        !hasRetriedContextOverflow &&
        err instanceof NvidiaApiError &&
        (err.kind === "context_overflow" || err.kind === "token_limit") &&
        apiKey &&
        activeRequestBody &&
        ConfigManager.getContextConfig().autoCompactOnOverflow
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
          this.contextLimitStore.set(model.id, reportedMax, keyFingerprint, contextWindow);
        }

        const retryContextWindow =
          typeof reportedMax === "number" && reportedMax > 0 && reportedMax < contextWindow
            ? reportedMax
            : contextWindow;

        try {
          const compacted = await buildOverflowRetryRequest({
            messages,
            activeRequestBody,
            adapter: getModelAdapter(model.id),
            supportsVision,
            retryContextWindow,
            apiKey,
            userAgent: this.userAgent,
            signal: abortController.signal,
            fetchAttemptBudget: fetchBudget,
          });
          const allocated = compacted
            ? fetchBudget.consume(
                httpAttemptsFromConfig(ConfigManager.getNetworkConfig().maxHttpRetries),
              )
            : 0;
          if (compacted && allocated > 0) {
            notifyOverflowRetry(model);
            activeRequestBody = compacted.requestBody;
            const overflowModel = {
              ...model,
              maxOutputTokens: compacted.compactedMaxOutput,
            };
            const result = await runStreamAttempt({
              apiKey,
              requestBody: compacted.requestBody,
              signal: abortController.signal,
              userAgent: this.userAgent,
              token,
              progress,
              model: overflowModel,
              options,
              messages,
              adapter: getModelAdapter(model.id),
              reasoningIsolationExpected,
              maxFetchAttempts: allocated,
              hasRetriedRepetitionLoop: true,
              onContentReported: () => {
                hasReportedContent = true;
                reportState.hasReportedContent = true;
              },
              onVisibleContentReported: () => {
                hasReportedVisibleContent = true;
                reportState.hasReportedVisibleContent = true;
              },
            });
            markReported(result);
            if (!hasReportedVisibleContent) {
              const retryFallbackText = buildInvalidToolCallFallback(result.skippedToolCalls);
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
            const usagePart = createUsageDataPart(result.lastUsage);
            if (usagePart) {
              progress.report(usagePart);
            }
            return;
          }
        } catch (compactErr) {
          if (compactErr instanceof Error && compactErr.name === "AbortError") {
            throw new vscode.CancellationError();
          }
          if (
            compactErr instanceof NvidiaApiError &&
            compactErr.kind !== "context_overflow" &&
            compactErr.kind !== "token_limit"
          ) {
            throw compactErr;
          }
          debugLog("contextOverflow", {
            action: "compactionFailed",
            error: compactErr instanceof Error ? compactErr.message : String(compactErr),
          });
        }

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

      throw err;
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

    // Assign the in-flight promise before any await so parallel callers share
    // a single input dialog instead of stacking prompts.
    if (!this._apiKeyPrompt) {
      this._apiKeyPrompt = this.promptForApiKey().finally(() => {
        this._apiKeyPrompt = undefined;
      });
    }
    const promptedKey = await this._apiKeyPrompt;
    if (promptedKey) {
      this.apiKeyResolver.registerModelKey(model, promptedKey);
    }
    return promptedKey;
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
      if (!isLikelyNvidiaApiKey(apiKey)) {
        const proceed = await vscode.window.showWarningMessage(
          `This does not look like a NVIDIA NIM API key (expected nvapi-…). Save it anyway?`,
          { modal: true },
          "Save",
        );
        if (proceed !== "Save") {
          return undefined;
        }
      }
      await this.secrets.store(SECRET_STORAGE_KEY, apiKey);
      this.apiKeyResolver.rememberRuntimeKey(apiKey);
      return apiKey;
    }
    return undefined;
  }
}
