import { evaluateAttemptRetry } from "../src/provider/attempt-retry";
import { StreamAttemptResult } from "../src/provider/stream-pump";
import { RepetitionGuard } from "../src/provider/repetition-guard";
import { DEFAULT_GENERATION_CONFIG } from "../src/shared/config";
import { detectHistoryLoop, injectHistoryLoopBreaker } from "../src/provider/loop-breaker";

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

/**
 * Regression lock for issue #7 (Nemotron infinite looping) after heuristic
 * removals in 314802f (hanging_colon, preamble prefix, history breaker) and
 * 92271e5 (sampling penalties).
 *
 * Tests that PASS document current (possibly weakened) behavior.
 * Tests marked as documenting a known gap assert the current output and
 * explain which old heuristic used to cover the case.
 */
describe("nemotron loop regression (#7)", () => {
  it("verbatim Let me loop still trips the in-stream guard", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    let tripped = false;
    for (let i = 0; i < 4; i += 1) {
      tripped = guard.add("Let me fix the formatting issue\n");
    }
    expect(tripped).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("reasoning-only repetition still qualifies for loop auto-continue", () => {
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

  it("varied preamble with same 2-word prefix trips prefix cycle detector and retries", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    guard.add("Let me check the file A\n");
    guard.add("Let me check the file B\n");
    guard.add("Let me check the file C\n");
    expect(guard.tripped).toBe(true);

    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        repetitionTripped: guard.tripped,
        reportedVisibleContent: true,
        lastVisibleText: "Let me check the file C",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBe("repetition_loop");
  });

  it("GAP: hanging colon preamble does NOT retry without hanging_colon heuristic", () => {
    // Pre-314802f hasHangingPunctuation(":","...","…","—","--") + finish stop
    // would yield hanging_colon retry. Removed intentionally to cut false
    // positives; Nemotron stall on ":" now completes the turn as-is.
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

  it("reasoning-only empty turn now retries as empty_stream (post-314802f behavior)", () => {
    // Pre-314802f: !sawReasoning blocked empty retry. Now reasoning-only
    // with finish=stop retries up to maxEmptyStreamRetries.
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        sawReasoning: true,
        reportedContent: true,
        reportedVisibleContent: false,
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBe("empty_stream");
  });

  it("loop budget fallback: when timeoutRetryCount is omitted, stalls consume loop budget", () => {
    const afterStalls = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
      result: result({
        repetitionTripped: true,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix it",
      }),
    });
    expect(afterStalls.retryReason).toBeUndefined();
  });

  it("timeout retries do not starve repetition loop when timeoutRetryCount is tracked separately", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: 0,
      timeoutRetryCount: 2,
      maxTimeoutRetries: 2,
      result: result({
        repetitionTripped: true,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix it",
      }),
    });
    expect(evaluation.retryReason).toBe("repetition_loop");
  });

  it("repetition loop does not fall through to empty_stream when loop budget is exhausted", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      loopContinueCount: DEFAULT_GENERATION_CONFIG.maxLoopContinues,
      emptyStreamRetryCount: 0,
      result: result({
        repetitionTripped: true,
        sawReasoning: true,
        reportedContent: true,
        reportedVisibleContent: false,
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("tool-call loop that already emitted calls stops instead of retrying", () => {
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        toolCallLoopTripped: true,
        toolCallLoopKey: 'read_file:{"filePath":"/tmp/a.ts"}',
        sawToolCall: true,
        emittedToolCall: true,
        reportedContent: true,
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();
  });

  it("tool-call loop with nothing emitted requests a nudge within budget", () => {
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

  it("inter-turn preamble loop across turns is caught and broken by injectHistoryLoopBreaker", () => {
    // A single preamble does not trip per-attempt repetitionTripped by itself:
    const evaluation = evaluateAttemptRetry({
      ...baseFacts,
      result: result({
        repetitionTripped: false,
        reportedVisibleContent: true,
        lastVisibleText: "Let me fix the formatting issue",
        lastFinishReason: "stop",
      }),
    });
    expect(evaluation.retryReason).toBeUndefined();

    // But across turns, history loop detection catches repeated preambles and injects guidance:
    const history = [
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
    ];
    const loop = detectHistoryLoop(history);
    expect(loop).toBeDefined();

    const request = injectHistoryLoopBreaker({
      requestBody: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [{ role: "user", content: "proceed" }],
      },
      historyMessages: history,
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      applyBudget: (b) => b,
    });
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1].role).toBe("user");
    expect(request.messages[1].content).toContain("repeated the preamble");
    expect(request.messages[1].content).not.toContain("[NIM_LOOP_BREAKER]");
  });
});
