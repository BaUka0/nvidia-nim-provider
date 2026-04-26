import type { NvidiaModelSummary } from "./types";

export interface NormalizedNvidiaModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const NON_CHAT_MODEL_ID_PATTERNS = [
  /(^|[/_-])bge([-_/]|$)/i,
  /(^|[/_-])(clip|detector|embed|embedcode|embedqa|embedding|gliner|parse|rerank|retriever|reward)([-_/]|$)/i,
];

const KNOWN_MODEL_OVERRIDES: Record<string, Partial<NormalizedNvidiaModel>> = {
  "meta/llama-4-maverick-17b-128e-instruct": {
    displayName: "Llama 4 Maverick 17B 128E Instruct",
  },
};

export function normalizeNvidiaModels(models: NvidiaModelSummary[]): NormalizedNvidiaModel[] {
  const seenIds = new Set<string>();
  const normalizedModels: NormalizedNvidiaModel[] = [];

  for (const model of models) {
    if (seenIds.has(model.id) || !isChatModel(model)) {
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
  const override = KNOWN_MODEL_OVERRIDES[model.id];

  return {
    id: model.id,
    displayName: model.name ?? override?.displayName ?? deriveDisplayName(model.id),
    contextWindow:
      getPositiveNumber(model.metadata?.context_window) ??
      getPositiveNumber(override?.contextWindow) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      getPositiveNumber(model.metadata?.max_output_tokens) ??
      getPositiveNumber(model.metadata?.max_tokens) ??
      getPositiveNumber(override?.maxOutputTokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    supportsTools: model.capabilities?.tool_calling ?? override?.supportsTools ?? true,
    supportsVision: model.capabilities?.vision ?? override?.supportsVision ?? false,
  };
}

function isChatModel(model: NvidiaModelSummary): boolean {
  if (model.capabilities?.chat === true) {
    return true;
  }

  if (model.capabilities?.chat === false) {
    return false;
  }

  return !isClearlyNonChatModelId(model.id);
}

function isClearlyNonChatModelId(modelId: string): boolean {
  return NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function deriveDisplayName(modelId: string): string {
  const lastSegment = modelId.split("/").at(-1);
  return lastSegment && lastSegment.length > 0 ? lastSegment : modelId;
}

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
