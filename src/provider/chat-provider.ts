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
import { ConfigManager } from "../shared/config";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MANAGE_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { BoundedMap } from "../shared/bounded-map";
import { FetchAttemptBudget } from "../shared/fetch-attempt-budget";
import { isLikelyNvidiaApiKey } from "../shared/api-key-format";
import { getFallbackModel, NormalizedNvidiaModel } from "../models/catalog";
import { debugLog, outputLog } from "../shared/logging";
import { FallbackConfig } from "../shared/config";
import { StatusBarManager } from "../shared/status-bar";
import { estimateMessageTokens, estimateTokens, LegacyPart } from "../messages/converter";
import {
  NvidiaModelDiscoveryService,
  NvidiaLanguageModelChatInformation,
} from "../models/discovery";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import { createStructuredError, NvidiaApiError } from "../api/errors";
import { NimRequestBuilder } from "./request-builder";
import { ContextLimitStore } from "./context-limit-store";
import {
  buildFallbackModelInfo,
  fallbackCapacityLabel,
  isFallbackEligibleError,
} from "./fallback-orchestrator";
import { ChatRuntimeInfo, ModelTurnExecutor, ModelTurnReportState } from "./turn-executor";
import { isCancellation } from "../shared/cancellation";

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
 * Surface a failover hop: OS notification (opt-in), log, and an in-chat
 * notice (opt-in). Lives at this VS Code boundary so the fallback helpers
 * stay UI-free.
 */
function reportFallbackHop(options: {
  err: NvidiaApiError;
  currentModel: LanguageModelChatInformation;
  fallbackModel: NormalizedNvidiaModel;
  fallbackConfig: FallbackConfig;
  progress: Progress<LanguageModelResponsePart>;
}): void {
  const currentName = options.currentModel.name ?? options.currentModel.id;
  const capacityLabel = fallbackCapacityLabel(options.err);

  if (options.fallbackConfig.notifyUser) {
    vscode.window.showInformationMessage(
      `${capacityLabel} on ${currentName}. Falling back to ${options.fallbackModel.displayName}.`,
    );
  }
  outputLog(
    "fallback",
    `${capacityLabel} on ${options.currentModel.id}, falling back to ${options.fallbackModel.id}.`,
  );

  if (options.fallbackConfig.showNoticeInChat) {
    options.progress.report(
      new vscode.LanguageModelTextPart(
        `> ⚡ **NVIDIA NIM Fallback:** ${capacityLabel} on *${currentName}*. Response generated by *${options.fallbackModel.displayName}*.

`,
      ),
    );
  }
}

export class NimChatModelProvider implements LanguageModelChatProvider {
  private readonly discoveryService: NvidiaModelDiscoveryService;
  private readonly apiKeyResolver: NvidiaApiKeyResolver;
  private readonly turnExecutor: ModelTurnExecutor;
  private readonly runtimeInfoCache = new BoundedMap<string, ChatRuntimeInfo>(
    MAX_RUNTIME_INFO_CACHE_SIZE,
  );
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
    this.turnExecutor = new ModelTurnExecutor(userAgent, this.contextLimitStore, statusBar);
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

  private setRuntimeInfoCache(modelId: string, runtimeInfo: ChatRuntimeInfo): ChatRuntimeInfo {
    this.runtimeInfoCache.set(modelId, runtimeInfo);
    return runtimeInfo;
  }

  private fallbackContextWindow(model: LanguageModelChatInformation): number {
    return model.maxInputTokens + Math.min(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  }

  private async resolveChatModelRuntimeInfo(
    model: LanguageModelChatInformation,
    apiKey?: string,
  ): Promise<ChatRuntimeInfo> {
    const cachedRuntimeInfo = this.runtimeInfoCache.get(model.id);
    if (cachedRuntimeInfo) {
      return cachedRuntimeInfo;
    }

    const cachedModel = this.discoveryService
      .getNormalizedModels()
      .find((entry) => entry.id === model.id);
    if (cachedModel) {
      return this.setRuntimeInfoCache(model.id, {
        supportsTools: cachedModel.supportsTools,
        supportsVision: cachedModel.supportsVision,
        contextWindow: cachedModel.contextWindow,
        runtimeMetadataSource: "cache",
      });
    }

    const providerModelInfo = model as LanguageModelChatInformation & {
      detail?: unknown;
      family?: unknown;
    };
    if (
      providerModelInfo.detail === PROVIDER_DISPLAY_NAME ||
      providerModelInfo.family === PROVIDER_VENDOR
    ) {
      const currentModel = (await this.discoveryService.getAvailableModels(apiKey)).find(
        (entry) => entry.id === model.id,
      );
      return this.setRuntimeInfoCache(model.id, {
        supportsTools: currentModel?.supportsTools ?? false,
        supportsVision: currentModel?.supportsVision ?? false,
        contextWindow: currentModel?.contextWindow ?? this.fallbackContextWindow(model),
        runtimeMetadataSource: "fetched-model",
      });
    }

    const capabilities = (model as SelectedModelRuntimeCapabilities).capabilities;
    if (capabilities) {
      return this.setRuntimeInfoCache(model.id, {
        supportsTools: Boolean(capabilities.toolCalling),
        supportsVision: capabilities.imageInput === true,
        contextWindow: this.fallbackContextWindow(model),
        runtimeMetadataSource: "selected-model",
      });
    }

    const fetchedModel = (await this.discoveryService.getAvailableModels(apiKey)).find(
      (entry) => entry.id === model.id,
    );
    return this.setRuntimeInfoCache(model.id, {
      supportsTools: fetchedModel?.supportsTools ?? false,
      supportsVision: fetchedModel?.supportsVision ?? false,
      contextWindow: fetchedModel?.contextWindow ?? this.fallbackContextWindow(model),
      runtimeMetadataSource: "fetched-model",
    });
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

    // Failover chain state is local to this response: one shared fetch budget
    // and the depth / tried-models bookkeeping for the hop loop below.
    const fetchBudget = new FetchAttemptBudget();
    let currentModel = model;
    const chainState = { depth: 0, triedModelIds: [] as string[] };
    const reportState: ModelTurnReportState = {
      hasReportedContent: false,
      hasReportedVisibleContent: false,
      failingAttemptHasVisibleContent: false,
    };

    try {
      while (true) {
        // One snapshot per failover hop: the turn and its fallback decision
        // must not see different settings if the user edits them mid-turn.
        const nimConfig = ConfigManager.getNimConfig();
        try {
          const apiKey = await this.ensureApiKey(currentModel);
          if (!apiKey) {
            const message = buildMissingApiKeyFallback();
            if (typeof vscode.LanguageModelError?.NoPermissions === "function") {
              throw vscode.LanguageModelError.NoPermissions(message);
            }
            throw createStructuredError("auth_failed", message);
          }

          const runtimeInfo = await this.resolveChatModelRuntimeInfo(currentModel, apiKey);

          await this.turnExecutor.executeTurn({
            model: currentModel,
            messages,
            options,
            progress,
            token,
            abortController,
            fetchBudget,
            reportState,
            apiKey,
            runtimeInfo,
            nimConfig,
            onOverflowCompaction: (modelLabel) => {
              vscode.window.showInformationMessage(
                `Context overflow on ${modelLabel}. Retrying with compacted history…`,
              );
            },
          });
          return;
        } catch (err) {
          if (isCancellation(err, token)) {
            throw new vscode.CancellationError();
          }

          const fallbackConfig = nimConfig.fallback;
          const priorDepth = chainState.depth;
          if (fetchBudget.exhausted) {
            throw toHostChatError(err);
          }
          if (
            !isFallbackEligibleError(
              err,
              fallbackConfig,
              priorDepth,
              reportState.failingAttemptHasVisibleContent,
            )
          ) {
            throw toHostChatError(err);
          }

          const modelApiKey = (await this.apiKeyResolver.resolveForModel(currentModel))?.value;
          const hasImages = NimRequestBuilder.hasImageInput(messages);
          const fallbackModel = getFallbackModel(
            currentModel.id,
            await this.discoveryService.getAvailableModels(modelApiKey),
            {
              configuredFallbackModelId: fallbackConfig.model,
              configuredVisionFallbackModelId: fallbackConfig.visionModel,
              requiresVision: hasImages,
              priorityList: fallbackConfig.priorityList,
              triedModelIds: chainState.triedModelIds,
            },
          );

          if (!fallbackModel) {
            if (priorDepth > 0) {
              throw toHostChatError(
                createStructuredError(
                  err instanceof NvidiaApiError ? err.kind : "rate_limited",
                  [
                    `All NVIDIA NIM failover candidates failed after ${priorDepth} step(s).`,
                    `Tried chain: ${[...chainState.triedModelIds, currentModel.id].join(" -> ")}`,
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

          chainState.depth = priorDepth + 1;
          chainState.triedModelIds = [...chainState.triedModelIds, currentModel.id];
          currentModel = buildFallbackModelInfo(
            currentModel,
            fallbackModel,
            nimConfig.context.safetyMarginPercent,
          );
          if (modelApiKey) {
            this.apiKeyResolver.registerModelKey(currentModel, modelApiKey);
          }
        }
      }
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

  private async ensureApiKey(model: LanguageModelChatInformation): Promise<string | undefined> {
    const resolved = await this.apiKeyResolver.resolveForModel(model);
    if (resolved) {
      return resolved.value;
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
