import { BoundedMap } from "../../shared/bounded-map";
import { CatalogAdapterId, MODEL_LIST } from "../catalog";
import {
  ModelAdapter,
  BaseModelAdapter,
  DEFAULT_TEMPERATURE,
  ModelAdapterCapabilityContract,
} from "./base";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";
import { NemotronAdapter } from "./nemotron";
import { NemotronLightningAdapter } from "./nemotron-lightning";
import { NemotronSuperAdapter } from "./nemotron-super";
import { MinimaxAdapter } from "./minimax";
import { MuseGlimmerAdapter } from "./muse-glimmer";

export {
  ModelAdapter,
  NvidiaModelRequestProfile,
  BaseModelAdapter,
  ModelAdapterCapabilityContract,
  ReasoningParameterFormat,
  ToolCallProtocol,
  ReasoningRouting,
  isReasoningIsolationExpected,
} from "./base";

class DefaultAdapter extends BaseModelAdapter {
  readonly idPattern = /.*/;
  readonly defaultTemperature = DEFAULT_TEMPERATURE;
  readonly toolTemperature = 0.3;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. Prefer simple solutions. Analyze the problem before coding. When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers or apologies.";
}

const deepseekAdapter = new DeepSeekAdapter();
const kimiAdapter = new KimiAdapter();
const nemotronLightningAdapter = new NemotronLightningAdapter();
const nemotronSuperAdapter = new NemotronSuperAdapter();
const nemotronAdapter = new NemotronAdapter();
const minimaxAdapter = new MinimaxAdapter();
const museGlimmerAdapter = new MuseGlimmerAdapter();

const ADAPTERS_BY_ID: Record<CatalogAdapterId, ModelAdapter> = {
  deepseek: deepseekAdapter,
  kimi: kimiAdapter,
  minimax: minimaxAdapter,
  nemotron: nemotronAdapter,
  "nemotron-super": nemotronSuperAdapter,
  "nemotron-lightning": nemotronLightningAdapter,
  "muse-glimmer": museGlimmerAdapter,
};

/** Family regex for uncatalogued successor IDs only. Curated IDs never reach this list. */
const FAMILY_ADAPTERS: ModelAdapter[] = [
  deepseekAdapter,
  kimiAdapter,
  nemotronLightningAdapter,
  nemotronSuperAdapter,
  nemotronAdapter,
  minimaxAdapter,
  museGlimmerAdapter,
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

export function getModelCapabilityContract(modelId: string): ModelAdapterCapabilityContract {
  return getModelAdapter(modelId).getCapabilityContract();
}
