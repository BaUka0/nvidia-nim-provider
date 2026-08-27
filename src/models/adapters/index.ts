import { BoundedMap } from "../../shared/bounded-map";
import {
  ModelAdapter,
  BaseModelAdapter,
  DEFAULT_TEMPERATURE,
  ModelAdapterCapabilityContract,
} from "./base";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";
import { GlmAdapter } from "./glm";
import { NemotronAdapter } from "./nemotron";
import { NemotronLightningAdapter } from "./nemotron-lightning";
import { NemotronSuperAdapter } from "./nemotron-super";
import { MinimaxAdapter } from "./minimax";
import { StepfunAdapter } from "./stepfun";
import { InklingAdapter } from "./inkling";
import { MuseGlimmerAdapter } from "./muse-glimmer";

export {
  ModelAdapter,
  NvidiaModelRequestProfile,
  BaseModelAdapter,
  ModelAdapterCapabilityContract,
  ReasoningParameterFormat,
  ToolCallProtocol,
  ReasoningRouting,
} from "./base";
export { DeepSeekAdapter } from "./deepseek";
export { KimiAdapter } from "./kimi";
export { GlmAdapter } from "./glm";
export { NemotronAdapter } from "./nemotron";
export { NemotronLightningAdapter } from "./nemotron-lightning";
export { NemotronSuperAdapter } from "./nemotron-super";
export { MinimaxAdapter } from "./minimax";
export { StepfunAdapter } from "./stepfun";
export { InklingAdapter } from "./inkling";
export { MuseGlimmerAdapter } from "./muse-glimmer";

class DefaultAdapter extends BaseModelAdapter {
  readonly idPattern = /.*/;
  readonly defaultTemperature = DEFAULT_TEMPERATURE;
  readonly toolTemperature = 0.3;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. Prefer simple solutions. Analyze the problem before coding. When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers or apologies.";
}

const ADAPTERS: ModelAdapter[] = [
  new DeepSeekAdapter(),
  new KimiAdapter(),
  new GlmAdapter(),
  new NemotronLightningAdapter(),
  new NemotronSuperAdapter(),
  new NemotronAdapter(),
  new MinimaxAdapter(),
  new StepfunAdapter(),
  new InklingAdapter(),
  new MuseGlimmerAdapter(),
];

const DEFAULT_ADAPTER = new DefaultAdapter();
const MAX_ADAPTER_CACHE_SIZE = 64;
const adapterCache = new BoundedMap<string, ModelAdapter>(MAX_ADAPTER_CACHE_SIZE);

export function getModelAdapter(modelId: string): ModelAdapter {
  const cached = adapterCache.get(modelId);
  if (cached) {
    return cached;
  }

  const normalizedModelId = modelId.toLowerCase();
  const matched = ADAPTERS.find((adapter) => adapter.matches(normalizedModelId));
  const result = matched ?? DEFAULT_ADAPTER;
  adapterCache.set(modelId, result);
  return result;
}

export function getModelCapabilityContract(modelId: string): ModelAdapterCapabilityContract {
  return getModelAdapter(modelId).getCapabilityContract();
}
