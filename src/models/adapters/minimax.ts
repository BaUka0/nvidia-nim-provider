import { BaseModelAdapter } from "./base";

export class MinimaxAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])minimax([\/_-]|$)/i;
  readonly defaultTemperature = 0.7;

  readonly supportedReasoningModes = ["none", "on"];

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    if (mode === "none") {
      request.chat_template_kwargs.enable_thinking = false;
    } else {
      request.chat_template_kwargs.enable_thinking = true;
    }
  }
}
