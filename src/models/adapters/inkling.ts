import { BaseModelAdapter } from "./base";

export class InklingAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])inkling([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly supportedReasoningModes = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  readonly isolateUntaggedReasoning = false;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.reasoning_effort = this.supportedReasoningModes.includes(mode) ? mode : "none";
  }
}
