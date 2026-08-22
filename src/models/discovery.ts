import * as vscode from "vscode";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../shared/constants";
import {
  ELITE_MODELS_WHITELIST,
  getEditToolsHint,
  getModelWarningText,
  isNormalizedNvidiaModel,
  normalizeNvidiaModels,
  NormalizedNvidiaModel,
} from "./catalog";
import { fetchModels, fetchModelsOrThrow } from "../api/client";
import { outputLog } from "../shared/logging";
import { getModelAdapter } from "./adapters";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import {
  reportMissingCuratedModels,
  runSerializedModelCacheOperation,
  writeModelCacheAtomically,
} from "./cache";

export interface ChatRuntimeMetadata {
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  runtimeMetadataSource: "catalog" | "api" | "fallback";
}

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
  /** Proposed chatProvider surface: agent-mode edit tool hint. */
  readonly capabilities: vscode.LanguageModelChatCapabilities & { editTools?: readonly string[] };
  /** Proposed chatProvider surface: markdown warning banner in the picker hover. */
  warningText?: Record<string, string>;
  /** Proposed chatProvider surface: picker icon. */
  statusIcon?: { readonly id: string };
  /** Proposed chatProvider surface: marks user-supplied-key (BYOK) models. */
  isBYOK?: boolean;
}

function isCachedCuratedModel(value: unknown): value is NormalizedNvidiaModel {
  return (
    isNormalizedNvidiaModel(value) &&
    Object.prototype.hasOwnProperty.call(ELITE_MODELS_WHITELIST, value.id)
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

  public invalidateCache(): void {
    this.cacheInvalidated = true;
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
    return Array.isArray(storedModels) && storedModels.every(isCachedCuratedModel);
  }

  public async getAvailableModels(
    apiKey?: string,
    options: { refreshStaleCache?: boolean } = {},
  ): Promise<NormalizedNvidiaModel[]> {
    const cachedModels = this.getNormalizedModels().filter(isCachedCuratedModel);
    const cacheVersion = this.globalState?.get<number>(MODELS_CACHE_VERSION_STATE_KEY);
    const cachedKeyFingerprint = this.globalState?.get<string>(
      MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
    );
    const currentKeyFingerprint = apiKey ? getApiKeyFingerprint(apiKey) : undefined;
    // A cache created before key fingerprints were introduced has no reliable
    // ownership information. Treat it as stale whenever a runtime key is
    // available instead of silently serving models fetched with another key.
    const hasCachedKeyFingerprint =
      typeof cachedKeyFingerprint === "string" && cachedKeyFingerprint.length > 0;
    const keyChanged =
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
      // Keep compatibility with test/extension hosts that only expose the
      // nullable legacy fetchModels function while production uses the
      // structured-error variant.
      const fetchModelsRequest =
        typeof fetchModelsOrThrow === "function" ? fetchModelsOrThrow : fetchModels;
      const rawModels = await fetchModelsRequest(apiKey, undefined, this.userAgent);
      if (!Array.isArray(rawModels)) {
        return undefined;
      }
      reportMissingCuratedModels(rawModels);
      const normalized = normalizeNvidiaModels(rawModels);
      if (this.globalState) {
        await writeModelCacheAtomically(
          this.globalState,
          rawModels,
          normalized,
          getApiKeyFingerprint(apiKey),
        );
      }
      this.cacheInvalidated = false;
      return normalized;
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
    options: { includeEditTools?: boolean } = {},
  ): NvidiaLanguageModelChatInformation[] {
    const info: NvidiaLanguageModelChatInformation[] = [];

    for (const model of models) {
      if (!isCachedCuratedModel(model)) {
        continue;
      }
      const adapter = getModelAdapter(model.id);
      let configurationSchema: NvidiaConfigurationSchema | undefined;
      const warningText = getModelWarningText(model.id);

      if (adapter.applyReasoningMode) {
        const enumValues = adapter.supportedReasoningModes ?? [
          "none",
          "on",
          "medium",
          "high",
          "max",
        ];
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

      info.push({
        id: model.id,
        name: model.displayName ?? model.id,
        detail: PROVIDER_DISPLAY_NAME,
        tooltip: `${PROVIDER_DISPLAY_NAME} ${model.displayName ?? model.id}`,
        family: PROVIDER_VENDOR,
        version: "1.0.0",
        maxInputTokens: Math.max(
          1,
          model.contextWindow - Math.min(model.maxOutputTokens ?? 65536, DEFAULT_MAX_OUTPUT_TOKENS),
        ),
        maxOutputTokens: model.maxOutputTokens ?? 65536,
        contextWindow: model.contextWindow,
        isUserSelectable: true,
        isBYOK: true,
        statusIcon: new vscode.ThemeIcon("cloud"),
        capabilities: {
          toolCalling: model.supportsTools ? 128 : false,
          imageInput: model.supportsVision ?? false,
          editTools: options.includeEditTools ? getEditToolsHint(model.id) : undefined,
        },
        ...(warningText ? { warningText: { deprecated: warningText } } : {}),
        ...(configurationSchema ? { configurationSchema } : {}),
      });
    }
    return info;
  }
}
