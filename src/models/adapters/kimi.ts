import { NimChatMessage } from "../../types";
import { ReasoningEffortAdapter } from "./base";

export class KimiAdapter extends ReasoningEffortAdapter {
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, invoke tools via native function calls with all required arguments. Emit concise user-facing text to explain results.";
  // Native tool_calls are preferred, while OpenAI-style text control tokens
  // remain accepted as a compatibility/recovery fallback.
  readonly toolCallProtocol = "native-and-text" as const;

  constructor() {
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
