import { BaseModelAdapter } from "./base";

export class MuseGlimmerAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])muse-glimmer([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly supportedReasoningModes = ["none", "low", "medium", "high", "xhigh"];
  readonly reasoningParameterFormat = "reasoning_effort" as const;
  readonly isolateUntaggedReasoning = false;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.reasoning_effort = this.supportedReasoningModes.includes(mode) ? mode : "none";
  }
}
