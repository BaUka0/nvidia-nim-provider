import { BaseModelAdapter } from "./base";

export class MistralAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])(mistral|mixtral)([\/_-]|$)/i;
  readonly defaultTemperature = 0.3;
  readonly toolTemperature = 0.2;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers, apologies, or meta-commentary about your capabilities in the response.";
}
