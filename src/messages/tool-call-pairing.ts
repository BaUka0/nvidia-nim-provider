import { NimChatMessage } from "../types";

/**
 * Index of the assistant message whose `tool_calls` own the given tool
 * result id, or -1. Sending an orphan `tool_call_id` is rejected by many
 * OpenAI-compatible endpoints, so callers keep owners and results together.
 */
export function findToolCallOwnerIndex(
  messages: readonly NimChatMessage[],
  toolCallId: string,
): number {
  return messages.findIndex(
    (candidate) =>
      candidate.role === "assistant" &&
      candidate.tool_calls?.some((call) => call.id === toolCallId),
  );
}

/**
 * Grow `selected` to a fixpoint so no tool result is kept without its owner
 * and no owner is kept without its results.
 */
export function pairToolCallsAndResults(
  messages: readonly NimChatMessage[],
  selected: Set<NimChatMessage>,
): void {
  let pairChanged = true;
  while (pairChanged) {
    pairChanged = false;
    for (const message of messages) {
      if (message.role === "tool" && selected.has(message) && message.tool_call_id) {
        const ownerIndex = findToolCallOwnerIndex(messages, message.tool_call_id);
        const owner = ownerIndex >= 0 ? messages[ownerIndex] : undefined;
        if (owner && !selected.has(owner)) {
          selected.add(owner);
          pairChanged = true;
        }
      }
      if (message.role === "assistant" && selected.has(message) && message.tool_calls?.length) {
        for (const result of messages) {
          if (
            result.role === "tool" &&
            result.tool_call_id &&
            message.tool_calls.some((call) => call.id === result.tool_call_id) &&
            !selected.has(result)
          ) {
            selected.add(result);
            pairChanged = true;
          }
        }
      }
    }
  }
}
