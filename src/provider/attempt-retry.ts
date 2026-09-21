import { StreamAttemptResult } from "./stream-pump";
import { buildInvalidToolCallRetryMessage } from "../tools/parser";

export type LoopRetryReason =
  | "repetition_loop"
  | "tool_call_loop"
  | "output_truncated"
  | "content_filter"
  | "stream_timeout";
export type RetryReason = LoopRetryReason | "invalid_tool_call" | "empty_stream";

export const LOOP_RETRY_REASONS: ReadonlySet<RetryReason> = new Set([
  "repetition_loop",
  "tool_call_loop",
  "output_truncated",
  "content_filter",
  "stream_timeout",
]);

export function isLoopRetryReason(reason: RetryReason | undefined): reason is LoopRetryReason {
  return reason !== undefined && LOOP_RETRY_REASONS.has(reason);
}

/**
 * The only action in the attempt was a read that history already completed.
 * Nothing was emitted, so Copilot would otherwise see a finished turn with no
 * tool and no answer and stop the agent.
 */
export function isSuppressedDuplicateStall(result: StreamAttemptResult): boolean {
  const hasVisibleText = Boolean(
    result.lastVisibleText && result.lastVisibleText.trim().length > 0,
  );
  return (
    !result.emittedToolCall &&
    !result.reportedVisibleContent &&
    !hasVisibleText &&
    result.skippedToolCalls.length > 0 &&
    result.skippedToolCalls.every((call) => call.reason === "duplicate")
  );
}

export interface AttemptRetryFacts {
  result: StreamAttemptResult;
  toolsEnabled: boolean;
  loopContinueCount: number;
  maxLoopContinues: number;
  invalidToolRetryCount: number;
  emptyStreamRetryCount: number;
  maxEmptyStreamRetries: number;
  maxInvalidToolRetries: number;
  fetchBudgetExhausted: boolean;
  knownToolNames: ReadonlySet<string>;
  timeoutRetryCount?: number;
  maxTimeoutRetries?: number;
}

export interface AttemptRetryEvaluation {
  isRepetitionLoop: boolean;
  isTruncatedLength: boolean;
  skippedUnknownTool: boolean;
  retryMessage: string | undefined;
  skippedToolCallNames: string[];
  /**
   * The single winning retry reason in branch order
   * (loop variants including stream stall → invalid tool call → empty stream),
   * or undefined when the attempt is final.
   */
  retryReason: RetryReason | undefined;
}

/**
 * Classify a finished stream attempt: which retry class (if any) applies.
 * Pure — evaluates repetition loops, tool call loops, truncation, content filters, and timeouts.
 */
export function evaluateAttemptRetry(facts: AttemptRetryFacts): AttemptRetryEvaluation {
  const { result } = facts;

  const isRepetitionLoop = Boolean(result.repetitionTripped);
  const isTruncatedLength =
    result.lastFinishReason === "length" && !result.sawToolCall && !result.emittedToolCall;

  const hasVisibleText = Boolean(
    result.lastVisibleText && result.lastVisibleText.trim().length > 0,
  );
  const loopAutoContinueEligible = facts.loopContinueCount < facts.maxLoopContinues;
  const willRetryRepetitionLoop =
    isRepetitionLoop && loopAutoContinueEligible && (hasVisibleText || result.sawReasoning);
  const suppressedDuplicateStall = isSuppressedDuplicateStall(result);
  const willRetryToolCallLoop =
    !willRetryRepetitionLoop &&
    !result.emittedToolCall &&
    loopAutoContinueEligible &&
    (Boolean(result.toolCallLoopTripped) || suppressedDuplicateStall);
  const willRetryTruncation =
    !willRetryRepetitionLoop &&
    !willRetryToolCallLoop &&
    isTruncatedLength &&
    loopAutoContinueEligible;
  const isContentFilterPartial =
    result.lastFinishReason === "content_filter" &&
    !result.sawToolCall &&
    !result.emittedToolCall &&
    hasVisibleText;
  const willRetryContentFilter =
    !willRetryRepetitionLoop &&
    !willRetryToolCallLoop &&
    !isTruncatedLength &&
    isContentFilterPartial &&
    loopAutoContinueEligible;
  const retryMessage = result.sawToolCall
    ? buildInvalidToolCallRetryMessage(result.skippedToolCalls)
    : undefined;
  const skippedUnknownTool =
    facts.knownToolNames.size > 0 &&
    result.skippedToolCalls.some(
      (call) =>
        call.name.length > 0 && call.name !== "tool_call" && !facts.knownToolNames.has(call.name),
    );
  const willRetryAfterInvalidToolCall =
    result.sawToolCall &&
    !result.emittedToolCall &&
    facts.invalidToolRetryCount < facts.maxInvalidToolRetries &&
    Boolean(retryMessage);
  const timeoutAutoContinueEligible =
    typeof facts.timeoutRetryCount === "number" && typeof facts.maxTimeoutRetries === "number"
      ? facts.timeoutRetryCount < facts.maxTimeoutRetries
      : loopAutoContinueEligible;
  const willRetryStreamTimeout =
    Boolean(result.timedOut) &&
    !result.emittedToolCall &&
    !willRetryAfterInvalidToolCall &&
    timeoutAutoContinueEligible;
  const willRetryOnLoop =
    willRetryRepetitionLoop ||
    willRetryToolCallLoop ||
    willRetryTruncation ||
    willRetryContentFilter ||
    willRetryStreamTimeout;
  const willRetryEmptyStream =
    !result.reportedVisibleContent &&
    !result.emittedToolCall &&
    result.skippedToolCalls.length === 0 &&
    !willRetryOnLoop &&
    !isRepetitionLoop &&
    !result.toolCallLoopTripped &&
    !result.timedOut &&
    facts.emptyStreamRetryCount < facts.maxEmptyStreamRetries &&
    !facts.fetchBudgetExhausted;

  const retryReason: RetryReason | undefined = willRetryOnLoop
    ? willRetryRepetitionLoop
      ? "repetition_loop"
      : willRetryToolCallLoop
        ? "tool_call_loop"
        : willRetryTruncation
          ? "output_truncated"
          : willRetryContentFilter
            ? "content_filter"
            : "stream_timeout"
    : willRetryAfterInvalidToolCall
      ? "invalid_tool_call"
      : willRetryEmptyStream
        ? "empty_stream"
        : undefined;

  return {
    isRepetitionLoop,
    isTruncatedLength,
    skippedUnknownTool,
    retryMessage,
    skippedToolCallNames: Array.from(new Set(result.skippedToolCalls.map((call) => call.name))),
    retryReason,
  };
}
