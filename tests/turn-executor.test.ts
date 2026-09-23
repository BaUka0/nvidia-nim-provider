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

  it("retries an empty stream and then completes", async () => {
    runStreamAttemptMock
      .mockResolvedValueOnce(makeResult())
      .mockResolvedValueOnce(makeResult({ reportedVisibleContent: true, lastVisibleText: "Hi" }));

    const input = makeInput(makeConfig({ maxEmptyStreamRetries: 2 }));
    await expect(executor().executeTurn(input)).resolves.toBeUndefined();

    expect(runStreamAttemptMock).toHaveBeenCalledTimes(2);
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

    expect(buildNudgeMock).toHaveBeenCalledWith("repetition_loop");
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
});
