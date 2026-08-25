import { BaseModelAdapter } from "./base";

export class NemotronSuperAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3-super([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly toolTemperature = 1;
  readonly defaultTopP = 0.95;
  readonly toolSystemMessage =
    'You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, you must invoke tools directly when needed to accomplish the user\'s task. NEVER start your response with "Let me fix", "Let me run", "Let me check" or similar preamble when a tool is needed — emit the tool call immediately. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.';

  readonly supportedReasoningModes = ["none", "low", "high"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    if (mode === "low") {
      request.chat_template_kwargs.enable_thinking = true;
      request.chat_template_kwargs.low_effort = true;
    } else if (mode === "high") {
      request.chat_template_kwargs.enable_thinking = true;
      delete request.chat_template_kwargs.low_effort;
    } else {
      // mode === "none" or fallback
      request.chat_template_kwargs.enable_thinking = false;
      delete request.chat_template_kwargs.low_effort;
    }
  }
}
