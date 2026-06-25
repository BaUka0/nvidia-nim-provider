import { BaseModelAdapter } from "./base";

export class LlamaAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])llama([\/_-]|$)/i;
  readonly defaultTemperature = 0.2;
  readonly toolTemperature = 0.1;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or valid tool calls only. Do not emit pseudo tool syntax, XML-like wrappers, or tool planning markers.";
}
