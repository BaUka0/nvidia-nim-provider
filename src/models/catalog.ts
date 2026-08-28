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
  /** Surfaced in the Copilot model picker as a subtitle/tooltip. */
  pickerStatus?: "unavailable";
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

export const MODEL_LIST: Record<string, NvidiaModelCatalogEntry> = {
  "deepseek-ai/deepseek-v4-flash-0731": {
    displayName: "DeepSeek V4 Flash 0731",
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  "deepseek-ai/deepseek-v4-pro-0813": {
    displayName: "DeepSeek V4 Pro 0813",
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  "minimaxai/minimax-m3": {
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsVision: true,
  },
  "moonshotai/kimi-k3": {
    displayName: "Kimi K3",
    contextWindow: 1048576,
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
  "nvidia/nemotron-3-super-120b-a12b": {
    displayName: "Nemotron 3 Super 120B",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false,
  },
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    displayName: "Nemotron 3.5 Lightning 30B (Unavailable)",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false,
    pickerStatus: "unavailable",
  },
  "meta/muse-glimmer-30b": {
    displayName: "Muse Glimmer",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true,
  },
};

/** @deprecated Alias for MODEL_LIST */
export const ELITE_MODELS_WHITELIST = MODEL_LIST;

export const FALLBACK_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
export const FALLBACK_VISION_MODEL_ID = "meta/muse-glimmer-30b";

export interface FallbackModelSelectionOptions {
  configuredFallbackModelId?: string;
  configuredVisionFallbackModelId?: string;
  requiresVision?: boolean;
  /** Ordered fallback candidates tried before the configured single models. */
  priorityList?: string[];
  /** Models already attempted in this request's failover chain. */
  triedModelIds?: string[];
}

/**
 * Resolves the next failover candidate. Candidate order:
 * priorityList entries, then the configured text fallback, then the
 * configured vision fallback; unknown, already-tried, and the currently
 * failing model are skipped. Models with catalog pickerStatus "unavailable"
 * are skipped in last-resort sweeps. Vision requests additionally require
 * supportsVision, with a last-resort sweep over any remaining vision model.
 * Text requests last-resort over any remaining non-unavailable model.
 */
function isPickerUnavailable(modelId: string): boolean {
  return MODEL_LIST[modelId]?.pickerStatus === "unavailable";
}

export function getFallbackModel(
  currentModelId: string,
  availableModels: NormalizedNvidiaModel[],
  options?: FallbackModelSelectionOptions | string,
): NormalizedNvidiaModel | undefined {
  const normalizedOptions: FallbackModelSelectionOptions =
    typeof options === "string" ? { configuredFallbackModelId: options } : (options ?? {});

  const {
    configuredFallbackModelId,
    configuredVisionFallbackModelId,
    requiresVision = false,
    priorityList,
    triedModelIds,
  } = normalizedOptions;

  const excluded = new Set<string>([currentModelId, ...(triedModelIds ?? [])]);
  const orderedCandidateIds: string[] = [];
  const pushCandidate = (candidateId: string | undefined): void => {
    const trimmed = typeof candidateId === "string" ? candidateId.trim() : "";
    if (trimmed.length === 0 || orderedCandidateIds.includes(trimmed)) {
      return;
    }
    orderedCandidateIds.push(trimmed);
  };
  for (const candidateId of priorityList ?? []) {
    pushCandidate(candidateId);
  }
  // Legacy contract: text requests default to FALLBACK_MODEL_ID and never
  // consider the vision slot; vision requests keep their dedicated chain.
  if (!requiresVision) {
    pushCandidate(configuredFallbackModelId ?? FALLBACK_MODEL_ID);
  } else {
    pushCandidate(configuredFallbackModelId);
    pushCandidate(configuredVisionFallbackModelId ?? FALLBACK_VISION_MODEL_ID);
  }

  for (const candidateId of orderedCandidateIds) {
    if (excluded.has(candidateId)) {
      continue;
    }
    const candidate = availableModels.find((m) => m.id === candidateId);
    if (!candidate) {
      continue;
    }
    if (requiresVision && !candidate.supportsVision) {
      continue;
    }
    return candidate;
  }

  if (requiresVision) {
    return availableModels.find(
      (m) => m.supportsVision && !excluded.has(m.id) && !isPickerUnavailable(m.id),
    );
  }
  return availableModels.find((m) => !excluded.has(m.id) && !isPickerUnavailable(m.id));
}

export function normalizeNvidiaModels(models: NvidiaModelSummary[]): NormalizedNvidiaModel[] {
  const seenIds = new Set<string>();
  const normalizedModels: NormalizedNvidiaModel[] = [];

  for (const model of models) {
    if (seenIds.has(model.id) || !(model.id in MODEL_LIST)) {
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
  const override = MODEL_LIST[model.id];

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
