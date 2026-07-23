import { BaseModelAdapter } from "./base";

export class LagunaAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])laguna([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly supportedReasoningModes = ["none", "on"];
  // Laguna exposes reasoning separately when available. Plain content is a
  // user-visible answer and must not be hidden as thinking when no reasoning
  // field is present in a response.
  readonly isolateUntaggedReasoning = false;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    request.chat_template_kwargs.enable_thinking = mode === "on";
  }

  sanitizeResponseText(text: string): string {
    if (text.trim() === "∆") {
      return "";
    }
    return text.replace(/\s+∆\s*$/u, "");
  }
}
