import { NimChatMessage } from "../types";

export type LoopBreakerNudgeReason =
  | "repetition_loop"
  | "tool_call_loop"
  | "output_truncated"
  | "content_filter"
  | "stream_timeout";

const LOOP_BREAKER_NUDGES: Record<LoopBreakerNudgeReason, string> = {
  repetition_loop:
    "Continue working without repeating the previous output. Directly call the required tool or provide the final answer.",
  tool_call_loop:
    "Continue working. Vary the arguments, call a different tool, or provide the final answer. Do not repeat the previous tool call.",
  output_truncated:
    "Your previous reply was cut off at the output token limit. Continue from where you left off. Call a tool if needed or finish the answer.",
  content_filter:
    "Your previous reply was stopped by the safety filter. Continue the answer without the blocked content. Call a tool if needed or finish the answer. Do not mention the filter.",
  stream_timeout:
    "The previous reply stalled before completing. Continue working from where you left off. Call a tool if needed or provide the final answer.",
};

/**
 * Builds a clean, neutral continuation nudge for a mid-stream retry attempt.
 */
export function buildLoopBreakerNudge(reason: LoopBreakerNudgeReason): NimChatMessage {
  return { role: "user", content: LOOP_BREAKER_NUDGES[reason] };
}
