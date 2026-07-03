import * as vscode from "vscode";
import {
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  SECRET_STORAGE_KEY,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../shared/constants";
import { isNormalizedNvidiaModel, NormalizedNvidiaModel } from "./catalog";
import { fetchModels } from "../api/client";
import { outputLog } from "../shared/logging";
import { getModelAdapter } from "./adapters";

export interface ChatRuntimeMetadata {
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  runtimeMetadataSource: "catalog" | "api" | "fallback";
}

export interface NvidiaLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  isUserSelectable: boolean;
  apiKey?: string;
  configurationSchema?: any;
}

export class NvidiaModelDiscoveryService {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly globalState?: vscode.Memento,
  ) {}

  public getNormalizedModels(): NormalizedNvidiaModel[] {
    const storedModels = this.globalState?.get<unknown>(MODELS_STATE_KEY);
    if (!Array.isArray(storedModels)) {
      return [];
    }
    return storedModels.every(isNormalizedNvidiaModel) ? storedModels : [];
  }

  public async getAvailableModels(
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

  public async fetchAvailableModels(
    configuredApiKey?: string,
  ): Promise<NormalizedNvidiaModel[] | undefined> {
    const apiKey = configuredApiKey ?? (await this.secrets.get(SECRET_STORAGE_KEY));
    if (!apiKey) {
      return undefined;
    }

    try {
      const rawModels = await fetchModels(apiKey, undefined, this.userAgent);
      if (!Array.isArray(rawModels)) {
        return undefined;
      }
      const { normalizeNvidiaModels } = require("./catalog");
      const normalized = normalizeNvidiaModels(rawModels);
      if (normalized.length > 0 && this.globalState) {
        await this.globalState.update(MODELS_STATE_KEY, normalized);
        await this.globalState.update(MODELS_CACHE_VERSION_STATE_KEY, MODELS_CACHE_VERSION);
      }
      return normalized;
    } catch (err) {
      outputLog("error", `Failed to fetch models from API: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  public mapToChatInformation(
    models: readonly NormalizedNvidiaModel[],
    apiKey?: string,
  ): NvidiaLanguageModelChatInformation[] {
    const info: NvidiaLanguageModelChatInformation[] = [];

    for (const model of models) {
      const adapter = getModelAdapter(model.id);
      let configurationSchema = undefined;

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
        capabilities: {
          toolCalling: model.supportsTools ? 128 : false,
          imageInput: model.supportsVision ?? false,
        },
        ...(apiKey ? { apiKey } : {}),
        ...(configurationSchema ? { configurationSchema } : {}),
      });
    }
    return info;
  }
}
