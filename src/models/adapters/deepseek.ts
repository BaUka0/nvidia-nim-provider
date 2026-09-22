import { BaseModelAdapter, ensureChatTemplateKwargs, resolveReasoningMode } from "./base";

export class DeepSeekAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])deepseek([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "low", "high", "max"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;
  // NVIDIA currently prefers native tool_calls for DeepSeek, but the provider
  // deliberately accepts DSML/text control-token fallbacks as a recovery path.
  readonly toolCallProtocol = "native-and-text" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    const kwargs = ensureChatTemplateKwargs(request);
    if (resolved === "none") {
      kwargs.thinking = false;
    } else {
      kwargs.thinking = true;
      kwargs.reasoning_effort = resolved;
    }
  }
}
