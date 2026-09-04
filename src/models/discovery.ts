import * as vscode from "vscode";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
} from "../shared/constants";
import { ConfigManager, calculateSafetyMargin } from "../shared/config";
import { fetchCuratedModels } from "./fetch-curated";
import { MODEL_LIST, isNormalizedNvidiaModel, NormalizedNvidiaModel } from "./catalog";
import { outputLog } from "../shared/logging";
import { getModelAdapter } from "./adapters";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import { runSerializedModelCacheOperation } from "./cache";

export interface NvidiaConfigurationProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  title?: string;
  description?: string;
  enum?: readonly string[];
  enumItemLabels?: readonly string[];
  group?: string;
  default?: string | number | boolean;
  [key: string]: unknown;
}

export interface NvidiaConfigurationSchema {
  properties: Record<string, NvidiaConfigurationProperty>;
  [key: string]: unknown;
}

export interface NvidiaLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  isUserSelectable: boolean;
  configurationSchema?: NvidiaConfigurationSchema;
}

function isCachedCuratedModel(value: unknown): value is NormalizedNvidiaModel {
  return (
    isNormalizedNvidiaModel(value) && Object.prototype.hasOwnProperty.call(MODEL_LIST, value.id)
  );
}

export class NvidiaModelDiscoveryService {
  constructor(
    secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly globalState?: vscode.Memento,
    private readonly keyResolver = new NvidiaApiKeyResolver(secrets),
  ) {}

  private cacheInvalidated = false;
  private readonly modelsByFingerprint = new Map<string, NormalizedNvidiaModel[]>();

  public invalidateCache(): void {
    this.cacheInvalidated = true;
    this.modelsByFingerprint.clear();
  }

  public markCacheFresh(): void {
    this.cacheInvalidated = false;
  }

  public getNormalizedModels(): NormalizedNvidiaModel[] {
    const storedModels = this.globalState?.get<unknown>(MODELS_STATE_KEY);
    if (!Array.isArray(storedModels)) {
      return [];
    }
    return storedModels.filter(isCachedCuratedModel);
  }

  private hasNormalizedModelsCache(): boolean {
    const storedModels = this.globalState?.get<unknown>(MODELS_STATE_KEY);
    return (
      Array.isArray(storedModels) &&
      storedModels.length > 0 &&
      storedModels.every(isCachedCuratedModel)
    );
  }

  public async getAvailableModels(
    apiKey?: string,
    options: { refreshStaleCache?: boolean } = {},
  ): Promise<NormalizedNvidiaModel[]> {
    const currentKeyFingerprint = apiKey ? getApiKeyFingerprint(apiKey) : undefined;
    const memoryCached =
      currentKeyFingerprint !== undefined
        ? this.modelsByFingerprint.get(currentKeyFingerprint)
        : undefined;
    if (memoryCached && memoryCached.length > 0 && !this.cacheInvalidated) {
      return memoryCached.filter(isCachedCuratedModel);
    }
    const cachedModels = this.getNormalizedModels().filter(isCachedCuratedModel);
    const cacheVersion = this.globalState?.get<number>(MODELS_CACHE_VERSION_STATE_KEY);
    const cachedKeyFingerprint = this.globalState?.get<string>(
      MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
    );
    // A cache created before key fingerprints were introduced has no reliable
    // ownership information. Treat it as stale whenever a runtime key is
    // available instead of silently serving models fetched with another key.
    const hasCachedKeyFingerprint =
      typeof cachedKeyFingerprint === "string" && cachedKeyFingerprint.length > 0;
    const keyChanged =
      memoryCached === undefined &&
      currentKeyFingerprint !== undefined &&
      (!hasCachedKeyFingerprint || currentKeyFingerprint !== cachedKeyFingerprint);
    const cacheVersionStale = cacheVersion !== MODELS_CACHE_VERSION;
    // The option only controls whether a stale cache version may be used as a
    // fallback. Explicit invalidation and key changes always require refresh.
    const refreshStaleCache = options.refreshStaleCache !== false;
    const shouldRefresh =
      this.cacheInvalidated || keyChanged || (cacheVersionStale && refreshStaleCache);
    if (this.hasNormalizedModelsCache() && (!apiKey || !shouldRefresh)) {
      return cachedModels;
    }

    const refreshedModels = await this.fetchAvailableModels(apiKey);
    // A cache owned by a previous key is not safe to expose after a key
    // change, even when the refresh request fails. Same-key refreshes may
    // continue using the last known curated list for resilience.
    return refreshedModels ?? (keyChanged ? [] : cachedModels);
  }

  public async fetchAvailableModels(
    configuredApiKey?: string,
  ): Promise<NormalizedNvidiaModel[] | undefined> {
    return runSerializedModelCacheOperation(() =>
      this.fetchAvailableModelsInternal(configuredApiKey),
    );
  }

  private async fetchAvailableModelsInternal(
    configuredApiKey?: string,
  ): Promise<NormalizedNvidiaModel[] | undefined> {
    const resolved = await this.keyResolver.resolveConfiguredOrLegacy(configuredApiKey);
    if (!resolved) {
      return undefined;
    }
    const apiKey = resolved.value;

    try {
      const fetched = await fetchCuratedModels({
        apiKey,
        userAgent: this.userAgent,
        globalState: this.globalState ?? undefined,
      });
      if (!fetched) {
        return undefined;
      }
      this.modelsByFingerprint.set(getApiKeyFingerprint(apiKey), fetched.normalizedModels);
      this.cacheInvalidated = false;
      return fetched.normalizedModels;
    } catch (err) {
      outputLog(
        "error",
        `Failed to fetch models from API: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  public mapToChatInformation(
    models: readonly NormalizedNvidiaModel[],
  ): NvidiaLanguageModelChatInformation[] {
    const info: NvidiaLanguageModelChatInformation[] = [];

    for (const model of models) {
      if (!isCachedCuratedModel(model)) {
        continue;
      }
      const adapter = getModelAdapter(model.id);
      let configurationSchema: NvidiaConfigurationSchema | undefined;

      if (adapter.applyReasoningMode && (adapter.supportedReasoningModes?.length ?? 0) > 0) {
        const enumValues = adapter.supportedReasoningModes ?? [];
        const enumItemLabels = enumValues.map((v) =>
          v === "none" ? "None" : v.charAt(0).toUpperCase() + v.slice(1),
        );

        configurationSchema = {
          properties: {
            reasoningMode: {
              type: "string",
              title: "Reasoning Mode",
              description: "Configure the reasoning effort mode sent to supported models.",
              enum: enumValues,
              enumItemLabels: enumItemLabels,
              group: "navigation",
              default: "none",
            },
          },
        };
      }

      const pickerName = model.displayName;
      info.push({
        id: model.id,
        name: pickerName,
        detail: PROVIDER_DISPLAY_NAME,
        tooltip: `${PROVIDER_DISPLAY_NAME} ${pickerName}`,
        family: PROVIDER_VENDOR,
        version: "1.0.0",
        maxInputTokens: Math.max(
          1,
          model.contextWindow -
            model.maxOutputTokens -
            calculateSafetyMargin(
              model.contextWindow,
              ConfigManager.getContextConfig().safetyMarginPercent,
            ),
        ),
        maxOutputTokens: model.maxOutputTokens,
        contextWindow: model.contextWindow,
        isUserSelectable: true,
        capabilities: {
          toolCalling: model.supportsTools ? 128 : false,
          imageInput: model.supportsVision,
        },
        ...(configurationSchema ? { configurationSchema } : {}),
      });
    }
    return info;
  }
}
