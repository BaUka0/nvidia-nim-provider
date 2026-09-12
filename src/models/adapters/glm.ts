import { BaseModelAdapter } from "./base";
import { NimChatRequest } from "../../types";

export class GlmAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])glm([\/_-]|$)/i;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. Prefer simple solutions. Analyze the problem before coding. When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers or apologies.";

  readonly supportedReasoningModes = ["low", "high", "max"];
  readonly reasoningParameterFormat = "reasoning_effort" as const;
  readonly toolCallProtocol = "native-and-text" as const;

  isContentOnlyMode(mode: string): boolean {
    return mode === "none" || mode === "low";
  }

  applyReasoningMode(request: NimChatRequest, mode: string): void {
    if (mode === "high" || mode === "max") {
      request.reasoning_effort = mode;
    } else {
      request.reasoning_effort = "low";
    }
  }
}
