import { BaseModelAdapter } from "./base";

export class DeepSeekAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])deepseek([\/_-]|$)/i;
  readonly defaultTemperature = 0;
  readonly toolTemperature = 0;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, either answer with normal user-facing text or emit a tool call. Use the native tool call format (tool_calls array in the API response). Do NOT emit tool calls as inline text markers (tool_call_begin, 伏, 第), plain JSON blocks, or markdown code fences masquerading as tool calls. Do not reveal internal control tokens, protocol markers, JSON fences, planning text, or DSML/tool_call markers in the user-visible response.";

  readonly supportedReasoningModes = ["none", "high", "max"];

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    if (mode === "none") {
      request.chat_template_kwargs.thinking = false;
    } else {
      request.chat_template_kwargs.thinking = true;
      request.chat_template_kwargs.reasoning_effort = mode;
    }
  }
}
