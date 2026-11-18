import { NimChatMessage } from "../../types";
import { ReasoningEffortAdapter } from "./base";

export class KimiAdapter extends ReasoningEffortAdapter {
  // Native tool_calls are preferred, while OpenAI-style text control tokens
  // remain accepted as a compatibility/recovery fallback.
  readonly toolCallProtocol = "native-and-text" as const;
  // The NIM reference fixes top_p for Kimi K3 and does not expose it.
  override readonly topPSupported = false;

  constructor() {
    // Moonshot documents low, high, and max. A hosted probe of Kimi K3.1 Pro
    // (2026-11-18) showed "none" turns thinking off (0 reasoning tokens);
    // medium is accepted but undocumented, and xhigh is rejected with 400.
    super(/(^|[\/_-])kimi([\/_-]|$)/i, ["none", "low", "high", "max"]);
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
