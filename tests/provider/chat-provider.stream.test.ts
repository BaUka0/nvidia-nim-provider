import * as vscode from "vscode";
import { fetchModels, streamChatCompletion } from "../../src/api/client";
import { CONTEXT_WINDOW_SAFETY_MARGIN } from "../../src/shared/constants";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { LOOP_BREAKER_MARKER } from "../../src/provider/loop-breaker";
import { CONTENT_FILTER_NOTICE, OUTPUT_TRUNCATED_NOTICE } from "../../src/provider/stream-pump";
import { ApiErrorKind, NvidiaApiError } from "../../src/api/errors";
import { getApiKeyFingerprint } from "../../src/api/key-resolver";
import {
  getLanguageModelThinkingPart,
  asCancellationToken,
  makeChatOptions,
  makeMemento,
  makeMessages,
  makeModel,
  makeSecrets,
  makeToken,
  makeUserMessages,
} from "../helpers/fakes";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
} from "../../src/shared/constants";
import { getTurnReports, resetTurnReportsForTests } from "../../src/shared/turn-report";
import { setDeveloperLogOptions } from "../../src/shared/logging";

jest.mock("../../src/api/client", () => ({
  fetchModels: jest.fn(),
  streamChatCompletion: jest.fn(),
}));

jest.mock("vscode", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../helpers/vscode-provider-mock").createProviderVscodeMock();
});

describe("NimChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let globalState: vscode.Memento;
  let provider: NimChatModelProvider;

  const ThinkingPart = getLanguageModelThinkingPart(vscode);

  beforeEach(() => {
    jest.clearAllMocks();
    resetTurnReportsForTests();
    setDeveloperLogOptions({ logStreamChunks: false, logUserMessages: false });
    secrets = makeSecrets();
    globalState = makeMemento((key) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "kimi-k2.6",
              displayName: "Kimi K2.6",
              contextWindow: 262144,
              maxOutputTokens: 262144,
              supportsTools: true,
              supportsVision: true,
            },
            {
              id: "meta/llama-4-maverick-17b-128e-instruct",
              displayName: "Llama 4 Maverick 17B 128E Instruct",
              contextWindow: 131072,
              maxOutputTokens: 16384,
              supportsTools: true,
              supportsVision: false,
            },
          ]
        : undefined,
    );
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    }));
  });

  it("provideLanguageModelChatResponse streams text parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello" } }] };
      yield { choices: [{ delta: { content: " world" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
      expect.objectContaining({ maxOutputTokens: 65536 }),
    );
    expect(progress.report).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: "Hello" }));
    expect(progress.report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ value: " world" }),
    );
    expect(getTurnReports()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "ok",
          modelId: "kimi-k2.6",
          lastVisibleTextHead: "Hello world",
          sawToolCall: false,
          emittedToolCall: false,
        }),
      ]),
    );
  });

  it("strips think tags even when the stream splits tag boundaries", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "<th" } }] };
      yield { choices: [{ delta: { content: "ink>hidden" } }] };
      yield { choices: [{ delta: { content: "</th" } }] };
      yield { choices: [{ delta: { content: "ink>表示テキスト" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "nim-any-model", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );
    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);

    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "表示テキスト" }));
    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "hidden" }));
  });

  it("emits reasoning_content deltas as live thinking parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Let me think" } }] };
      yield { choices: [{ delta: { reasoning_content: " about it" } }] };
      yield { choices: [{ delta: { content: "Answer" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(2);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "Let me think" }));
    expect(thinkingReports[1][0]).toEqual(expect.objectContaining({ value: " about it" }));
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "Answer" }));
  });

  it("emits reasoning_content before content when both arrive in the same chunk", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Thinking" } }] };
      yield {
        choices: [
          {
            delta: {
              reasoning_content: " final thought",
              content: "Answer",
            },
          },
        ],
      };
      yield { choices: [{ delta: { content: " continued" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingIndices = allReports
      .map((r, i) => (r instanceof ThinkingPart ? i : -1))
      .filter((i: number) => i !== -1);
    const textIndices = allReports
      .map((r, i) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
      .filter((i: number) => i !== -1);

    expect(thinkingIndices).toHaveLength(2);
    expect(textIndices).toHaveLength(2);

    expect(allReports[thinkingIndices[0]]).toEqual(expect.objectContaining({ value: "Thinking" }));
    expect(allReports[thinkingIndices[1]]).toEqual(
      expect.objectContaining({ value: " final thought" }),
    );
    expect(allReports[textIndices[0]]).toEqual(expect.objectContaining({ value: "Answer" }));
    expect(allReports[textIndices[1]]).toEqual(expect.objectContaining({ value: " continued" }));

    expect(thinkingIndices[1]).toBeLessThan(textIndices[0]);
  });

  it("emits a single balanced thinking part when reasoning contains an unclosed code fence", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [{ delta: { reasoning_content: "Analyzing code:\n```python\ndef foo():" } }],
      };
      yield { choices: [{ delta: { reasoning_content: "\n    return 42" } }] };
      yield { choices: [{ delta: { content: "The answer is 42" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "deepseek-ai/deepseek-v4", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(
      expect.objectContaining({
        value: "Analyzing code:\n```python\ndef foo():\n    return 42\n```",
      }),
    );
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "The answer is 42" }));
  });

  it("throws empty_stream when reasoning was emitted without an answer or tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Only reasoning, no answer" } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[EMPTY_STREAM]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);

    expect(thinkingReports).toHaveLength(0);
  });

  const closeTag = "</" + "think>";

  it("splits content on orphaned think-close tag into reasoning and answer", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "English reasoning here" } }] };
      yield { choices: [{ delta: { content: " more thinking" + closeTag } }] };
      yield { choices: [{ delta: { content: "Russian answer here" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "on" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingIndices = allReports
      .map((r, i) => (r instanceof ThinkingPart ? i : -1))
      .filter((i: number) => i !== -1);
    const textIndices = allReports
      .map((r, i) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
      .filter((i: number) => i !== -1);

    const thinkingText = thinkingIndices.map((i: number) => allReports[i].value).join("");
    expect(thinkingText).toContain("English reasoning here more thinking");

    expect(textIndices).toHaveLength(1);
    expect(allReports[textIndices[0]]).toEqual(
      expect.objectContaining({ value: "Russian answer here" }),
    );
    expect(thinkingIndices[thinkingIndices.length - 1]).toBeLessThan(textIndices[0]);
  });

  it("splits orphaned think-close tag across chunks", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "reasoning part one" } }] };
      yield { choices: [{ delta: { content: " reasoning part two" + closeTag } }] };
      yield { choices: [{ delta: { content: "answer after split" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "on" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "answer after split" }));
  });

  it("handles orphaned think-close tag after reasoning_content stopped (mid-stream leak)", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "proper reasoning start" } }] };
      yield { choices: [{ delta: { content: "leaked reasoning continuation" + closeTag } }] };
      yield { choices: [{ delta: { content: "actual answer text" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "on" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingText = allReports
      .filter((r) => r instanceof ThinkingPart)
      .map((r) => r.value)
      .join("");
    const textIndices = allReports
      .map((r, i) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
      .filter((i: number) => i !== -1);

    expect(thinkingText).toContain("proper reasoning start");
    expect(thinkingText).toContain("leaked reasoning continuation");
    expect(textIndices).toHaveLength(1);
    expect(allReports[textIndices[0]]).toEqual(
      expect.objectContaining({ value: "actual answer text" }),
    );
  });

  it("streams answer tokens live after reasoning_content instead of waiting for flush", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "proper reasoning start" } }] };
      yield { choices: [{ delta: { content: "Hel" } }] };
      yield { choices: [{ delta: { content: "lo " } }] };
      yield { choices: [{ delta: { content: "world" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "high" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const textReports = progress.report.mock.calls
      .map((c) => c[0])
      .filter((r) => r instanceof vscode.LanguageModelTextPart);
    const thinkingReports = progress.report.mock.calls
      .map((c) => c[0])
      .filter((r) => r instanceof ThinkingPart);

    expect(thinkingReports.map((r) => r.value).join("")).toBe("proper reasoning start");
    expect(textReports.map((r) => r.value)).toEqual(["Hel", "lo ", "world"]);
  });

  it("routes content to answer after reasoning_content has finished if no close tag exists in content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "proper reasoning start" } }] };
      yield { choices: [{ delta: { content: "actual answer text" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = {
      report: jest.fn(),
    };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "on" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingText = allReports
      .filter((r) => r instanceof ThinkingPart)
      .map((r) => r.value)
      .join("");
    const textReports = allReports.filter((r) => r instanceof vscode.LanguageModelTextPart);
    const textContent = textReports.map((r) => r.value).join("");

    expect(thinkingText).toBe("proper reasoning start");
    expect(textReports).toHaveLength(1);
    expect(textContent).toBe("actual answer text");
  });

  it("does not log stream chunks when debug is on unless logStreamChunks is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    setDeveloperLogOptions({ logStreamChunks: false });
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const mockStream = async function* () {
        yield { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      );

      const chunkLogs = consoleSpy.mock.calls.filter((c) => c[0]?.includes?.("stream chunk"));
      expect(chunkLogs).toHaveLength(0);
    } finally {
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
      setDeveloperLogOptions({ logStreamChunks: false });
    }
  });

  it("logs raw stream chunk metadata when logStreamChunks is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    setDeveloperLogOptions({ logStreamChunks: true });
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const mockStream = async function* () {
        yield { choices: [{ delta: { reasoning_content: "thinking part" } }] };
        yield {
          choices: [
            { delta: { reasoning_content: " end", content: "answer" }, finish_reason: null },
          ],
        };
        yield { choices: [{ delta: { content: " done" }, finish_reason: "stop" }] };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      );

      const chunkLogs = consoleSpy.mock.calls.filter((c) => c[0]?.includes?.("stream chunk"));
      expect(chunkLogs.length).toBeGreaterThanOrEqual(3);
      expect(chunkLogs[0][1]).toEqual(
        expect.objectContaining({ rc: true, content: false, finish: null }),
      );
      expect(chunkLogs[1][1]).toEqual(
        expect.objectContaining({ rc: true, content: true, finish: null }),
      );
      expect(chunkLogs[2][1]).toEqual(
        expect.objectContaining({ rc: false, content: true, finish: "stop" }),
      );
    } finally {
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
      setDeveloperLogOptions({ logStreamChunks: false });
    }
  });

  it("keeps isolated content-only replies visible when no reasoning stream appears", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Now let me look" } }] };
      yield { choices: [{ delta: { content: " at the code" } }] };
      yield { choices: [{ delta: { content: " to understand" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "high" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(
      expect.objectContaining({ value: "Now let me look at the code to understand" }),
    );
  });

  it("keeps ambiguous content in thinking and throws empty_stream when no close tag appears", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "thinking without tags" } }] };
      yield { choices: [{ delta: { reasoning_content: "proper reasoning" } }] };
      yield { choices: [{ delta: { content: "ambiguous continuation" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4-flash-0731",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions({
          modelConfiguration: { reasoningMode: "on" },
          modelOptions: {},
        }),
        progress,
        token,
      ),
    ).rejects.toThrow("[EMPTY_STREAM]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingText = allReports
      .filter((r) => r instanceof ThinkingPart)
      .map((r) => r.value)
      .join("");
    const textReports = allReports.filter((r) => r instanceof vscode.LanguageModelTextPart);

    expect(textReports).toHaveLength(0);
    expect(thinkingText).toBe("");
  });

  it("does not route content to thinking when reasoning mode is none", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "reasoningMode" ? "on" : defaultValue,
      ),
    });

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Direct answer without reasoning" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "none" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(
      expect.objectContaining({ value: "Direct answer without reasoning" }),
    );
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({
        chat_template_kwargs: expect.objectContaining({ thinking: false }),
      }),
      expect.any(AbortSignal),
      "test-ua",
      expect.objectContaining({ maxOutputTokens: 65536 }),
    );
  });

  it("does not route content to thinking for models without reasoning_content support", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Answer from non-reasoning model" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "meta/llama-4-maverick-17b-128e-instruct",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(
      expect.objectContaining({ value: "Answer from non-reasoning model" }),
    );
  });

  it("keeps Inkling content as the final answer when reasoning is enabled", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Inkling final answer" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "thinkingmachines/inkling", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelConfiguration: { reasoningMode: "medium" },
        modelOptions: {},
      }),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "Inkling final answer" }));
  });

  it("emits think-tag content as a thinking part for kimi models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "<think>my reasoning</think>visible answer" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "my reasoning" }));
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "visible answer" }));
  });

  it("strips mm:think tags from content when reasoning_content is present", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Initial reasoning" } }] };
      yield {
        choices: [
          {
            delta: {
              content: "Response before <mm:think>mid reasoning</mm:think> response after",
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "Initial reasoning" }));
    const textContent = textReports.map((r) => r[0].value).join("");
    expect(textContent).toBe("Response before  response after");
    expect(textContent).not.toContain("mid reasoning");
    expect(textContent).not.toContain("<mm:think>");
  });

  it("captures mm:think tags as thinking when reasoning_content is absent", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content: "<mm:think>reasoning here</mm:think>visible answer",
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "reasoning here" }));
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "visible answer" }));
  });

  it("isolates orphaned Stepfun reasoning without a reasoning mode toggle", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "<think>English reasoning" } }] };
      yield { choices: [{ delta: { content: " still thinking" + closeTag } }] };
      yield { choices: [{ delta: { content: "Ответ на русском" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "stepfun-ai/step-3.7-flash",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    const allReports = progress.report.mock.calls.map((c) => c[0]);
    const thinkingText = allReports
      .filter((r) => r instanceof ThinkingPart)
      .map((r) => r.value)
      .join("");
    const textReports = allReports.filter((r) => r instanceof vscode.LanguageModelTextPart);
    const textContent = textReports.map((r) => r.value).join("");

    expect(thinkingText).toContain("English reasoning still thinking");
    expect(textReports).toHaveLength(1);
    expect(textContent).toBe("Ответ на русском");
    expect(textContent).not.toContain("English reasoning");
  });

  it("does not fetch models during chat when the selected model already exposes capabilities", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: {
          toolCalling: 128,
          imageInput: false,
        },
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    expect(fetchModels).not.toHaveBeenCalled();
    const requestBody = (streamChatCompletion as jest.Mock).mock.calls[0][1];
    expect(requestBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) }),
      ]),
    );
  });

  it("does not trust stale provider model capabilities after a cache refresh", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash-0731",
            displayName: "DeepSeek V4 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 384000,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });
    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          detail: "NVIDIA NIM",
          family: "nvidia-nim",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeMessages({
          role: 1,
          content: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
        }),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow(/does not support image input|MODEL_UNAVAILABLE/);

    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("reports unsupported image input for non-vision normalized models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ]);

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4-flash-0731",
          maxInputTokens: 100000,
          maxOutputTokens: 384000,
        }),
        makeMessages({
          role: 1,
          content: [
            { value: "What is in this image?" },
            { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          ],
        }),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow(/does not support image input|MODEL_UNAVAILABLE/);

    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("converts image parts to image_url content for vision-capable normalized models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "minimaxai/minimax-m3",
        displayName: "MiniMax M3",
        contextWindow: 1048576,
        maxOutputTokens: 100000,
        supportsTools: true,
        supportsVision: true,
      },
    ]);

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Vision reply" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 100000 }),
      makeMessages({
        role: 1,
        content: [
          { value: "What is in this image?" },
          { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      }),
      makeChatOptions(),
      progress,
      token,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls[0][1];
    expect(requestBody.model).toBe("minimaxai/minimax-m3");
    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image_url",
              image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
            }),
          ]),
        }),
      ]),
    );
  });

  it("throws when message exceeds token limit", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 1, maxOutputTokens: 65536 }),
        makeMessages({
          role: 1,
          content: [{ value: "This is a very long message that exceeds the token limit" }],
        }),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[TOKEN_LIMIT_EXCEEDED]");
  });

  it("caps max_tokens to the remaining context budget", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
              contextWindow: 70000,
              maxOutputTokens: 200000,
              supportsTools: true,
              supportsVision: false,
            },
          ]
        : undefined,
    );

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();
    const prompt = "a".repeat(900);

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "moonshotai/kimi-k3", maxInputTokens: 5000, maxOutputTokens: 200000 }),
      makeMessages({ role: 1, content: [{ value: prompt }] }),
      makeChatOptions({
        modelOptions: { max_tokens: 120000 },
      }),
      progress,
      token,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    const expectedRemainingBudget = 70000 - 300 - CONTEXT_WINDOW_SAFETY_MARGIN;

    expect(requestBody.max_tokens).toBe(expectedRemainingBudget);
  });

  it("logs first token latency and total stream duration when debug logging is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1125)
      .mockReturnValueOnce(1450);

    try {
      const mockStream = async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Inspect the workspace"),
        makeChatOptions(),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          attempt: 1,
          model: "kimi-k2.6",
          firstTokenLatencyMs: 125,
          totalDurationMs: 450,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("includes request preparation duration in the stream timing log", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1250)
      .mockReturnValueOnce(1400)
      .mockReturnValueOnce(2100);

    try {
      const mockStream = async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Inspect the workspace"),
        makeChatOptions(),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          requestPreparationDurationMs: 250,
          firstTokenLatencyMs: 150,
          totalDurationMs: 850,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("includes tool parsing state initialization duration in the stream timing log", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1200)
      .mockReturnValueOnce(1250)
      .mockReturnValueOnce(1290)
      .mockReturnValueOnce(1350)
      .mockReturnValueOnce(1500);

    try {
      const mockStream = async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"filePath":"/tmp/example.md","startLine":1,"endLine":20}',
                    },
                  },
                ],
              },
            },
          ],
        };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        }),
        makeUserMessages("Read the file"),
        makeChatOptions({
          modelOptions: {},
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              inputSchema: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                },
                required: ["filePath", "startLine", "endLine"],
              },
            },
          ],
        }),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          requestPreparationDurationMs: 100,
          firstTokenLatencyMs: 100,
          toolParsingStateInitDurationMs: 40,
          totalDurationMs: 400,
          emittedToolCall: true,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("includes usage-derived throughput metrics in the stream timing log when usage is available", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2200)
      .mockReturnValueOnce(3000);

    try {
      const mockStream = async function* () {
        yield {
          choices: [{ delta: { content: "done" } }],
          usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
        };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Inspect the workspace"),
        makeChatOptions(),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          promptTokens: 120,
          completionTokens: 80,
          totalTokens: 200,
          generationDurationMs: 800,
          completionTokensPerSecond: 100,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("logs the selected model as the runtime metadata source when chat skips model fetching", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(4000)
      .mockReturnValueOnce(4000)
      .mockReturnValueOnce(4075)
      .mockReturnValueOnce(4300);

    try {
      const mockStream = async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        }),
        makeUserMessages("Inspect the workspace"),
        makeChatOptions({
          modelOptions: {},
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              inputSchema: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                },
                required: ["filePath", "startLine", "endLine"],
              },
            },
          ],
        }),
        progress,
        token,
      );

      expect(fetchModels).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          runtimeMetadataSource: "selected-model",
          toolsEnabled: true,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("includes request context and retry metadata in stream timing logs for invalid tool retries", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1050)
      .mockReturnValueOnce(1060)
      .mockReturnValueOnce(1090)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2125)
      .mockReturnValueOnce(2200)
      .mockReturnValueOnce(2600);

    const invalidStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };

    const repairedStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":1,"endLine":20}',
                  },
                },
              ],
            },
          },
        ],
      };
    };

    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => invalidStream())
      .mockImplementationOnce(() => repairedStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    try {
      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        }),
        makeUserMessages("Read the file"),
        makeChatOptions({
          modelOptions: {},
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              inputSchema: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                },
                required: ["filePath", "startLine", "endLine"],
              },
            },
          ],
        }),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          attempt: 1,
          toolsEnabled: true,
          requestedMaxTokens: 65536,
          temperature: 0.1,
          inputTokenCount: expect.any(Number),
          isRetryAttempt: false,
          willRetryAfterInvalidToolCall: true,
          retryReason: "invalid_tool_call",
        }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          attempt: 2,
          toolsEnabled: true,
          requestedMaxTokens: 65536,
          temperature: 0.1,
          inputTokenCount: expect.any(Number),
          isRetryAttempt: true,
          willRetryAfterInvalidToolCall: false,
          retryReason: "invalid_tool_call",
          emittedToolCall: true,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("includes skipped tool call summary fields in stream timing logs", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(5050)
      .mockReturnValueOnce(5060)
      .mockReturnValueOnce(5090)
      .mockReturnValueOnce(5100)
      .mockReturnValueOnce(6000)
      .mockReturnValueOnce(6125)
      .mockReturnValueOnce(6200)
      .mockReturnValueOnce(6600);

    const invalidStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };

    const repairedStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":1,"endLine":20}',
                  },
                },
              ],
            },
          },
        ],
      };
    };

    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => invalidStream())
      .mockImplementationOnce(() => repairedStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    try {
      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Read the file"),
        makeChatOptions({
          modelOptions: {},
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              inputSchema: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                },
                required: ["filePath", "startLine", "endLine"],
              },
            },
          ],
        }),
        progress,
        token,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          attempt: 1,
          skippedToolCallCount: 1,
          skippedToolCallNames: ["read_file"],
        }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "[NVIDIA NIM Debug] stream timing:",
        expect.objectContaining({
          attempt: 2,
          skippedToolCallCount: 0,
        }),
      );
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      delete process.env.NVIDIA_NIM_DEBUG;
    }
  });

  it("prompts for an API key during chat and continues the request when one is provided", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue("new-api-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from NVIDIA NIM" } }] };
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(vscode.window.showInputBox).toHaveBeenCalled();
    expect(secrets.store).toHaveBeenCalledWith("nvidia-nim.apiKey", "new-api-key");
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "new-api-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
      expect.objectContaining({ maxOutputTokens: 65536 }),
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Hello from NVIDIA NIM" }),
    );

    // The same picker model may retain an old provider-group binding after a
    // key was removed. A key entered interactively must rebind that model so
    // the next request reuses it instead of opening another prompt.
    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi again"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    expect((streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[0]).toBe("new-api-key");
  });

  it("uses the API key carried by the configured model for chat requests", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from configured key" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());
    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "configured-model",
        name: "Configured Model",
        family: "nvidia-nim",
        version: "1.0.0",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: {},
        apiKey: "configured-key",
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "configured-key",
      expect.anything(),
      expect.any(AbortSignal),
      "test-ua",
      expect.objectContaining({ maxOutputTokens: 65536 }),
    );
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("fails the turn when no API key is available", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow(/NVIDIA NIM API key/);

    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
  });

  const readFileTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
  };

  it("auto-continues when hanging colon is split across text parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const hangingStream = async function* () {
      yield { choices: [{ delta: { content: "Let me inspect the file:" } }] };
      yield { choices: [{ delta: { content: " \n" }, finish_reason: "stop" }] };
    };
    const continueStream = async function* () {
      yield { choices: [{ delta: { content: "Calling the tool next." } }] };
    };
    (streamChatCompletion as jest.Mock).mockReset();
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => hangingStream())
      .mockImplementationOnce(() => continueStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: false },
      }),
      makeUserMessages("Hi"),
      makeChatOptions({ tools: [readFileTool] }),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const retryBody = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(JSON.stringify(retryBody.messages)).toContain(LOOP_BREAKER_MARKER);
    expect(JSON.stringify(retryBody.messages)).toContain("ended with");
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Calling the tool next." }),
    );
  });

  it("auto-continues once when finish_reason is length", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const truncatedStream = async function* () {
      yield { choices: [{ delta: { content: "Partial answer" }, finish_reason: "length" }] };
    };
    const continueStream = async function* () {
      yield { choices: [{ delta: { content: " and the rest." } }] };
    };
    (streamChatCompletion as jest.Mock).mockReset();
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => truncatedStream())
      .mockImplementationOnce(() => continueStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const retryBody = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(JSON.stringify(retryBody.messages)).toContain("output token limit");
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: " and the rest." }),
    );
  });

  it("notifies when finish_reason is length and auto-continue is disabled", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "generation.autoContinueOnLoop" ? false : defaultValue,
      ),
    }));
    const truncatedStream = async function* () {
      yield { choices: [{ delta: { content: "Cut off" }, finish_reason: "length" }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(truncatedStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: OUTPUT_TRUNCATED_NOTICE }),
    );
  });

  it("throws when content_filter stops a stream with no visible answer", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const filteredStream = async function* () {
      yield { choices: [{ delta: {}, finish_reason: "content_filter" }] };
    };
    (streamChatCompletion as jest.Mock).mockReset();
    (streamChatCompletion as jest.Mock).mockImplementation(() => filteredStream());

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4-flash-0731",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      ),
    ).rejects.toThrow(/INVALID_REQUEST|filtered/);
  });

  it("notifies when content_filter stops a stream after visible text", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const filteredStream = async function* () {
      yield { choices: [{ delta: { content: "Hello" }, finish_reason: "content_filter" }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(filteredStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: CONTENT_FILTER_NOTICE }),
    );
  });

  it.each([
    [429, "Rate limited", "rate_limited"],
    [529, "Overloaded", "rate_limited"],
    [404, "Model unavailable", "model_unavailable"],
    [410, "Model unavailable", "model_unavailable"],
  ] as const)(
    "falls back to Nemotron 3 Super 120B on HTTP %s",
    async (status: number, capacityLabel: string, kind: ApiErrorKind) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");
      (globalState.get as jest.Mock).mockImplementation((key: string) =>
        key === "nvidia-nim.models"
          ? [
              {
                id: "moonshotai/kimi-k2.6",
                displayName: "Kimi k2.6",
                contextWindow: 262144,
                maxOutputTokens: 262144,
                supportsTools: true,
                supportsVision: true,
              },
              {
                id: "nvidia/nemotron-3-super-120b-a12b",
                displayName: "Nemotron 3 Super 120B",
                contextWindow: 1000000,
                maxOutputTokens: 65536,
                supportsTools: true,
                supportsVision: false,
              },
            ]
          : key === MODELS_CACHE_VERSION_STATE_KEY
            ? MODELS_CACHE_VERSION
            : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
              ? getApiKeyFingerprint("test-key")
              : undefined,
      );

      const capacityError = new NvidiaApiError(kind, `[${kind.toUpperCase()}] ${capacityLabel}.`, {
        status,
      });
      const capacityStream = async function* () {
        throw capacityError;
      };
      const fallbackStream = async function* () {
        yield { choices: [{ delta: { content: "Fallback response" } }] };
      };
      (streamChatCompletion as jest.Mock)
        .mockImplementationOnce(() => capacityStream())
        .mockImplementationOnce(() => fallbackStream());

      const progress = { report: jest.fn() };
      const token = makeToken();

      await provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      );

      expect(streamChatCompletion).toHaveBeenCalledTimes(2);
      const fallbackRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
      expect(fallbackRequest.model).toBe("nvidia/nemotron-3-super-120b-a12b");
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        `${capacityLabel} on Kimi k2.6. Falling back to Nemotron 3 Super 120B.`,
      );
      expect(progress.report).toHaveBeenCalledWith(
        expect.objectContaining({ value: "Fallback response" }),
      );
      expect(progress.report).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.stringContaining("⚡ **NVIDIA NIM Fallback:**"),
        }),
      );
    },
  );

  it("falls back after network_error retries are exhausted", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
              contextWindow: 1048576,
              maxOutputTokens: 65536,
              supportsTools: true,
              supportsVision: true,
            },
            {
              id: "nvidia/nemotron-3-super-120b-a12b",
              displayName: "Nemotron 3 Super 120B",
              contextWindow: 1000000,
              maxOutputTokens: 65536,
              supportsTools: true,
              supportsVision: false,
            },
          ]
        : key === MODELS_CACHE_VERSION_STATE_KEY
          ? MODELS_CACHE_VERSION
          : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
            ? getApiKeyFingerprint("test-key")
            : undefined,
    );

    let calls = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      calls += 1;
      if (calls <= 4) {
        return (async function* () {
          throw new NvidiaApiError("network_error", "[NETWORK_ERROR] fetch failed.");
        })();
      }
      return (async function* () {
        yield { choices: [{ delta: { content: "Recovered on Super" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k3",
        name: "Kimi K3",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(calls).toBeGreaterThan(1);
    const fallbackRequest = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(fallbackRequest.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Recovered on Super" }),
    );
  });

  it("does not emit thinking parts when the stream never produces visible content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return false;
        return defaultValue;
      }),
    }));
    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "silent thoughts" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());
    const progress = { report: jest.fn() };

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4-flash-0731",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions({ modelConfiguration: { reasoningMode: "high" } }),
        progress,
        makeToken(),
      ),
    ).rejects.toThrow(/EMPTY_STREAM|no visible/);

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    expect(thinkingReports).toHaveLength(0);
  });

  it("falls back to a custom configured fallback model when set", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const customGlobalState = makeMemento((key) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi k2.6",
              contextWindow: 262144,
              maxOutputTokens: 262144,
              supportsTools: true,
              supportsVision: true,
            },
            {
              id: "deepseek-ai/deepseek-v4-flash-0731",
              displayName: "DeepSeek V4 Flash 0731",
              contextWindow: 128000,
              maxOutputTokens: 8192,
              supportsTools: true,
              supportsVision: false,
            },
          ]
        : key === MODELS_CACHE_VERSION_STATE_KEY
          ? MODELS_CACHE_VERSION
          : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
            ? getApiKeyFingerprint("test-key")
            : undefined,
    );
    const customProvider = new NimChatModelProvider(secrets, "test-ua", customGlobalState);

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.model") return "deepseek-ai/deepseek-v4-flash-0731";
        if (key === "fallback.enabled") return true;
        if (key === "fallback.onRateLimit") return true;
        if (key === "fallback.showNoticeInChat") return true;
        return defaultValue;
      }),
    }));

    const rateLimitError = new NvidiaApiError("rate_limited", "[RATE_LIMITED] Rate limited.", {
      status: 429,
    });
    const capacityStream = async function* () {
      throw rateLimitError;
    };
    const fallbackStream = async function* () {
      yield { choices: [{ delta: { content: "DeepSeek fallback answer" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => capacityStream())
      .mockImplementationOnce(() => fallbackStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await customProvider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k2.6",
        name: "Kimi k2.6",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const fallbackRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(fallbackRequest.model).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.stringContaining("DeepSeek V4 Flash 0731"),
      }),
    );
  });

  it("routes vision requests to a vision fallback model when primary model fails", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const customGlobalState = makeMemento((key) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
              contextWindow: 1048576,
              maxOutputTokens: 65536,
              supportsTools: true,
              supportsVision: true,
            },
            {
              id: "nvidia/nemotron-3-super-120b-a12b",
              displayName: "Nemotron 3 Super 120B",
              contextWindow: 1000000,
              maxOutputTokens: 65536,
              supportsTools: true,
              supportsVision: false,
            },
            {
              id: "meta/muse-glimmer-30b",
              displayName: "Muse Glimmer",
              contextWindow: 131072,
              maxOutputTokens: 32768,
              supportsTools: true,
              supportsVision: true,
            },
          ]
        : key === MODELS_CACHE_VERSION_STATE_KEY
          ? MODELS_CACHE_VERSION
          : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
            ? getApiKeyFingerprint("test-key")
            : undefined,
    );
    const customProvider = new NimChatModelProvider(secrets, "test-ua", customGlobalState);

    const modelUnavailableError = new NvidiaApiError(
      "model_unavailable",
      "[MODEL_UNAVAILABLE] Function not found.",
      { status: 404 },
    );
    const failingStream = async function* () {
      throw modelUnavailableError;
    };
    const fallbackStream = async function* () {
      yield { choices: [{ delta: { content: "Muse Glimmer vision fallback response" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => failingStream())
      .mockImplementationOnce(() => fallbackStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    const messagesWithImage = [
      {
        role: 1,
        content: [
          new vscode.LanguageModelTextPart("Look at this image"),
          { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      },
    ] as unknown as vscode.LanguageModelChatMessage[];

    await customProvider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k3",
        name: "Kimi K3",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      messagesWithImage,
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const fallbackRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(fallbackRequest.model).toBe("meta/muse-glimmer-30b");
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Muse Glimmer vision fallback response" }),
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.stringContaining("Muse Glimmer"),
      }),
    );
  });

  it("does not fallback when fallback.enabled is set to false", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const customGlobalState = makeMemento((key) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
              contextWindow: 262144,
              maxOutputTokens: 262144,
              supportsTools: true,
              supportsVision: true,
            },
          ]
        : key === MODELS_CACHE_VERSION_STATE_KEY
          ? MODELS_CACHE_VERSION
          : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
            ? getApiKeyFingerprint("test-key")
            : undefined,
    );
    const customProvider = new NimChatModelProvider(secrets, "test-ua", customGlobalState);

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return false;
        return defaultValue;
      }),
    }));

    const rateLimitError = new NvidiaApiError("rate_limited", "[RATE_LIMITED] Rate limited.", {
      status: 429,
    });
    const capacityStream = async function* () {
      throw rateLimitError;
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => capacityStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      customProvider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k3",
          name: "Kimi K3",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[RATE_LIMITED]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deepseek-ai/deepseek-v4-flash-0731", false],
    ["minimaxai/minimax-m3", true],
    ["moonshotai/kimi-k3", true],
    ["nvidia/nemotron-3-ultra-550b-a55b", false],
    ["nvidia/nemotron-3.5-lightning-30b-a3b", false],
    ["thinkingmachines/inkling", true],
    ["meta/muse-glimmer-30b", true],
  ] as const)("enforces the curated vision capability for %s", async (modelId, supportsVision) => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Vision response" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());
    const progress = { report: jest.fn() };
    const token = makeToken();

    const responsePromise = provider.provideLanguageModelChatResponse(
      makeModel({
        id: modelId,
        name: modelId,
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: supportsVision },
      }),
      makeMessages({
        role: 1,
        content: [
          { value: "Describe this" },
          { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      }),
      makeChatOptions(),
      progress,
      token,
    );

    if (!supportsVision) {
      await expect(responsePromise).rejects.toThrow(
        /does not support image input|MODEL_UNAVAILABLE/,
      );
      expect(streamChatCompletion).not.toHaveBeenCalled();
      return;
    }

    await responsePromise;

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    const requestBody = (streamChatCompletion as jest.Mock).mock.calls[0][1];
    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ type: "image_url" })]),
        }),
      ]),
    );
  });

  it("does not start a rate-limit fallback after user-visible content was emitted", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const rateLimitError = new NvidiaApiError(
      "rate_limited",
      "[RATE_LIMITED] Rate limited.\nRetry after 30.",
      { status: 429 },
    );
    const partialStream = async function* () {
      yield { choices: [{ delta: { content: "Partial response" } }] };
      throw rateLimitError;
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => partialStream());
    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[RATE_LIMITED]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Partial response" }),
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Falling back"),
    );
  });

  it("does not fall back on rate limit when the default text fallback is unavailable", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi k2.6",
              contextWindow: 262144,
              maxOutputTokens: 65536,
              supportsTools: true,
              supportsVision: true,
            },
          ]
        : key === MODELS_CACHE_VERSION_STATE_KEY
          ? MODELS_CACHE_VERSION
          : key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
            ? getApiKeyFingerprint("test-key")
            : undefined,
    );
    const rateLimitedStream = async function* () {
      throw new NvidiaApiError("rate_limited", "[RATE_LIMITED] Rate limited.\nRetry after 30.", {
        status: 429,
      });
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => rateLimitedStream());

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      ),
    ).rejects.toThrow("[RATE_LIMITED]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("retries on network error during stream when no content was emitted", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const networkError = new TypeError("fetch failed");
    const failingStream = async function* () {
      throw networkError;
    };
    const successStream = async function* () {
      yield { choices: [{ delta: { content: "Recovered" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => failingStream())
      .mockImplementationOnce(() => successStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: true },
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "Recovered" }));
  });

  it("recalculates max_tokens after adding network retry guidance", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
              contextWindow: 5000,
              maxOutputTokens: 1000,
              supportsTools: true,
              supportsVision: true,
            },
          ]
        : undefined,
    );

    const failingStream = async function* () {
      throw new TypeError("fetch failed");
    };
    const successStream = async function* () {
      yield { choices: [{ delta: { content: "Recovered" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => failingStream())
      .mockImplementationOnce(() => successStream());

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k3",
        maxInputTokens: 5000,
        maxOutputTokens: 1000,
        capabilities: { toolCalling: 128, imageInput: true },
      }),
      makeMessages({ role: 1, content: [{ value: "a".repeat(900) }] }),
      makeChatOptions({
        modelOptions: { max_tokens: 1000 },
      }),
      { report: jest.fn() },
      makeToken(),
    );

    const firstRequest = (streamChatCompletion as jest.Mock).mock.calls[0][1];
    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages).toHaveLength(firstRequest.messages.length + 1);
    expect(retryRequest.max_tokens).toBeLessThan(firstRequest.max_tokens);
    const guidanceMessage = retryRequest.messages[retryRequest.messages.length - 1];
    expect(guidanceMessage).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("interrupted by a network error"),
      }),
    );
  });

  it("does not retry a network failure after user-visible content was emitted", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const partialStream = async function* () {
      yield { choices: [{ delta: { content: "Partial response" } }] };
      throw new TypeError("fetch failed");
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => partialStream());
    const progress = { report: jest.fn() };

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        makeToken(),
      ),
    ).rejects.toThrow("fetch failed");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Partial response" }),
    );
  });

  it("shares one interactive API-key prompt across parallel chat requests", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    let resolvePrompt!: (value: string | undefined) => void;
    const promptResult = new Promise<string | undefined>((resolve) => {
      resolvePrompt = resolve;
    });
    (vscode.window.showInputBox as jest.Mock).mockReturnValue(promptResult);
    (streamChatCompletion as jest.Mock).mockImplementation(() =>
      (async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      })(),
    );
    const token = makeToken();
    const makeRequest = () =>
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        token,
      );

    const requests = [makeRequest(), makeRequest()];
    for (
      let attempt = 0;
      attempt < 10 && !(vscode.window.showInputBox as jest.Mock).mock.calls.length;
      attempt += 1
    ) {
      await Promise.resolve();
    }

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    resolvePrompt("shared-key");
    await Promise.all(requests);

    expect(secrets.store).toHaveBeenCalledTimes(1);
    expect((streamChatCompletion as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      "shared-key",
      "shared-key",
    ]);
  });

  it("cancels an active provider stream without retrying", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    let streamSignal: AbortSignal | undefined;
    (streamChatCompletion as jest.Mock).mockImplementation(
      (_apiKey: string, _request: unknown, signal: AbortSignal) => {
        streamSignal = signal;
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        })();
      },
    );
    let cancelled = false;
    let cancelListener: (() => void) | undefined;
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: jest.fn((listener: () => void) => {
        cancelListener = listener;
        return { dispose: jest.fn() };
      }),
    };

    const request = provider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: true },
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      { report: jest.fn() },
      asCancellationToken(token),
    );

    for (let attempt = 0; attempt < 10 && !streamSignal; attempt += 1) {
      await Promise.resolve();
    }
    await Promise.resolve();
    cancelled = true;
    cancelListener?.();

    await expect(request).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(streamSignal?.aborted).toBe(true);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not retry when cancellation races with a network stream failure", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    let cancelListener: (() => void) | undefined;
    let streamCalls = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(
      (_apiKey: string, _request: unknown, _signal: AbortSignal) => {
        streamCalls += 1;
        return (async function* () {
          // Exercise the abort-controller path even when the token's
          // isCancellationRequested flag has not observed the race yet.
          cancelListener?.();
          throw new TypeError("fetch failed");
        })();
      },
    );
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn((listener: () => void) => {
        cancelListener = listener;
        return { dispose: jest.fn() };
      }),
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        asCancellationToken(token),
      ),
    ).rejects.toBeInstanceOf(vscode.CancellationError);

    expect(streamCalls).toBe(1);
  });

  it("retries when the stream error has already been classified as a network API error", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const classifiedNetworkError = new NvidiaApiError("network_error", "network down", {
      operation: "stream",
    });
    const failingStream = async function* () {
      throw classifiedNetworkError;
    };
    const successStream = async function* () {
      yield { choices: [{ delta: { content: "Recovered" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => failingStream())
      .mockImplementationOnce(() => successStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "Recovered" }));
  });

  it("retries an empty stream and then throws a structured empty_stream error", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: {}, finish_reason: null }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[EMPTY_STREAM]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(3);
    expect(progress.report).not.toHaveBeenCalled();
  });

  it("caps the total fetch-attempt budget across all stream retries", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: {}, finish_reason: null }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      ),
    ).rejects.toThrow("[EMPTY_STREAM]");

    const attempts = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call) => call[4]?.maxFetchAttempts ?? 3,
    );
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.length).toBeLessThanOrEqual(6);
    for (const value of attempts) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3);
    }
    expect(attempts.reduce((sum: number, value: number) => sum + value, 0)).toBeLessThanOrEqual(18);
  });

  it("recovers when a retry after an empty stream returns content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const emptyStream = async function* () {
      yield { choices: [{ delta: {}, finish_reason: null }] };
    };
    const goodStream = async function* () {
      yield { choices: [{ delta: { content: "Recovered answer" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockReturnValueOnce(emptyStream())
      .mockReturnValueOnce(goodStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const textReports = progress.report.mock.calls.filter(
      (c) => c[0] instanceof vscode.LanguageModelTextPart,
    );
    expect(textReports.map((c) => c[0].value).join("")).toBe("Recovered answer");
  });

  it("does not multi-retry a reasoning-only stream and throws empty_stream", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "fallback.enabled" ? false : defaultValue,
      ),
    }));
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "thinking only" } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "deepseek-ai/deepseek-v4",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
      ),
    ).rejects.toThrow("[EMPTY_STREAM]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const thinkingReports = progress.report.mock.calls.filter((c) => c[0] instanceof ThinkingPart);
    expect(thinkingReports).toHaveLength(0);
  });

  const getUsageParts = (progress: { report: jest.Mock }) =>
    progress.report.mock.calls
      .map((c) => c[0])
      .filter((p) => p instanceof vscode.LanguageModelDataPart && p.mimeType === "usage");

  it("reports stream usage as a usage data part for the context window widget", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello" } }] };
      yield {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const usageParts = getUsageParts(progress);
    expect(usageParts).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(usageParts[0].data))).toEqual({
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
    });
  });

  it("emits the last observed usage exactly once when multiple usage chunks arrive", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [{ delta: { content: "partial" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      yield {
        choices: [{ delta: { content: " done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const usageParts = getUsageParts(progress);
    expect(usageParts).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(usageParts[0].data))).toEqual({
      prompt_tokens: 12,
      completion_tokens: 9,
      total_tokens: 21,
    });
  });

  it("does not emit a usage data part when the stream carries no usage", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "No usage here" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(getUsageParts(progress)).toHaveLength(0);
  });

  it("emits usage once from the final attempt after an empty-stream retry", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    let attempt = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        return (async function* () {})();
      }
      return (async function* () {
        yield {
          choices: [{ delta: { content: "Recovered answer" } }],
          usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
        };
      })();
    });

    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const usageParts = getUsageParts(progress);
    expect(usageParts).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(usageParts[0].data))).toEqual({
      prompt_tokens: 30,
      completion_tokens: 4,
      total_tokens: 34,
    });
  });

  it("walks nvidia-nim.fallback.priorityList across multiple failover hops", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "fallback.priorityList"
          ? ["nvidia/nemotron-3-ultra-550b-a55b", "minimaxai/minimax-m3"]
          : defaultValue,
      ),
    }));
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "moonshotai/kimi-k3",
            displayName: "Kimi K3",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            displayName: "Nemotron 3 Ultra 550B",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
          {
            id: "minimaxai/minimax-m3",
            displayName: "MiniMax M3",
            contextWindow: 1000000,
            maxOutputTokens: 100000,
            supportsTools: true,
            supportsVision: true,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() =>
        (async function* () {
          throw new NvidiaApiError("rate_limited", "[RATE_LIMITED] slow down.", {
            status: 429,
          });
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          throw new NvidiaApiError("rate_limited", "[RATE_LIMITED] still limited.", {
            status: 429,
          });
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          yield { choices: [{ delta: { content: "Priority chain response" } }] };
        })(),
      );

    const progress = { report: jest.fn() };

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "moonshotai/kimi-k3",
        name: "Kimi K3",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hi"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call) => call[1].model,
    );
    expect(requestedModels).toEqual([
      "moonshotai/kimi-k3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "minimaxai/minimax-m3",
    ]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Rate limited on Kimi K3. Falling back to Nemotron 3 Ultra 550B.",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Rate limited on Nemotron 3 Ultra 550B. Falling back to MiniMax M3.",
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Priority chain response" }),
    );
  });

  it("throws a structured chain error when every fallback candidate fails", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "fallback.priorityList" ? ["nvidia/nemotron-3-ultra-550b-a55b"] : defaultValue,
      ),
    }));
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "moonshotai/kimi-k3",
            displayName: "Kimi K3",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            displayName: "Nemotron 3 Ultra 550B",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() =>
        (async function* () {
          throw new NvidiaApiError("rate_limited", "[RATE_LIMITED] primary down.", {
            status: 429,
          });
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          throw new NvidiaApiError("rate_limited", "[RATE_LIMITED] fallback down too.", {
            status: 429,
          });
        })(),
      );

    const progress = { report: jest.fn() };

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "moonshotai/kimi-k3",
          name: "Kimi K3",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        makeToken(),
      ),
    ).rejects.toThrow(
      /All NVIDIA NIM failover candidates failed[\s\S]*Tried chain: moonshotai\/kimi-k3 -> nvidia\/nemotron-3-ultra-550b-a55b/,
    );
  });
});
