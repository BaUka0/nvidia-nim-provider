import { BaseModelAdapter } from "./base";

export class NemotronAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])nemotron([\/_-]|$)/i;
  readonly defaultTemperature = 0.2;
  readonly toolTemperature = 0.1;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or a valid tool call. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.";

  readonly supportedReasoningModes = ["none", "medium", "high"];

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
