import { createStructuredError, NvidiaApiError } from "../api/errors";
import { debugLog, outputLog } from "../shared/logging";
import { NimChatMessage, NimChatRequest } from "../types";
import {
  AttemptRetryEvaluation,
  isLoopRetryReason,
  LoopRetryReason,
  RetryReason,
} from "./attempt-retry";
import { StreamAttemptResult } from "./stream-pump";
import type { ChatRuntimeMetadataSource } from "./turn-executor";

/** Mutable attempt-loop state; recreated on every restart of the failover chain. */
export interface AttemptLoopState {
  retryNudge?: NimChatMessage;
  lastRetryReason?: "invalid_tool_call";
  lastInvalidToolSkipNames: string[];
  transientRetryCount: number;
  lastTransientError: unknown;
  emptyStreamRetryCount: number;
  loopContinueCount: number;
  invalidToolRetryCount: number;
  attemptCompleted: boolean;
  previousPreamblePrefixes: string[];
}

export function createAttemptLoopState(): AttemptLoopState {
  return {
    lastInvalidToolSkipNames: [],
    transientRetryCount: 0,
    lastTransientError: undefined,
    emptyStreamRetryCount: 0,
    loopContinueCount: 0,
    invalidToolRetryCount: 0,
    attemptCompleted: false,
    previousPreamblePrefixes: [],
  };
}

/** What the caller should do after a stream attempt threw. */
export type StreamFailureOutcome =
  | { action: "retry" }
  | {
      action: "restart";
      requestBody: NimChatRequest;
      compactedMaxOutput: number;
      retryContextWindow: number;
    };

/** What the caller should do after a stream attempt completed. */
export interface AttemptDispatch {
  action: "continue" | "complete" | "abort";
  baselineRequestBody: NimChatRequest;
}

const LOOP_REASON_LABELS: Record<string, string> = {
  repetition_loop: "repetition loop",
  tool_call_loop: "repeated tool call",
  hanging_colon: "hanging punctuation",
  content_filter: "content filter",
  stream_timeout: "stream stall",
};

export function logAttemptTiming(input: {
  attempt: number;
  totalAttempts: number;
  modelId: string;
  attemptStartedAtMs: number;
  requestPreparationDurationMs?: number;
  toolParsingStateInitDurationMs?: number;
  retryReasonHistory: readonly string[];
  inputTokenCount: number;
  requestedMaxTokens: number;
  temperatureVal: number | undefined;
  toolsEnabled: boolean;
  runtimeMetadataSource: ChatRuntimeMetadataSource;
  skippedToolCallNames: readonly string[];
  lastRetryReason?: "invalid_tool_call";
  retryReason: RetryReason | undefined;
  evaluation: AttemptRetryEvaluation;
  result: StreamAttemptResult;
  loopContinueCount: number;
  emptyStreamRetryCount: number;
}): void {
  const { result } = input;
  if (result.firstResponseAtMs === undefined) {
    return;
  }
  const totalDurationMs = Date.now() - input.attemptStartedAtMs;
  const generationDurationMs = Math.max(
    0,
    totalDurationMs - (result.firstResponseAtMs - input.attemptStartedAtMs),
  );
  const promptTokens = result.lastUsage?.prompt_tokens;
  const completionTokens = result.lastUsage?.completion_tokens;
  const totalTokens = result.lastUsage?.total_tokens;
  const retryReason = input.retryReason;
  debugLog("stream timing", {
    attempt: input.attempt + 1,
    totalAttempts: input.totalAttempts,
    ...(input.requestPreparationDurationMs !== undefined
      ? { requestPreparationDurationMs: input.requestPreparationDurationMs }
      : {}),
    ...(input.toolParsingStateInitDurationMs !== undefined
      ? { toolParsingStateInitDurationMs: input.toolParsingStateInitDurationMs }
      : {}),
    ...(input.retryReasonHistory.length > 0
      ? { retryReasonHistory: [...input.retryReasonHistory] }
      : {}),
    model: input.modelId,
    inputTokenCount: input.inputTokenCount,
    requestedMaxTokens: input.requestedMaxTokens,
    temperature: input.temperatureVal,
    toolsEnabled: input.toolsEnabled,
    runtimeMetadataSource: input.runtimeMetadataSource,
    isRetryAttempt: input.attempt > 0,
    willRetryAfterInvalidToolCall: retryReason === "invalid_tool_call",
    skippedToolCallCount: result.skippedToolCalls.length,
    ...(input.skippedToolCallNames.length > 0
      ? { skippedToolCallNames: [...input.skippedToolCallNames] }
      : {}),
    ...(input.lastRetryReason || retryReason
      ? { retryReason: input.lastRetryReason ?? retryReason }
      : {}),
    firstTokenLatencyMs: result.firstResponseAtMs - input.attemptStartedAtMs,
    ...(result.firstToolCallAtMs !== undefined
      ? { firstToolCallLatencyMs: result.firstToolCallAtMs - input.attemptStartedAtMs }
      : {}),
    totalDurationMs,
    generationDurationMs,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(completionTokens !== undefined && generationDurationMs > 0
      ? {
          completionTokensPerSecond: Number(
            (completionTokens / (generationDurationMs / 1000)).toFixed(2),
          ),
        }
      : {}),
    reportedContent: result.reportedContent,
    reportedVisibleContent: result.reportedVisibleContent,
    emittedToolCall: result.emittedToolCall,
    sawReasoning: result.sawReasoning,
    lastFinishReason: result.lastFinishReason,
    streamChunkCount: result.streamChunkCount,
    willRetryEmptyStream: retryReason === "empty_stream",
    willRetryOnLoop: isLoopRetryReason(retryReason),
    willRetryContentFilter: retryReason === "content_filter",
    skippedUnknownTool: input.evaluation.skippedUnknownTool,
    isRepetitionLoop: input.evaluation.isRepetitionLoop,
    isHangingColon: input.evaluation.isHangingColon,
    loopContinueCount: input.loopContinueCount,
    emptyStreamRetryCount: input.emptyStreamRetryCount,
  });
}

export function logStreamFinished(input: {
  attempt: number;
  totalAttempts: number;
  modelId: string;
  result: StreamAttemptResult;
  retryReason: RetryReason | undefined;
  evaluation: AttemptRetryEvaluation;
  emptyStreamRetryCount: number;
}): void {
  const { result, retryReason, evaluation } = input;
  debugLog("stream finished", {
    attempt: input.attempt + 1,
    totalAttempts: input.totalAttempts,
    model: input.modelId,
    reportedContent: result.reportedContent,
    reportedVisibleContent: result.reportedVisibleContent,
    emittedToolCall: result.emittedToolCall,
    sawToolCall: result.sawToolCall,
    sawReasoning: result.sawReasoning,
    lastFinishReason: result.lastFinishReason,
    streamChunkCount: result.streamChunkCount,
    willRetryAfterInvalidToolCall: retryReason === "invalid_tool_call",
    willRetryEmptyStream: retryReason === "empty_stream",
    willRetryOnLoop: isLoopRetryReason(retryReason),
    isRepetitionLoop: evaluation.isRepetitionLoop,
    isHangingColon: evaluation.isHangingColon,
    isTruncatedLength: evaluation.isTruncatedLength,
    emptyStreamRetryCount: input.emptyStreamRetryCount,
  });
}

export function logLoopAutoContinue(input: {
  modelId: string;
  retryReason: LoopRetryReason;
  result: StreamAttemptResult;
  loopContinueCount: number;
}): void {
  const { result, retryReason } = input;
  debugLog("repetitionGuard", {
    action: "autoContinue",
    trippedLine: result.trippedLine,
    detector: result.trippedDetector,
    lastVisibleText: result.lastVisibleText,
    reason: retryReason,
    loopContinueCount: input.loopContinueCount,
  });
  const loopLabel = LOOP_REASON_LABELS[retryReason] ?? "truncated output";
  const tripped = result.trippedLine ?? result.toolCallLoopKey ?? result.lastVisibleText;
  outputLog(
    "repetitionGuard",
    `Auto-continue after ${loopLabel} on ${input.modelId}: "${tripped.slice(0, 80)}"`,
  );
}

export function buildEmptyStreamError(input: {
  modelLabel: string;
  totalAttempts: number;
  everSawReasoning: boolean;
  lastFinishReasonOverall: string | null | undefined;
}): NvidiaApiError {
  return createStructuredError(
    "empty_stream",
    [
      `Model: ${input.modelLabel}`,
      `Attempts: ${input.totalAttempts}`,
      input.everSawReasoning
        ? "The model emitted reasoning but no visible answer or tool call."
        : "The model returned no text, tool call, or reasoning.",
      input.lastFinishReasonOverall !== undefined
        ? `Last finish_reason: ${String(input.lastFinishReasonOverall)}`
        : null,
      "Try again, reduce reasoning effort, or switch to a different model.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
