import { BaseModelAdapter } from "./base";

export class GlmAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])glm([\/_-]|$)/i;
  readonly defaultTemperature = 0.1;
  readonly toolTemperature = 0.05;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When calling tools, emit strict JSON arguments only. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.";

  readonly supportedReasoningModes = ["none", "on"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    if (mode === "none") {
      request.chat_template_kwargs.enable_thinking = false;
    } else {
      request.chat_template_kwargs.enable_thinking = true;
      request.chat_template_kwargs.clear_thinking = false;
    }
  }
}
