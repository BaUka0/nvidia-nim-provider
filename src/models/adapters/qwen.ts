import { BaseModelAdapter } from "./base";

export class QwenAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])qwen([\/_-]|$)/i;
  readonly defaultTemperature = 0.1;
  readonly toolTemperature = 0.05;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When calling tools, emit a valid JSON arguments object only. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose. Do not provide multiple alternative actions for the user to choose from.";
}
