import { BaseModelAdapter, ensureChatTemplateKwargs } from "./base";

export class DeepSeekAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])deepseek([\/_-]|$)/i;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, emit tool calls directly whenever an action, inspection, or tool execution is needed. Do not output conversational planning, narrations of intended actions, or preambles in place of calling tools. Answer with normal text only when no tools are needed to satisfy the request. Use the native tool call format (tool_calls array in the API response). Do NOT emit tool calls as inline text markers (tool_call_begin, 伏, 第), plain JSON blocks, or markdown code fences masquerading as tool calls. Do not reveal internal control tokens, protocol markers, JSON fences, planning text, or DSML/tool_call markers in the user-visible response.";

  readonly supportedReasoningModes = ["none", "low", "high", "max"];
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
