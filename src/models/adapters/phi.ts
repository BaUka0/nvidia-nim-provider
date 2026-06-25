import { BaseModelAdapter } from "./base";

export class PhiAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])phi([\/_-]|$)/i;
  readonly defaultTemperature = 0.3;
  readonly toolTemperature = 0.2;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or a valid tool call. Keep responses brief and direct. Do not ask follow-up questions unless necessary.";
}
