import type { NvidiaModelSummary } from "../types";

export interface NormalizedNvidiaModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

/**
 * Curated model capabilities are deliberately explicit.  A missing field is
 * treated as a catalog authoring error instead of silently inheriting a broad
 * API default that may expose unsupported tools or images.
 */
export interface NvidiaModelCatalogEntry {
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

export const ELITE_MODELS_WHITELIST: Record<string, NvidiaModelCatalogEntry> = {
  "deepseek-ai/deepseek-v4-flash": {
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 384000,
    supportsTools: true,
    supportsVision: false,
  },
  "deepseek-ai/deepseek-v4-pro": {
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1048576,
    maxOutputTokens: 384000,
    supportsTools: true,
    supportsVision: false,
  },
  "minimaxai/minimax-m3": {
    displayName: "MiniMax M3",
    contextWindow: 524288,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsVision: true,
  },
  "moonshotai/kimi-k2.6": {
    displayName: "Kimi k2.6",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    displayName: "Nemotron 3 Ultra 550B",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false,
  },
  "z-ai/glm-5.2": {
    displayName: "GLM 5.2",
    contextWindow: 202752,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsVision: false,
  },
  "stepfun-ai/step-3.7-flash": {
    displayName: "Step 3.7 Flash",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  "thinkingmachines/inkling": {
    displayName: "Inkling",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  "poolside/laguna-xs-2.1": {
    displayName: "Laguna XS 2.1",
    contextWindow: 262144,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: false,
  },
};

export const FALLBACK_MODEL_ID = "deepseek-ai/deepseek-v4-flash";

export function getFallbackModel(
  currentModelId: string,
  availableModels: NormalizedNvidiaModel[],
): NormalizedNvidiaModel | undefined {
  if (currentModelId === FALLBACK_MODEL_ID) {
    return undefined;
  }
  return availableModels.find((m) => m.id === FALLBACK_MODEL_ID);
}

export function normalizeNvidiaModels(models: NvidiaModelSummary[]): NormalizedNvidiaModel[] {
  const seenIds = new Set<string>();
  const normalizedModels: NormalizedNvidiaModel[] = [];

  for (const model of models) {
    if (seenIds.has(model.id) || !(model.id in ELITE_MODELS_WHITELIST)) {
      continue;
    }
    seenIds.add(model.id);
    normalizedModels.push(normalizeNvidiaModel(model));
  }

  return normalizedModels;
}

export function isNormalizedNvidiaModel(value: unknown): value is NormalizedNvidiaModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<NormalizedNvidiaModel>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.displayName === "string" &&
    candidate.displayName.length > 0 &&
    typeof candidate.contextWindow === "number" &&
    Number.isFinite(candidate.contextWindow) &&
    candidate.contextWindow > 0 &&
    typeof candidate.maxOutputTokens === "number" &&
    Number.isFinite(candidate.maxOutputTokens) &&
    candidate.maxOutputTokens > 0 &&
    typeof candidate.supportsTools === "boolean" &&
    typeof candidate.supportsVision === "boolean"
  );
}

function normalizeNvidiaModel(model: NvidiaModelSummary): NormalizedNvidiaModel {
  const override = ELITE_MODELS_WHITELIST[model.id];

  return {
    id: model.id,
    displayName: override.displayName ?? model.name ?? deriveDisplayName(model.id),
    contextWindow:
      getPositiveNumber(override.contextWindow) ??
      getPositiveNumber(model.metadata?.context_window) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      getPositiveNumber(override.maxOutputTokens) ??
      getPositiveNumber(model.metadata?.max_output_tokens) ??
      getPositiveNumber(model.metadata?.max_tokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    supportsTools: override.supportsTools,
    supportsVision: override.supportsVision,
  };
}

function deriveDisplayName(modelId: string): string {
  const lastSegment = modelId.split("/").at(-1);
  return lastSegment && lastSegment.length > 0 ? lastSegment : modelId;
}

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
