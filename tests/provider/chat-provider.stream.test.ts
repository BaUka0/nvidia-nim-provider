import * as vscode from "vscode";
import { fetchModels, streamChatCompletion } from "../../src/api/client";
import { CONTEXT_WINDOW_SAFETY_MARGIN } from "../../src/shared/constants";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { NvidiaApiError } from "../../src/api/errors";
import { getApiKeyFingerprint } from "../../src/api/key-resolver";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
} from "../../src/shared/constants";

jest.mock("../../src/api/client", () => ({
  fetchModels: jest.fn(),
  streamChatCompletion: jest.fn(),
}));

jest.mock("vscode", () => ({
  SecretStorage: class {},
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 0 },
  LanguageModelChatMessage: {
    User: (content: unknown[]) => ({ role: 1, content }),
  },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class {
    constructor(
      public callId: string,
      public name: string,
      public input: Record<string, unknown>,
    ) {}
  },
  LanguageModelToolResultPart: class {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  },
  LanguageModelThinkingPart: class {
    constructor(public value: string) {}
  },
  window: {
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
    showInputBox: jest.fn(),
    showInformationMessage: jest.fn().mockResolvedValue(undefined),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    })),
  },
  LanguageModelError: {
    NoPermissions: (msg: string) => new Error(msg),
    NotFound: (msg: string) => new Error(msg),
    Blocked: (msg: string) => new Error(msg),
  },
  CancellationError: class extends Error {},
  EventEmitter: class {
    event = jest.fn();
    fire = jest.fn();
  },
  Memento: class {},
}));

describe("NimChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let globalState: vscode.Memento;
  let provider: NimChatModelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = {
      get: jest.fn(),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(),
    } as unknown as vscode.SecretStorage;
    globalState = {
      get: jest.fn().mockImplementation((key: string) =>
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
      ),
      update: jest.fn(),
      keys: jest.fn(),
    } as unknown as vscode.Memento;
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
      { maxOutputTokens: 65536 },
    );
    expect(progress.report).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: "Hello" }));
    expect(progress.report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ value: " world" }),
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "nim-any-model", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );

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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingIndices = allReports
      .map((r: any, i: number) => (r instanceof ThinkingPart ? i : -1))
      .filter((i: number) => i !== -1);
    const textIndices = allReports
      .map((r: any, i: number) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-ai/deepseek-v4", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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

  it("flushes buffered reasoning even when no content follows", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Only reasoning, no answer" } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-ai/deepseek-v4", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(
      expect.objectContaining({ value: "Only reasoning, no answer" }),
    );
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingIndices = allReports
      .map((r: any, i: number) => (r instanceof ThinkingPart ? i : -1))
      .filter((i: number) => i !== -1);
    const textIndices = allReports
      .map((r: any, i: number) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingText = allReports
      .filter((r: any) => r instanceof ThinkingPart)
      .map((r: any) => r.value)
      .join("");
    const textIndices = allReports
      .map((r: any, i: number) => (r instanceof vscode.LanguageModelTextPart ? i : -1))
      .filter((i: number) => i !== -1);

    expect(thinkingText).toContain("proper reasoning start");
    expect(thinkingText).toContain("leaked reasoning continuation");
    expect(textIndices).toHaveLength(1);
    expect(allReports[textIndices[0]]).toEqual(
      expect.objectContaining({ value: "actual answer text" }),
    );
  });

  it("keeps split content after reasoning_content in thinking until orphaned close", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "proper reasoning start" } }] };
      yield { choices: [{ delta: { content: "leaked reasoning part one" } }] };
      yield { choices: [{ delta: { content: " and part two" + closeTag } }] };
      yield { choices: [{ delta: { content: "actual answer text" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingText = allReports
      .filter((r: any) => r instanceof ThinkingPart)
      .map((r: any) => r.value)
      .join("");
    const textReports = allReports.filter((r: any) => r instanceof vscode.LanguageModelTextPart);
    const textContent = textReports.map((r: any) => r.value).join("");

    expect(thinkingText).toContain("proper reasoning start");
    expect(thinkingText).toContain("leaked reasoning part one and part two");
    expect(textReports).toHaveLength(1);
    expect(textContent).toBe("actual answer text");
    expect(textContent).not.toContain("leaked reasoning");
  });

  it("routes content to answer after reasoning_content has finished if no close tag exists in content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "proper reasoning start" } }] };
      yield { choices: [{ delta: { content: "actual answer text" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = {
      report: jest.fn().mockImplementation((part) => {
        console.log("TEST REPORT PART:", part);
      }),
    };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingText = allReports
      .filter((r: any) => r instanceof ThinkingPart)
      .map((r: any) => r.value)
      .join("");
    const textReports = allReports.filter((r: any) => r instanceof vscode.LanguageModelTextPart);
    const textContent = textReports.map((r: any) => r.value).join("");

    expect(thinkingText).toBe("proper reasoning start");
    expect(textReports).toHaveLength(1);
    expect(textContent).toBe("actual answer text");
  });

  it("logs raw stream chunk metadata when debug logging is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      };

      await provider.provideLanguageModelChatResponse(
        { id: "deepseek-ai/deepseek-v4", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        progress,
        token as any,
      );

      const chunkLogs = consoleSpy.mock.calls.filter((c: any) => c[0]?.includes?.("stream chunk"));
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
    }
  });

  it("routes untagged content to thinking when reasoning is expected but reasoning_content is absent", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Now let me look" } }] };
      yield { choices: [{ delta: { content: " at the code" } }] };
      yield { choices: [{ delta: { content: " to understand" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports.length).toBeGreaterThanOrEqual(1);
    expect(textReports).toHaveLength(0);
    const thinkingText = thinkingReports.map((r: any) => r[0].value).join("");
    expect(thinkingText).toContain("Now let me look at the code to understand");
  });

  it("keeps ambiguous content in thinking until an explicit reasoning close tag", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "thinking without tags" } }] };
      yield { choices: [{ delta: { reasoning_content: "proper reasoning" } }] };
      yield { choices: [{ delta: { content: "ambiguous continuation" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingText = allReports
      .filter((r: any) => r instanceof ThinkingPart)
      .map((r: any) => r.value)
      .join("");
    const textReports = allReports.filter((r: any) => r instanceof vscode.LanguageModelTextPart);

    expect(textReports).toHaveLength(0);
    expect(thinkingText).toContain("thinking without tags");
    expect(thinkingText).toContain("proper reasoning");
    expect(thinkingText).toContain("ambiguous continuation");
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "z-ai/glm-5.2", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "none" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(
      expect.objectContaining({ value: "Direct answer without reasoning" }),
    );
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({
        chat_template_kwargs: expect.objectContaining({ enable_thinking: false }),
      }),
      expect.any(AbortSignal),
      "test-ua",
      { maxOutputTokens: 65536 },
    );
  });

  it("does not route content to thinking for models without reasoning_content support", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Answer from non-reasoning model" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "meta/llama-4-maverick-17b-128e-instruct",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "thinkingmachines/inkling", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "medium" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0]).toEqual(expect.objectContaining({ value: "Inkling final answer" }));
  });

  it("separates Laguna reasoning before an orphaned close tag and removes its control marker", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: { content: "Laguna reasoning</think>Laguna final answer ∆" },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "poolside/laguna-xs-2.1", maxInputTokens: 100000, maxOutputTokens: 16384 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingText = progress.report.mock.calls
      .filter((c: any) => c[0] instanceof ThinkingPart)
      .map((c: any) => c[0].value)
      .join("");
    const answerText = progress.report.mock.calls
      .filter((c: any) => c[0] instanceof vscode.LanguageModelTextPart)
      .map((c: any) => c[0].value)
      .join("");

    expect(thinkingText).toBe("Laguna reasoning");
    expect(answerText).toBe("Laguna final answer");
    expect(answerText).not.toContain("∆");
  });

  it("returns a Laguna content-only response when reasoning output is absent", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [{ delta: { content: "Привет! Я могу помочь." } }],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "poolside/laguna-xs-2.1", maxInputTokens: 100000, maxOutputTokens: 16384 } as any,
      [{ role: 1, content: [{ value: "Привет" }] }] as any,
      { modelConfiguration: { reasoningMode: "on" }, modelOptions: {} } as any,
      progress,
      token as any,
    );

    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );
    expect(textReports.map((c: any) => c[0].value).join("")).toBe("Привет! Я могу помочь.");
  });

  it("emits think-tag content as a thinking part for kimi models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "<think>my reasoning</think>visible answer" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
    );

    expect(thinkingReports).toHaveLength(1);
    expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "Initial reasoning" }));
    const textContent = textReports.map((r: any) => r[0].value).join("");
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "minimaxai/minimax-m3", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const thinkingReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof ThinkingPart,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: any) => c[0] instanceof vscode.LanguageModelTextPart,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "stepfun-ai/step-3.7-flash", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
    const allReports = progress.report.mock.calls.map((c: any) => c[0]);
    const thinkingText = allReports
      .filter((r: any) => r instanceof ThinkingPart)
      .map((r: any) => r.value)
      .join("");
    const textReports = allReports.filter((r: any) => r instanceof vscode.LanguageModelTextPart);
    const textContent = textReports.map((r: any) => r.value).join("");

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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: {
          toolCalling: 128,
          imageInput: false,
        },
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
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
      } as any,
      progress,
      token as any,
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
            id: "deepseek-ai/deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash",
            contextWindow: 1000000,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi k2.6",
        detail: "NVIDIA NIM",
        family: "nvidia-nim",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: true },
      } as any,
      [
        {
          role: 1,
          content: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
        },
      ] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.stringContaining("does not support image input") }),
    );
  });

  it("reports unsupported image input for non-vision normalized models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ]);

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "deepseek-ai/deepseek-v4-pro",
        maxInputTokens: 100000,
        maxOutputTokens: 384000,
      } as any,
      [
        {
          role: 1,
          content: [
            { value: "What is in this image?" },
            { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          ],
        },
      ] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.stringContaining("does not support image input") }),
    );
  });

  it("converts image parts to image_url content for vision-capable normalized models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "minimaxai/minimax-m3",
        displayName: "MiniMax M3",
        contextWindow: 1000000,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "minimaxai/minimax-m3",
        maxInputTokens: 100000,
        maxOutputTokens: 100000,
      } as any,
      [
        {
          role: 1,
          content: [
            { value: "What is in this image?" },
            { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          ],
        },
      ] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        { id: "kimi-k2.6", maxInputTokens: 1, maxOutputTokens: 65536 } as any,
        [
          {
            role: 1,
            content: [{ value: "This is a very long message that exceeds the token limit" }],
          },
        ] as any,
        { modelOptions: {} } as any,
        progress,
        token as any,
      ),
    ).rejects.toThrow("[TOKEN_LIMIT_EXCEEDED]");
  });

  it("caps max_tokens to the remaining context budget", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi K2.6",
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const prompt = "a".repeat(900);

    await provider.provideLanguageModelChatResponse(
      { id: "moonshotai/kimi-k2.6", maxInputTokens: 5000, maxOutputTokens: 200000 } as any,
      [{ role: 1, content: [{ value: prompt }] }] as any,
      { modelOptions: { max_tokens: 120000 } } as any,
      progress,
      token as any,
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;

      await provider.provideLanguageModelChatResponse(
        {
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Inspect the workspace" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        { modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;

      await provider.provideLanguageModelChatResponse(
        {
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Inspect the workspace" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        { modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;

      await provider.provideLanguageModelChatResponse(
        {
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Read the file" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        {
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
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;

      await provider.provideLanguageModelChatResponse(
        {
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Inspect the workspace" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        { modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;

      await provider.provideLanguageModelChatResponse(
        {
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Inspect the workspace" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        {
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
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    } as unknown as vscode.CancellationToken;

    try {
      await provider.provideLanguageModelChatResponse(
        {
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: {
            toolCalling: 128,
            imageInput: false,
          },
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Read the file" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        {
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
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    } as unknown as vscode.CancellationToken;

    try {
      await provider.provideLanguageModelChatResponse(
        {
          id: "kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
        } as unknown as vscode.LanguageModelChatInformation,
        [
          { role: 1, content: [{ value: "Read the file" }] },
        ] as unknown as vscode.LanguageModelChatMessage[],
        {
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
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
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
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue("new-api-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from NVIDIA NIM" } }] };
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect((vscode as any).window.showInputBox).toHaveBeenCalled();
    expect(secrets.store).toHaveBeenCalledWith("nvidia-nim.apiKey", "new-api-key");
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "new-api-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
      { maxOutputTokens: 65536 },
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Hello from NVIDIA NIM" }),
    );

    // The same picker model may retain an old provider-group binding after a
    // key was removed. A key entered interactively must rebind that model so
    // the next request reuses it instead of opening another prompt.
    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi again" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect((vscode as any).window.showInputBox).toHaveBeenCalledTimes(1);
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
      {
        id: "configured-model",
        name: "Configured Model",
        family: "nvidia-nim",
        version: "1.0.0",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: {},
        apiKey: "configured-key",
      } as any,
      [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart("Hi")])],
      { modelOptions: {} } as any,
      progress as any,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "configured-key",
      expect.anything(),
      expect.any(AbortSignal),
      "test-ua",
      { maxOutputTokens: 65536 },
    );
    expect((vscode as any).window.showInputBox).not.toHaveBeenCalled();
  });

  it("returns setup guidance in chat when no API key is available", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.stringContaining("NVIDIA NIM API key") }),
    );
  });

  it("falls back to DeepSeek Flash on rate limit (429)", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi k2.6",
              contextWindow: 256000,
              maxOutputTokens: 262144,
              supportsTools: true,
              supportsVision: true,
            },
            {
              id: "deepseek-ai/deepseek-v4-flash",
              displayName: "DeepSeek V4 Flash",
              contextWindow: 1000000,
              maxOutputTokens: 384000,
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

    const rateLimitError = new Error("[RATE_LIMITED] Rate limited.\nRetry after 30.");
    const rateLimitedStream = async function* () {
      throw rateLimitError;
    };
    const fallbackStream = async function* () {
      yield { choices: [{ delta: { content: "Fallback response" } }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => rateLimitedStream())
      .mockImplementationOnce(() => fallbackStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi k2.6",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const fallbackRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(fallbackRequest.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect((vscode as any).window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Falling back to DeepSeek V4 Flash"),
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Fallback response" }),
    );
  });

  it.each([
    ["deepseek-ai/deepseek-v4-flash", false],
    ["deepseek-ai/deepseek-v4-pro", false],
    ["minimaxai/minimax-m3", true],
    ["moonshotai/kimi-k2.6", true],
    ["nvidia/nemotron-3-ultra-550b-a55b", false],
    ["z-ai/glm-5.2", false],
    ["stepfun-ai/step-3.7-flash", true],
    ["thinkingmachines/inkling", true],
    ["poolside/laguna-xs-2.1", false],
  ] as const)("enforces the curated vision capability for %s", async (modelId, supportsVision) => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Vision response" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());
    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: modelId,
        name: modelId,
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: supportsVision },
      } as any,
      [
        {
          role: 1,
          content: [
            { value: "Describe this" },
            { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          ],
        },
      ] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    if (!supportsVision) {
      expect(streamChatCompletion).not.toHaveBeenCalled();
      expect(progress.report).toHaveBeenCalledWith(
        expect.objectContaining({ value: expect.stringContaining("does not support image input") }),
      );
      return;
    }

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
    const rateLimitError = new Error("[RATE_LIMITED] Rate limited.\nRetry after 30.");
    const partialStream = async function* () {
      yield { choices: [{ delta: { content: "Partial response" } }] };
      throw rateLimitError;
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => partialStream());
    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        {
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        progress,
        token as any,
      ),
    ).rejects.toThrow("[RATE_LIMITED]");

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Partial response" }),
    );
    expect((vscode as any).window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Falling back"),
    );
  });

  it("does not fall back on rate limit when DeepSeek Flash is unavailable", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi k2.6",
              contextWindow: 256000,
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
      throw new Error("[RATE_LIMITED] Rate limited.\nRetry after 30.");
    };
    (streamChatCompletion as jest.Mock).mockImplementation(() => rateLimitedStream());

    await expect(
      provider.provideLanguageModelChatResponse(
        {
          id: "moonshotai/kimi-k2.6",
          name: "Kimi k2.6",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        { report: jest.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
        } as any,
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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: true },
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
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
              id: "moonshotai/kimi-k2.6",
              displayName: "Kimi K2.6",
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
      {
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 5000,
        maxOutputTokens: 1000,
        capabilities: { toolCalling: 128, imageInput: true },
      } as any,
      [{ role: 1, content: [{ value: "a".repeat(900) }] }] as any,
      { modelOptions: { max_tokens: 1000 } } as any,
      { report: jest.fn() },
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as any,
    );

    const firstRequest = (streamChatCompletion as jest.Mock).mock.calls[0][1];
    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages).toHaveLength(firstRequest.messages.length + 1);
    expect(retryRequest.max_tokens).toBeLessThan(firstRequest.max_tokens);
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
        {
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        progress,
        {
          isCancellationRequested: false,
          onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
        } as any,
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
    ((vscode as any).window.showInputBox as jest.Mock).mockReturnValue(promptResult);
    (streamChatCompletion as jest.Mock).mockImplementation(() =>
      (async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      })(),
    );
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const makeRequest = () =>
      provider.provideLanguageModelChatResponse(
        {
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        { report: jest.fn() },
        token as any,
      );

    const requests = [makeRequest(), makeRequest()];
    for (
      let attempt = 0;
      attempt < 10 && !((vscode as any).window.showInputBox as jest.Mock).mock.calls.length;
      attempt += 1
    ) {
      await Promise.resolve();
    }

    expect((vscode as any).window.showInputBox).toHaveBeenCalledTimes(1);
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
      {
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: true },
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      { report: jest.fn() },
      token as any,
    );

    for (let attempt = 0; attempt < 10 && !streamSignal; attempt += 1) {
      await Promise.resolve();
    }
    await Promise.resolve();
    cancelled = true;
    cancelListener?.();

    await expect(request).rejects.toBeInstanceOf((vscode as any).CancellationError);
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
        {
          id: "moonshotai/kimi-k2.6",
          maxInputTokens: 100000,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: 128, imageInput: true },
        } as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        { report: jest.fn() },
        token as any,
      ),
    ).rejects.toBeInstanceOf((vscode as any).CancellationError);

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
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "Recovered" }));
  });
});
