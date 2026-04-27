import { ModelAdapter } from "./base";
import { DefaultAdapter } from "./default";

const DEFAULT_ADAPTER = new DefaultAdapter();
const ADAPTERS: ModelAdapter[] = [];

export function getModelAdapter(modelId: string): ModelAdapter {
  const normalizedModelId = modelId.toLowerCase();
  const matched = ADAPTERS.find((adapter) => adapter.matches(normalizedModelId));
  return matched ?? DEFAULT_ADAPTER;
}
