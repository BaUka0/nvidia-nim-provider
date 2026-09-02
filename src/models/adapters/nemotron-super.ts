import { NemotronFamilyAdapter } from "./nemotron";

export class NemotronSuperAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3-super([\/_-]|$)/i;

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
