import { NimChatMessage } from "../../types";
import { ReasoningEffortAdapter } from "./base";

export class KimiAdapter extends ReasoningEffortAdapter {
  // Native tool_calls are preferred, while OpenAI-style text control tokens
  // remain accepted as a compatibility/recovery fallback.
  readonly toolCallProtocol = "native-and-text" as const;
  // The NIM reference fixes top_p for Kimi K3 and does not expose it.
  override readonly topPSupported = false;

  constructor() {
    // Thinking is always on; the endpoint accepts only low, high, or max.
    super(/(^|[\/_-])kimi([\/_-]|$)/i, ["low", "high", "max"]);
  }

  applyMessagesWorkaround(messages: NimChatMessage[]): NimChatMessage[] {
    let patchedMessages: NimChatMessage[] | undefined;
    for (const [index, msg] of messages.entries()) {
      if (
        msg.role !== "assistant" ||
        !Array.isArray(msg.tool_calls) ||
        msg.tool_calls.length === 0 ||
        (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim().length > 0)
      ) {
        continue;
      }
      patchedMessages ??= [...messages];
      patchedMessages[index] = { ...msg, reasoning_content: " " };
    }
    return patchedMessages ?? messages;
  }
}
