import { BaseModelAdapter } from "./base";

export class NemotronAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])nemotron([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly toolTemperature = 1;
  readonly defaultTopP = 0.95;
  readonly defaultFrequencyPenalty = 0.15;
  readonly defaultPresencePenalty = 0.08;
  readonly toolSystemMessage =
    'You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, you must invoke tools directly when needed to accomplish the user\'s task. NEVER start your response with "Let me fix", "Let me run", "Let me check" or similar preamble when a tool is needed — emit the tool call immediately. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.';

  readonly supportedReasoningModes = ["none", "medium", "high"];
  readonly reasoningParameterFormat = "reasoning_effort" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    if (mode === "none") {
      request.reasoning_effort = "none";
    } else if (mode === "medium") {
      request.reasoning_effort = "medium";
    } else if (mode === "high") {
      request.reasoning_effort = "high";
    }
  }
}
