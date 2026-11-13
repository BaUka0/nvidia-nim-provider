import { createStructuredError, NvidiaApiError } from "../src/api/errors";
import { ContextLimitStore } from "../src/provider/context-limit-store";
import { buildLoopBreakerNudge, injectHistoryLoopBreaker } from "../src/provider/loop-breaker";
import { buildOverflowRetryRequest } from "../src/provider/overflow-compactor";
import { NimRequestBuilder } from "../src/provider/request-builder";
import { runStreamAttempt, StreamAttemptResult } from "../src/provider/stream-pump";
import { ModelTurnExecutor, ModelTurnInput } from "../src/provider/turn-executor";
import { ConfigManager, NimConfig } from "../src/shared/config";
import { FetchAttemptBudget } from "../src/shared/fetch-attempt-budget";
import { getTurnReports, resetTurnReportsForTests } from "../src/shared/turn-report";
import { makeToken } from "./helpers/fakes";

jest.mock("../src/provider/stream-pump", () => ({ runStreamAttempt: jest.fn() }));
jest.mock("../src/provider/request-builder", () => ({
  NimRequestBuilder: {
    prepareRequest: jest.fn(),
    applyRequestBudget: jest.fn((body: unknown) => body),
    hasImageInput: jest.fn(() => false),
    convertMessagesWithProfile: jest.fn(),
  },
}));
jest.mock("../src/provider/loop-breaker", () => ({
  injectHistoryLoopBreaker: jest.fn(({ requestBody }: { requestBody: unknown }) => requestBody),
  buildLoopBreakerNudge: jest.fn(),
}));
jest.mock("../src/provider/overflow-compactor", () => ({
  buildOverflowRetryRequest: jest.fn(),
}));
jest.mock("../src/shared/cancellation", () => ({
  ...jest.requireActual("../src/shared/cancellation"),
  waitForBackoff: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/shared/logging", () => ({
  ...jest.requireActual("../src/shared/logging"),
  debugLog: jest.fn(),
  outputLog: jest.fn(),
}));

const prepareRequestMock = NimRequestBuilder.prepareRequest as jest.Mock;
const runStreamAttemptMock = runStreamAttempt as jest.Mock;
const injectLoopBreakerMock = injectHistoryLoopBreaker as jest.Mock;
const buildNudgeMock = buildLoopBreakerNudge as jest.Mock;
const overflowCompactionMock = buildOverflowRetryRequest as jest.Mock;

function makePrepared() {
  return {
    requestBody: {
      model: "moonshotai/kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    },
    reasoningIsolationExpected: false,
    inputTokenCount: 12,
    requestedMaxTokens: 1024,
    temperatureVal: 1,
    toolsEnabled: false,
    tools: [],
  };
}

function makeResult(overrides: Partial<StreamAttemptResult> = {}): StreamAttemptResult {
  return {
    reportedContent: false,
    reportedVisibleContent: false,
    sawToolCall: false,
    emittedToolCall: false,
    emittedToolCalls: [],
    sawReasoning: false,
    lastFinishReason: "stop",
    lastUsage: undefined,
    lastVisibleText: "",
    lastReasoningText: "",
    skippedToolCalls: [],
    repetitionTripped: false,
    toolCallLoopTripped: false,
    streamChunkCount: 1,
    ...overrides,
  };
}

function makeConfig(network: Partial<NimConfig["network"]> = {}): NimConfig {
  const base = ConfigManager.getNimConfig();
  return { ...base, network: { ...base.network, ...network } };
}

function makeInput(nimConfig: NimConfig, overrides: Partial<ModelTurnInput> = {}): ModelTurnInput {
  return {
    model: {
      id: "moonshotai/kimi-k3",
      name: "Kimi K3",
      maxOutputTokens: 65536,
    } as never,
    messages: [{ role: 1, content: [{ value: "hi" }] }] as never,
    options: { tools: [] } as never,
    progress: { report: jest.fn() } as never,
    token: makeToken(),
    abortController: new AbortController(),
    fetchBudget: new FetchAttemptBudget(20),
    reportState: {
      hasReportedContent: false,
      hasReportedVisibleContent: false,
      failingAttemptHasVisibleContent: false,
    },
    apiKey: "nvapi-test",
    runtimeInfo: {
      supportsTools: false,
      supportsVision: false,
      contextWindow: 100000,
      runtimeMetadataSource: "fetched-model",
    },
    nimConfig,
    ...overrides,
  };
}

function executor(): ModelTurnExecutor {
  return new ModelTurnExecutor("test-ua", new ContextLimitStore());
}

describe("ModelTurnExecutor.executeTurn", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTurnReportsForTests();
    prepareRequestMock.mockResolvedValue(makePrepared());
    (NimRequestBuilder.applyRequestBudget as jest.Mock).mockImplementation((body: unknown) => body);
    injectLoopBreakerMock.mockImplementation(
      ({ requestBody }: { requestBody: unknown }) => requestBody,
    );
  });

  it("finishes the turn when the stream reports visible content", async () => {
    runStreamAttemptMock.mockResolvedValue(
      makeResult({ reportedVisibleContent: true, lastVisibleText: "Hello" }),
    );

    await expect(executor().executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();
    expect(runStreamAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("records the emitted tool calls and a tool-result request tail", async () => {
    runStreamAttemptMock.mockResolvedValue(
      makeResult({
        reportedVisibleContent: true,
        sawToolCall: true,
        emittedToolCall: true,
        emittedToolCalls: [{ id: "call_edit", name: "edit" }],
        lastFinishReason: "tool_calls",
      }),
    );
    const messages = [
      { role: 1, content: [{ value: "add logging" }] },
      { role: 2, content: [{ callId: "call_view", name: "view", input: {} }] },
      { role: 1, content: [{ callId: "call_view", content: [{ value: "file body" }] }] },
    ] as never;

    await executor().executeTurn(makeInput(makeConfig(), { messages }));

    expect(getTurnReports()[0]).toMatchObject({
      outcome: "ok",
      requestTail: "tool_result",
      emittedToolCalls: [{ id: "call_edit", name: "edit" }],
    });
  });

  it("marks a plain prompt as a user request tail", async () => {
    runStreamAttemptMock.mockResolvedValue(
      makeResult({ reportedVisibleContent: true, lastVisibleText: "Hello" }),
    );

    await executor().executeTurn(makeInput(makeConfig()));

    expect(getTurnReports()[0]).toMatchObject({ requestTail: "user", emittedToolCalls: [] });
  });

  it("retries an empty stream and then completes", async () => {
    runStreamAttemptMock
      .mockResolvedValueOnce(makeResult())
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Hi" }));

    const input = makeInput(makeConfig({ maxEmptyStreamRetries: 2 }));
    await expect(executor().executeTurn(input)).resolves.toBeUndefined();

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
  });

  it("passes the reasoning tail to the nudge when a stall happens mid-think", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "resume" });
    runStreamAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          reportedContent: true,
          sawReasoning: true,
          timedOut: true,
          lastFinishReason: undefined,
          lastReasoningText: "Next I patch flush().",
        }),
      )
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Done" }));

    await expect(executor().executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();

    expect(buildNudgeMock).toHaveBeenCalledWith("stream_timeout", {
      reasoningTail: "Next I patch flush().",
      reasoningLoop: false,
    });
  });

  it("auto-continues after a repetition loop and appends the nudge", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "continue now" });
    runStreamAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          reportedVisibleContent: true,
          repetitionTripped: true,
          trippedDetector: "lineCounter",
          lastVisibleText: "Let me check the file",
        }),
      )
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Done" }));

    await expect(executor().executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();

    expect(buildNudgeMock).toHaveBeenCalledWith("repetition_loop", {
      reasoningTail: undefined,
      reasoningLoop: false,
    });
    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
    const secondCall = runStreamAttemptMock.mock.calls[1][0];
    expect(secondCall.requestBody.messages).toHaveLength(2);
    expect(secondCall.requestBody.messages[1]).toEqual({
      role: "user",
      content: "continue now",
    });
    expect(getTurnReports()[0]).toMatchObject({
      outcome: "retry",
      repetitionTripped: true,
      trippedDetector: "lineCounter",
      autoContinueFired: true,
    });
  });

  it("uses answer repetition_loop nudge when visible answer repeat was suppressed after clean reasoning", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "answer continue" });
    runStreamAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          sawReasoning: true,
          reportedContent: true,
          reportedVisibleContent: false,
          repetitionTripped: true,
          reasoningRepetitionTripped: false,
          trippedDetector: "lineCounter",
          lastVisibleText: "",
          lastReasoningText: "Clean reasoning tail.",
        }),
      )
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Done" }));

    await expect(executor().executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();

    expect(buildNudgeMock).toHaveBeenCalledWith("repetition_loop", {
      reasoningTail: "Clean reasoning tail.",
      reasoningLoop: false,
    });
  });

  it("uses reasoningLoop nudge when reasoning itself tripped repetition", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "reasoning continue" });
    runStreamAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          sawReasoning: true,
          reportedContent: true,
          reportedVisibleContent: false,
          repetitionTripped: true,
          reasoningRepetitionTripped: true,
          trippedDetector: "lineCounter",
          lastVisibleText: "",
          lastReasoningText: "Repeating reasoning tail.",
        }),
      )
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Done" }));

    await expect(executor().executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();

    expect(buildNudgeMock).toHaveBeenCalledWith("repetition_loop", {
      reasoningTail: "Repeating reasoning tail.",
      reasoningLoop: true,
    });
  });

  it("fails with a structured error when the model only emits unusable tool calls", async () => {
    runStreamAttemptMock.mockResolvedValue(
      makeResult({
        sawToolCall: true,
        emittedToolCall: false,
        skippedToolCalls: [{ name: "unknown_tool", required: [] }],
      }),
    );

    await expect(
      executor().executeTurn(makeInput(makeConfig({ maxEmptyStreamRetries: 0 }))),
    ).rejects.toMatchObject({ kind: "empty_stream", operation: "invalid_tool_call" });
    expect(runStreamAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("restarts from a compacted request after a context overflow", async () => {
    const overflow = createStructuredError("context_overflow", "prompt is too long");
    runStreamAttemptMock
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Ok" }));
    overflowCompactionMock.mockResolvedValue({
      requestBody: {
        model: "moonshotai/kimi-k3",
        messages: [{ role: "user", content: "summary" }],
        max_tokens: 500,
      },
      compactedMaxOutput: 500,
      retryContextWindow: 64000,
    });
    const onOverflowCompaction = jest.fn();

    await expect(
      executor().executeTurn(makeInput(makeConfig(), { onOverflowCompaction })),
    ).resolves.toBeUndefined();

    expect(onOverflowCompaction).toHaveBeenCalledWith("Kimi K3");
    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
    expect(runStreamAttemptMock.mock.calls[1][0].requestBody.max_tokens).toBe(500);
  });

  it("surfaces the last transient error once retries are exhausted", async () => {
    const networkError = createStructuredError("network_error", "socket closed");
    runStreamAttemptMock.mockRejectedValue(networkError);

    await expect(executor().executeTurn(makeInput(makeConfig({ maxHttpRetries: 0 })))).rejects.toBe(
      networkError,
    );

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
    expect(networkError).toBeInstanceOf(NvidiaApiError);
  });

  it("charges fetchBudget 1-for-1 through onRetryAttempt passed to runStreamAttempt", async () => {
    const fetchBudget = new FetchAttemptBudget(2);
    runStreamAttemptMock.mockImplementationOnce(
      async (streamInput: { onRetryAttempt?: () => boolean }) => {
        expect(streamInput.onRetryAttempt).toBeDefined();
        expect(streamInput.onRetryAttempt?.()).toBe(true);
        expect(streamInput.onRetryAttempt?.()).toBe(false);
        return makeResult({ reportedVisibleContent: true, lastVisibleText: "Recovered" });
      },
    );

    await expect(
      executor().executeTurn(makeInput(makeConfig({ maxHttpRetries: 3 }), { fetchBudget })),
    ).resolves.toBeUndefined();
    expect(fetchBudget.remaining).toBe(0);
  });

  it("preserves finalUsage and totalAttempts when a post-output retry aborts on nudge budget overflow", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "continue" });
    (NimRequestBuilder.applyRequestBudget as jest.Mock).mockImplementationOnce(() => {
      throw createStructuredError("token_limit", "nudge exceeds context window");
    });

    const usage = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 };
    runStreamAttemptMock.mockResolvedValueOnce(
      makeResult({
        reportedVisibleContent: true,
        lastVisibleText: "Partial output",
        lastFinishReason: "length",
        lastUsage: usage,
      }),
    );

    const statusBar = { showTokenBreakdown: jest.fn() };
    const execWithStatus = new ModelTurnExecutor(
      "test-ua",
      new ContextLimitStore(),
      statusBar as never,
    );
    await expect(execWithStatus.executeTurn(makeInput(makeConfig()))).resolves.toBeUndefined();

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(1);
    expect(statusBar.showTokenBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ actualPromptTokens: 120, actualCompletionTokens: 45 }),
    );
  });

  it("preserves finalUsage and totalAttempts when a post-output retry aborts on exhausted fetchBudget", async () => {
    buildNudgeMock.mockReturnValue({ role: "user", content: "continue" });
    const fetchBudget = new FetchAttemptBudget(1);
    runStreamAttemptMock.mockResolvedValueOnce(
      makeResult({
        reportedVisibleContent: true,
        lastVisibleText: "Partial output",
        lastFinishReason: "length",
        lastUsage: { prompt_tokens: 95, completion_tokens: 40, total_tokens: 135 },
      }),
    );

    const statusBar = { showTokenBreakdown: jest.fn() };
    const execWithStatus = new ModelTurnExecutor(
      "test-ua",
      new ContextLimitStore(),
      statusBar as never,
    );
    await expect(
      execWithStatus.executeTurn(makeInput(makeConfig(), { fetchBudget })),
    ).resolves.toBeUndefined();

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(1);
    expect(statusBar.showTokenBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ actualPromptTokens: 95, actualCompletionTokens: 40 }),
    );
  });

  it("clears sticky invalid_tool_call retry reason once a non-invalid-tool retry supersedes it", async () => {
    const basePrepared = makePrepared();
    prepareRequestMock.mockResolvedValue({
      ...basePrepared,
      toolsEnabled: true,
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
    });
    buildNudgeMock.mockReturnValue({ role: "user", content: "continue after loop" });

    // Attempt 1: invalid_tool_call -> sets state.lastRetryReason = "invalid_tool_call"
    // Attempt 2: repetition_loop -> supersedes state.lastRetryReason and sets loop nudge
    // Attempt 3: nudge exceeds context budget -> must break cleanly instead of throwing invalid_tool_call exhaustion
    let applyCount = 0;
    (NimRequestBuilder.applyRequestBudget as jest.Mock).mockImplementation((body: unknown) => {
      applyCount += 1;
      // applyCount 1 = initial invalid_tool_call nudge on Attempt 2; applyCount 2 = loop nudge on Attempt 3
      if (applyCount >= 2) {
        throw createStructuredError("token_limit", "nudge exceeds budget");
      }
      return body;
    });

    runStreamAttemptMock
      .mockResolvedValueOnce(
        makeResult({
          sawToolCall: true,
          emittedToolCall: false,
          skippedToolCalls: [{ name: "read_file", required: ["filePath"] }],
          lastFinishReason: "tool_calls",
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          reportedVisibleContent: true,
          repetitionTripped: true,
          trippedDetector: "lineCounter",
          lastVisibleText: "Partial visible answer",
          lastUsage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
        }),
      );

    const statusBar = { showTokenBreakdown: jest.fn() };
    const execWithStatus = new ModelTurnExecutor(
      "test-ua",
      new ContextLimitStore(),
      statusBar as never,
    );
    await expect(
      execWithStatus.executeTurn(makeInput(makeConfig({ maxEmptyStreamRetries: 2 }))),
    ).resolves.toBeUndefined();

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
    expect(statusBar.showTokenBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ actualPromptTokens: 80, actualCompletionTokens: 30 }),
    );
  });
});
