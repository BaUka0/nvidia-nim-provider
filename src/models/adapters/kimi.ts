import { NimChatMessage } from "../../types";
import { assignReasoningEffort, BaseModelAdapter } from "./base";

export class KimiAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])kimi([\/_-]|$)/i;
  readonly defaultTemperature = 0.2;
  readonly toolTemperature = 0.1;
  readonly supportsPresencePenalty = false;
  readonly supportsFrequencyPenalty = false;
  readonly toolSystemMessage =
    "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, answer with concise user-facing text or a native tool call. Only emit tool calls through the designated tool_calls field; never write JSON arguments inline as markdown, backtick fences, or plain text. Every tool call must include ALL required arguments with correct types. Do not reveal chain-of-thought, reasoning scratchpads, or internal reasoning markers in the user-visible response.";

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

  readonly supportedReasoningModes = ["none", "low", "high", "max"];
  readonly reasoningParameterFormat = "reasoning_effort" as const;
  // Native tool_calls are preferred, while OpenAI-style text control tokens
  // remain accepted as a compatibility/recovery fallback.
  readonly toolCallProtocol = "native-and-text" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    assignReasoningEffort(request, mode, this.supportedReasoningModes);
  }
}
