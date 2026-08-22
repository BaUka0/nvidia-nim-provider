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
  /**
   * Optional override for the VS Code agent-mode edit tool hint
   * (proposed LanguageModelChatCapabilities.editTools).
   */
  editTools?: readonly string[];
}

/**
 * Edit tool names currently recognized by VS Code's agent mode. Unknown
 * entries are filtered out before surfacing the hint to the editor.
 */
export const KNOWN_EDIT_TOOLS = [
  "find-replace",
  "multi-find-replace",
  "apply-patch",
  "code-rewrite",
] as const;

export type KnownEditTool = (typeof KNOWN_EDIT_TOOLS)[number];

const DEFAULT_TOOL_CALLING_EDIT_TOOLS: readonly KnownEditTool[] = [
  "find-replace",
  "multi-find-replace",
];

const DEPRECATED_DISPLAY_NAME_MARKER = "(Deprecated)";

/**
 * Resolves the agent-mode edit tool hint for a curated model. Explicit
 * catalog overrides win; otherwise every tool-calling model advertises the
 * general-purpose find/replace tools, and text-only models advertise none.
 */
export function getEditToolsHint(modelId: string): readonly string[] | undefined {
  const entry = ELITE_MODELS_WHITELIST[modelId];
  if (!entry) {
    return undefined;
  }
  if (entry.editTools) {
    const known = new Set<string>(KNOWN_EDIT_TOOLS);
    const filtered = entry.editTools.filter((tool) => known.has(tool));
    return filtered.length > 0 ? filtered : undefined;
  }
  return entry.supportsTools ? DEFAULT_TOOL_CALLING_EDIT_TOOLS : undefined;
}

/**
 * Builds the model picker hover warning banner for deprecated curated models,
 * or undefined when the model is not marked deprecated.
 */
export function getModelWarningText(modelId: string): string | undefined {
  const entry = ELITE_MODELS_WHITELIST[modelId];
  if (!entry || !entry.displayName.includes(DEPRECATED_DISPLAY_NAME_MARKER)) {
    return undefined;
  }
  return `**${entry.displayName}** is deprecated and may be retired by NVIDIA at any time. Requests automatically fail over to a supported model when possible.`;
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

export const ELITE_MODELS_WHITELIST: Record<string, NvidiaModelCatalogEntry> = {
  "deepseek-ai/deepseek-v4-flash-0731": {
    displayName: "DeepSeek V4 Flash 0731",
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
  "moonshotai/kimi-k2.6": {
    displayName: "Kimi k2.6 (Deprecated)",
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
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    displayName: "Nemotron 3.5 Lightning 30B",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false,
  },
  "z-ai/glm-5.2": {
    displayName: "GLM 5.2",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  "stepfun-ai/step-3.7-flash": {
    displayName: "Step 3.7 Flash",
    contextWindow: 262144,
    maxOutputTokens: 262144,
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
  "meta/muse-glimmer-30b": {
    displayName: "Muse Glimmer",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true,
  },
};

export const FALLBACK_MODEL_ID = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const FALLBACK_VISION_MODEL_ID = "minimaxai/minimax-m3";

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
 * failing model are skipped. Vision requests additionally require
 * supportsVision, with a last-resort sweep over any remaining vision model.
 */
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
    return availableModels.find((m) => m.supportsVision && !excluded.has(m.id));
  }
  return undefined;
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
