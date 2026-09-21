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
    timedOut: false,
    ...overrides,
  };
}

const baseFacts = {
  toolsEnabled: true,
  loopContinueCount: 0,
  maxLoopContinues: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
  invalidToolRetryCount: 0,
  emptyStreamRetryCount: 0,
  maxEmptyStreamRetries: 3,
  maxInvalidToolRetries: 2,
  fetchBudgetExhausted: false,
  knownToolNames: new Set<string>(["read_file"]),
};

describe("evaluateAttemptRetry", () => {
  it("does not treat text ending with a colon as a retryable loop", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Next I will call:",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("retries an empty stream before the empty-stream budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({ lastFinishReason: null }),
    });
    expect(evaluation.retryReason).toBe("empty_stream");
  });

  it("nudges instead of finishing when the only tool call repeats a completed read", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        sawToolCall: true,
        sawReasoning: true,
        reportedContent: true,
        emittedToolCall: false,
        reportedVisibleContent: false,
        lastFinishReason: "tool_calls",
        skippedToolCalls: [{ name: "read_file", required: [], reason: "duplicate" }],
      }),
    });
    expect(evaluation.retryReason).toBe("tool_call_loop");
  });

  it("does not turn a suppressed duplicate read into an empty-stream failover", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
      result: result({
        sawToolCall: true,
        sawReasoning: true,
        reportedContent: true,
        emittedToolCall: false,
        lastFinishReason: "tool_calls",
        skippedToolCalls: [{ name: "read_file", required: [], reason: "duplicate" }],
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("retries an empty stream when reasoning was emitted but no visible text or tool was produced", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        sawReasoning: true,
        reportedContent: true,
        reportedVisibleContent: false,
        emittedToolCall: false,
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBe("empty_stream");
  });

  it("does not retry an empty stream after the budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      emptyStreamRetryCount: 3,
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

  it("does not treat text ending with a colon as a loop after an earlier empty-stream retry", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      emptyStreamRetryCount: 1,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Next I will call:",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
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

  it("does not auto-continue when maxLoopContinues is 0", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      maxLoopContinues: 0,
      result: result({
        repetitionTripped: true,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix the formatting issue:",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("auto-continues a loop that tripped during reasoning before visible text", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        repetitionTripped: true,
        sawReasoning: true,
        reportedContent: true,
        reportedVisibleContent: false,
        lastVisibleText: "",
      }),
    });
    expect(evaluation.retryReason).toBe("repetition_loop");
  });

  it("auto-continues a stream stall after visible text", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        timedOut: true,
        reportedContent: true,
        reportedVisibleContent: true,
        lastVisibleText: "Working on the next change",
      }),
    });
    expect(evaluation.retryReason).toBe("stream_timeout");
  });

  it("auto-continues a stream stall that only produced reasoning", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        timedOut: true,
        sawReasoning: true,
        reportedContent: true,
        reportedVisibleContent: false,
        lastVisibleText: "",
      }),
    });
    expect(evaluation.retryReason).toBe("stream_timeout");
  });

  it("does not auto-continue a stream stall after a tool call was already emitted", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        timedOut: true,
        sawToolCall: true,
        emittedToolCall: true,
        reportedContent: true,
        reportedVisibleContent: true,
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("stops auto-continuing a stream stall after the same-turn loop budget is spent", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
      result: result({
        timedOut: true,
        reportedVisibleContent: true,
        lastVisibleText: "Working on the next change",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("does not treat ellipsis and em-dash as hanging punctuation loops", () => {
    const evalDots = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Let me check the repository...",
        lastFinishReason: "stop",
      }),
    });
    expect(evalDots.retryReason).toBeUndefined();

    const evalUnicodeDots = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Давайте проверим файлы…",
        lastFinishReason: "stop",
      }),
    });
    expect(evalUnicodeDots.retryReason).toBeUndefined();

    const evalDash = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "I will invoke the tool —",
        lastFinishReason: "stop",
      }),
    });
    expect(evalDash.retryReason).toBeUndefined();
  });

  it("allows natural language preambles without false-positive loop classification", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        reportedVisibleContent: true,
        lastVisibleText: "Let me read the page content to find the username and password fields.",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });
});
