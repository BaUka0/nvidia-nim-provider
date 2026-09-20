import { BaseModelAdapter, ensureChatTemplateKwargs } from "./base";

export class DeepSeekAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])deepseek([\/_-]|$)/i;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, invoke the required tool directly via native function calls to inspect code or perform actions. Emit user-facing text only when no tools are needed or to explain completed actions.";

  readonly supportedReasoningModes = ["none", "high", "max"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;
  // NVIDIA currently prefers native tool_calls for DeepSeek, but the provider
  // deliberately accepts DSML/text control-token fallbacks as a recovery path.
  readonly toolCallProtocol = "native-and-text" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const kwargs = ensureChatTemplateKwargs(request);
    if (mode === "none") {
      kwargs.thinking = false;
    } else {
      kwargs.thinking = true;
      kwargs.reasoning_effort = mode;
    }
  }
}
