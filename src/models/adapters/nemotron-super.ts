import { ensureChatTemplateKwargs, resolveReasoningMode } from "./base";
import { NemotronFamilyAdapter } from "./nemotron";

export class NemotronSuperAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3-super([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "low", "high"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    const kwargs = ensureChatTemplateKwargs(request);
    if (resolved === "low") {
      kwargs.enable_thinking = true;
      kwargs.low_effort = true;
    } else if (resolved === "high") {
      kwargs.enable_thinking = true;
      delete kwargs.low_effort;
    } else {
      kwargs.enable_thinking = false;
      delete kwargs.low_effort;
    }
  }
}
