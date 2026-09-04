import { evaluateAttemptRetry } from "../src/provider/attempt-retry";
import { StreamAttemptResult } from "../src/provider/stream-pump";

function result(overrides: Partial<StreamAttemptResult> = {}): StreamAttemptResult {
  return {
    reportedContent: false,
    reportedVisibleContent: false,
    sawToolCall: false,
    emittedToolCall: false,
    sawReasoning: false,
    lastFinishReason: "stop",
    lastUsage: undefined,
    lastVisibleText: "",
    skippedToolCalls: [],
    repetitionTripped: false,
    streamChunkCount: 1,
    ...overrides,
  };
}

const baseFacts = {
  toolsEnabled: true,
  generationAutoContinueOnLoop: true,
  autoRetryInvalidCalls: true,
  hasRetriedRepetitionLoop: false,
  attemptIndex: 0,
  invalidToolRetryCount: 0,
  emptyStreamRetryCount: 0,
  maxEmptyStreamRetries: 2,
  maxInvalidToolRetries: 2,
  fetchBudgetExhausted: false,
  knownToolNames: new Set<string>(["read_file"]),
};

describe("evaluateAttemptRetry", () => {
  it("retries a hanging colon on the first attempt", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Next I will call:",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBe("hanging_colon");
  });

  it("retries an empty stream before the empty-stream budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({ lastFinishReason: null }),
    });
    expect(evaluation.retryReason).toBe("empty_stream");
  });

  it("does not retry an empty stream after the budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      emptyStreamRetryCount: 2,
      result: result({ lastFinishReason: null }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });
});
