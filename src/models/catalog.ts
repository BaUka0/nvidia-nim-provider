import type { NvidiaModelSummary } from "../types";

export interface NormalizedNvidiaModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

const ELITE_MODELS_WHITELIST: Record<string, Partial<NormalizedNvidiaModel>> = {
  "deepseek-ai/deepseek-v4-flash": {
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
  },
  "deepseek-ai/deepseek-v4-pro": {
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
  },
  "minimaxai/minimax-m3": {
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutputTokens: 100000,
    supportsVision: true,
  },
  "moonshotai/kimi-k2.6": {
    displayName: "Kimi k2.6",
    contextWindow: 256000,
    supportsVision: true,
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    displayName: "Nemotron 3 Ultra 550B",
    contextWindow: 1000000,
  },
  "z-ai/glm-5.1": {
    displayName: "GLM 5.1",
    contextWindow: 131072,
  },
  "stepfun-ai/step-3.7-flash": {
    displayName: "Step 3.7 Flash",
    contextWindow: 256000,
    supportsVision: true,
  },
};

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
    typeof candidate.displayName === "string" &&
    typeof candidate.contextWindow === "number" &&
    typeof candidate.maxOutputTokens === "number" &&
    typeof candidate.supportsTools === "boolean" &&
    typeof candidate.supportsVision === "boolean"
  );
}

function normalizeNvidiaModel(model: NvidiaModelSummary): NormalizedNvidiaModel {
  const override = ELITE_MODELS_WHITELIST[model.id];

  return {
    id: model.id,
    displayName: override?.displayName ?? model.name ?? deriveDisplayName(model.id),
    contextWindow:
      getPositiveNumber(override?.contextWindow) ??
      getPositiveNumber(model.metadata?.context_window) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      getPositiveNumber(override?.maxOutputTokens) ??
      getPositiveNumber(model.metadata?.max_output_tokens) ??
      getPositiveNumber(model.metadata?.max_tokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    supportsTools: override?.supportsTools ?? model.capabilities?.tool_calling ?? true,
    supportsVision: override?.supportsVision ?? model.capabilities?.vision ?? false,
  };
}

function deriveDisplayName(modelId: string): string {
  const lastSegment = modelId.split("/").at(-1);
  return lastSegment && lastSegment.length > 0 ? lastSegment : modelId;
}

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
