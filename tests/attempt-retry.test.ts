import { evaluateAttemptRetry } from "../src/provider/attempt-retry";
import { StreamAttemptResult } from "../src/provider/stream-pump";
import { DEFAULT_GENERATION_CONFIG } from "../src/shared/config";

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
    toolCallLoopTripped: false,
    streamChunkCount: 1,
    ...overrides,
  };
}

const baseFacts = {
  toolsEnabled: true,
  generationAutoContinueOnLoop: true,
  autoRetryInvalidCalls: true,
  loopContinueCount: 0,
  maxLoopContinues: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
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

  it("does not retry after an in-stream tool-call loop that already emitted calls", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        toolCallLoopTripped: true,
        toolCallLoopKey: 'run_in_terminal:{"command":"npm run compile"}',
        sawToolCall: true,
        emittedToolCall: true,
        reportedContent: true,
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("nudges after an in-stream tool-call loop that emitted nothing", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        toolCallLoopTripped: true,
        toolCallLoopKey: 'read_file:{"filePath":"/tmp/a.ts"}',
        sawToolCall: true,
        emittedToolCall: false,
      }),
    });
    expect(evaluation.retryReason).toBe("tool_call_loop");
  });

  it("still auto-continues a hanging colon after an earlier empty-stream retry", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      emptyStreamRetryCount: 1,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Next I will call:",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBe("hanging_colon");
  });

  it("auto-continues a second loop within the same-turn budget", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: 1,
      result: result({
        repetitionTripped: true,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix the formatting issue:",
      }),
    });
    expect(evaluation.retryReason).toBe("repetition_loop");
  });

  it("stops auto-continuing after the same-turn loop budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
      result: result({
        repetitionTripped: true,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix the formatting issue:",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });
});
