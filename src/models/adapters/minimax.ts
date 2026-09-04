import { BaseModelAdapter, ensureChatTemplateKwargs } from "./base";

export class MinimaxAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])minimax([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "on", "adaptive"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const kwargs = ensureChatTemplateKwargs(request);
    if (mode === "none") {
      kwargs.thinking_mode = "disabled";
    } else if (mode === "adaptive") {
      kwargs.thinking_mode = "adaptive";
    } else {
      kwargs.thinking_mode = "enabled";
    }
  }
}
