import { BaseModelAdapter, ensureChatTemplateKwargs, resolveReasoningMode } from "./base";

/**
 * MiniMax M3.1 Flash. Thinking mode is always adaptive (`<mm:think>...</mm:think>`)
 * and isolated into `reasoning_content` by the NIM parser. Reasoning effort is
 * configured via `chat_template_kwargs.reasoning_effort` (`low`, `medium`, `high`,
 * `xhigh`, `max`).
 */
export class MinimaxAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])minimax([\/_-]|$)/i;

  readonly supportedReasoningModes = ["low", "medium", "high", "xhigh", "max"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const kwargs = ensureChatTemplateKwargs(request);
    kwargs.reasoning_effort = resolveReasoningMode(mode, this.supportedReasoningModes);
  }
}
