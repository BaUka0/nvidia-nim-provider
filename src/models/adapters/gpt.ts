import { BaseModelAdapter } from "./base";

export class GptAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])gpt([\/_-]|$)/i;
  readonly defaultTemperature = 0.3;
  readonly toolTemperature = 0.2;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, emit a valid tool call or respond with concise text. Do not include disclaimers or apologies.";
}
