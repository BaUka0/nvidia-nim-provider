import { BaseModelAdapter, resolveReasoningMode } from "./base";
import { NimChatRequest } from "../../types";

export class GlmAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])glm([\/_-]|$)/i;

  readonly supportedReasoningModes = ["low", "high", "max"];
  readonly reasoningParameterFormat = "reasoning_effort" as const;
  readonly toolCallProtocol = "native-and-text" as const;

  isContentOnlyMode(mode: string): boolean {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    return resolved === "low";
  }

  applyReasoningMode(request: NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    request.reasoning_effort = resolved;
  }
}
