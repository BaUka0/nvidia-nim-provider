import { NimChatMessage } from "../../types";
import { BaseModelAdapter } from "./base";

export class KimiAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])kimi([\/_-]|$)/i;
  readonly defaultTemperature = 0.2;
  readonly toolTemperature = 0.1;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or a native tool call. Only emit tool calls through the designated tool_calls field; never write JSON arguments inline as markdown, backtick fences, or plain text. Every tool call must include ALL required arguments with correct types. Do not reveal chain-of-thought, reasoning scratchpads, or internal reasoning markers in the user-visible response.";

  applyMessagesWorkaround(messages: NimChatMessage[]): NimChatMessage[] {
    let patchedMessages: NimChatMessage[] | undefined;
    for (const [index, msg] of messages.entries()) {
      if (msg.role !== "assistant" || msg.reasoning_content) {
        continue;
      }
      patchedMessages ??= [...messages];
      patchedMessages[index] = { ...msg, reasoning_content: " " };
    }
    return patchedMessages ?? messages;
  }

  readonly supportedReasoningModes = ["none", "on"];

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    if (mode === "none") {
      request.chat_template_kwargs.thinking = false;
    } else {
      request.chat_template_kwargs.thinking = true;
    }
  }
}
