import { BoundedMap } from "../../shared/bounded-map";
import { NimChatRequest } from "../../types";
import { CatalogAdapterId, MODEL_LIST } from "../catalog";
import { ModelAdapter, BaseModelAdapter, ModelAdapterCapabilityContract } from "./base";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";
import { NemotronAdapter } from "./nemotron";
import { NemotronLightningAdapter } from "./nemotron-lightning";
import { NemotronSuperAdapter } from "./nemotron-super";
import { MuseGlimmerAdapter } from "./muse-glimmer";
import { GlmAdapter } from "./glm";

export {
  ModelAdapter,
  NvidiaModelRequestProfile,
  BaseModelAdapter,
  ModelAdapterCapabilityContract,
  ReasoningParameterFormat,
  ToolCallProtocol,
  ReasoningRouting,
  isReasoningIsolationExpected,
  resolveDefaultReasoningMode,
  resolveReasoningMode,
} from "./base";

class DefaultAdapter extends BaseModelAdapter {
  readonly idPattern = /.*/;
}

const deepseekAdapter = new DeepSeekAdapter();
const kimiAdapter = new KimiAdapter();
const nemotronLightningAdapter = new NemotronLightningAdapter();
const nemotronSuperAdapter = new NemotronSuperAdapter();
const nemotronAdapter = new NemotronAdapter();
const museGlimmerAdapter = new MuseGlimmerAdapter();
const glmAdapter = new GlmAdapter();

const ADAPTERS_BY_ID: Record<CatalogAdapterId, ModelAdapter> = {
  deepseek: deepseekAdapter,
  kimi: kimiAdapter,
  nemotron: nemotronAdapter,
  "nemotron-super": nemotronSuperAdapter,
  "nemotron-lightning": nemotronLightningAdapter,
  "muse-glimmer": museGlimmerAdapter,
  glm: glmAdapter,
};

/** Family regex for uncatalogued successor IDs only. Curated IDs never reach this list. */
const FAMILY_ADAPTERS: ModelAdapter[] = [
  deepseekAdapter,
  kimiAdapter,
  nemotronLightningAdapter,
  nemotronSuperAdapter,
  nemotronAdapter,
  museGlimmerAdapter,
  glmAdapter,
];

const DEFAULT_ADAPTER = new DefaultAdapter();
const MAX_ADAPTER_CACHE_SIZE = 64;
const adapterCache = new BoundedMap<string, ModelAdapter>(MAX_ADAPTER_CACHE_SIZE);

export function getModelAdapter(modelId: string): ModelAdapter {
  const cached = adapterCache.get(modelId);
  if (cached) {
    return cached;
  }

  const catalogAdapterId = MODEL_LIST[modelId]?.adapter;
  if (catalogAdapterId) {
    const catalogAdapter = ADAPTERS_BY_ID[catalogAdapterId];
    adapterCache.set(modelId, catalogAdapter);
    return catalogAdapter;
  }

  const normalizedModelId = modelId.toLowerCase();
  const matched = FAMILY_ADAPTERS.find((adapter) => adapter.matches(normalizedModelId));
  const result = matched ?? DEFAULT_ADAPTER;
  adapterCache.set(modelId, result);
  return result;
}

/**
 * Turn reasoning off (or to the model's lowest effort when it always thinks)
 * for internal single-shot calls such as summarization and image analysis.
 * Without it the endpoint's own default applies, which is high or max for
 * every curated model, and the reasoning trace can use up the small
 * `max_tokens` budget of those calls before any answer is written.
 */
export function withReasoningOff(request: NimChatRequest): NimChatRequest {
  getModelAdapter(request.model).applyReasoningMode?.(request, "none");
  return request;
}

export function getModelCapabilityContract(modelId: string): ModelAdapterCapabilityContract {
  return getModelAdapter(modelId).getCapabilityContract();
}
