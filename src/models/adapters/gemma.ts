import { BaseModelAdapter } from "./base";

export class GemmaAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])gemma([\/_-]|$)/i;
  readonly defaultTemperature = 0.3;
  readonly toolTemperature = 0.15;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When calling tools, emit a valid JSON arguments object only. Do not include chain-of-thought reasoning or internal scratchpad text in the visible response.";
}
