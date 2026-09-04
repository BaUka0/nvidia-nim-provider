import { ensureChatTemplateKwargs } from "./base";
import { NemotronFamilyAdapter } from "./nemotron";

export class NemotronSuperAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3-super([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "low", "high"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const kwargs = ensureChatTemplateKwargs(request);
    if (mode === "low") {
      kwargs.enable_thinking = true;
      kwargs.low_effort = true;
    } else if (mode === "high") {
      kwargs.enable_thinking = true;
      delete kwargs.low_effort;
    } else {
      kwargs.enable_thinking = false;
      delete kwargs.low_effort;
    }
  }
}
