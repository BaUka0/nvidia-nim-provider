import { ModelAdapter, BaseModelAdapter, DEFAULT_TEMPERATURE } from "./base";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";
import { GlmAdapter } from "./glm";
import { LlamaAdapter } from "./llama";
import { NemotronAdapter } from "./nemotron";
import { ClaudeAdapter } from "./claude";
import { GptAdapter } from "./gpt";
import { MistralAdapter } from "./mistral";
import { QwenAdapter } from "./qwen";
import { PhiAdapter } from "./phi";
import { YiAdapter } from "./yi";
import { GemmaAdapter } from "./gemma";

export { ModelAdapter, NvidiaModelRequestProfile, BaseModelAdapter } from "./base";
export { DeepSeekAdapter } from "./deepseek";
export { KimiAdapter } from "./kimi";
export { GlmAdapter } from "./glm";
export { LlamaAdapter } from "./llama";
export { MistralAdapter } from "./mistral";
export { QwenAdapter } from "./qwen";
export { PhiAdapter } from "./phi";
export { YiAdapter } from "./yi";
export { GemmaAdapter } from "./gemma";
export { NemotronAdapter } from "./nemotron";
export { ClaudeAdapter } from "./claude";
export { GptAdapter } from "./gpt";

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
  new LlamaAdapter(),
  new NemotronAdapter(),
  new ClaudeAdapter(),
  new GptAdapter(),
  new MistralAdapter(),
  new QwenAdapter(),
  new PhiAdapter(),
  new YiAdapter(),
  new GemmaAdapter(),
];

const DEFAULT_ADAPTER = new DefaultAdapter();
const adapterCache = new Map<string, ModelAdapter>();
const MAX_ADAPTER_CACHE_SIZE = 64;

export function getModelAdapter(modelId: string): ModelAdapter {
  const cached = adapterCache.get(modelId);
  if (cached) {
    return cached;
  }

  const normalizedModelId = modelId.toLowerCase();
  const matched = ADAPTERS.find((adapter) => adapter.matches(normalizedModelId));
  const result = matched ?? DEFAULT_ADAPTER;

  if (adapterCache.size >= MAX_ADAPTER_CACHE_SIZE) {
    const firstKey = adapterCache.keys().next().value;
    if (firstKey !== undefined) {
      adapterCache.delete(firstKey);
    }
  }
  adapterCache.set(modelId, result);
  return result;
}
