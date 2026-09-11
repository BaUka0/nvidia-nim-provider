import { StreamAttemptResult } from "./stream-pump";
import { buildInvalidToolCallRetryMessage } from "../tools/parser";

export type LoopRetryReason =
  | "repetition_loop"
  | "tool_call_loop"
  | "hanging_colon"
  | "output_truncated"
  | "content_filter";
export type RetryReason = LoopRetryReason | "invalid_tool_call" | "empty_stream";

export const LOOP_RETRY_REASONS: ReadonlySet<RetryReason> = new Set([
  "repetition_loop",
  "tool_call_loop",
  "hanging_colon",
  "output_truncated",
  "content_filter",
]);

export function isLoopRetryReason(reason: RetryReason | undefined): reason is LoopRetryReason {
  return reason !== undefined && LOOP_RETRY_REASONS.has(reason);
}

export interface AttemptRetryFacts {
  result: StreamAttemptResult;
  toolsEnabled: boolean;
  generationAutoContinueOnLoop: boolean;
  autoRetryInvalidCalls: boolean;
  loopContinueCount: number;
  maxLoopContinues: number;
  invalidToolRetryCount: number;
  emptyStreamRetryCount: number;
  maxEmptyStreamRetries: number;
  maxInvalidToolRetries: number;
  fetchBudgetExhausted: boolean;
  knownToolNames: ReadonlySet<string>;
}

export interface AttemptRetryEvaluation {
  isRepetitionLoop: boolean;
  isHangingColon: boolean;
  isTruncatedLength: boolean;
  skippedUnknownTool: boolean;
  retryMessage: string | undefined;
  skippedToolCallNames: string[];
  /**
   * The single winning retry reason in branch order
   * (loop variants → invalid tool call → empty stream), or undefined when
   * the attempt is final.
   */
  retryReason: RetryReason | undefined;
}

/**
 * Classify a finished stream attempt: which retry class (if any) applies.
 * Pure — every branch and gate below mirrors the original inline predicates.
 */
export function evaluateAttemptRetry(facts: AttemptRetryFacts): AttemptRetryEvaluation {
  const { result } = facts;

  const isRepetitionLoop = Boolean(result.repetitionTripped);
  const isHangingColon =
    !isRepetitionLoop &&
    !result.sawToolCall &&
    !result.emittedToolCall &&
    result.reportedVisibleContent &&
    facts.toolsEnabled &&
    result.lastVisibleText.trimEnd().endsWith(":") &&
    (result.lastFinishReason === "stop" ||
      result.lastFinishReason === null ||
      result.lastFinishReason === undefined);
  const isTruncatedLength =
    result.lastFinishReason === "length" && !result.sawToolCall && !result.emittedToolCall;

  const hasVisibleText = Boolean(
    result.lastVisibleText && result.lastVisibleText.trim().length > 0,
  );
  const loopAutoContinueEligible =
    facts.generationAutoContinueOnLoop && facts.loopContinueCount < facts.maxLoopContinues;
  const willRetryRepetitionLoop = isRepetitionLoop && loopAutoContinueEligible && hasVisibleText;
  const willRetryToolCallLoop =
    !willRetryRepetitionLoop &&
    Boolean(result.toolCallLoopTripped) &&
    !result.emittedToolCall &&
    loopAutoContinueEligible;
  const willRetryHangingColon =
    !isRepetitionLoop && !willRetryToolCallLoop && isHangingColon && loopAutoContinueEligible;
  const willRetryTruncation =
    !isRepetitionLoop &&
    !willRetryToolCallLoop &&
    !isHangingColon &&
    isTruncatedLength &&
    loopAutoContinueEligible;
  const isContentFilterPartial =
    result.lastFinishReason === "content_filter" &&
    !result.sawToolCall &&
    !result.emittedToolCall &&
    hasVisibleText;
  const willRetryContentFilter =
    !isRepetitionLoop &&
    !willRetryToolCallLoop &&
    !isHangingColon &&
    !isTruncatedLength &&
    isContentFilterPartial &&
    loopAutoContinueEligible;
  const willRetryOnLoop =
    willRetryRepetitionLoop ||
    willRetryToolCallLoop ||
    willRetryHangingColon ||
    willRetryTruncation ||
    willRetryContentFilter;

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
    facts.autoRetryInvalidCalls &&
    result.sawToolCall &&
    !result.emittedToolCall &&
    facts.invalidToolRetryCount < facts.maxInvalidToolRetries &&
    Boolean(retryMessage);
  const willRetryEmptyStream =
    !result.sawReasoning &&
    !result.sawToolCall &&
    !result.reportedVisibleContent &&
    !result.emittedToolCall &&
    facts.emptyStreamRetryCount < facts.maxEmptyStreamRetries &&
    !facts.fetchBudgetExhausted;

  const retryReason: RetryReason | undefined = willRetryOnLoop
    ? willRetryRepetitionLoop
      ? "repetition_loop"
      : willRetryToolCallLoop
        ? "tool_call_loop"
        : willRetryHangingColon
          ? "hanging_colon"
          : willRetryTruncation
            ? "output_truncated"
            : "content_filter"
    : willRetryAfterInvalidToolCall
      ? "invalid_tool_call"
      : willRetryEmptyStream
        ? "empty_stream"
        : undefined;

  return {
    isRepetitionLoop,
    isHangingColon,
    isTruncatedLength,
    skippedUnknownTool,
    retryMessage,
    skippedToolCallNames: Array.from(new Set(result.skippedToolCalls.map((call) => call.name))),
    retryReason,
  };
}
