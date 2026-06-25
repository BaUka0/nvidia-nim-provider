import { BaseModelAdapter } from "./base";

export class ClaudeAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])claude([\/_-]|$)/i;
  readonly defaultTemperature = 0.3;
  readonly toolTemperature = 0.2;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. Prefer simple solutions. When tools are available, emit a valid tool call with complete JSON arguments or respond with concise text. Ensure every required argument is present with the correct type. Do not include meta-commentary about your capabilities.";
}
