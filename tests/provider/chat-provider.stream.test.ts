import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { fetchModels, streamChatCompletion } from "../../src/api/client";
import { CONTEXT_WINDOW_SAFETY_MARGIN } from "../../src/shared/constants";
import { NimChatModelProvider as OcGoChatModelProvider } from "../../src/provider/chat-provider";

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

interface StreamTextFixtureCase {
  name: string;
  chunks: string[];
  expectedText: string;
}

interface MixedToolCallFixtureCase {
  name: string;
  chunks: string[];
  expectedBefore: string;
  expectedAfter: string;
  expectedToolName: string;
  expectedToolInput: Record<string, string>;
}

interface InvalidToolCallFixtureCase {
  name: string;
  chunks: string[];
  expectedToolName: string;
  expectedRequiredArgs: string[];
}

interface GenericInvalidToolCallFixtureCase {
  name: string;
  modelId: string;
  chunks: string[];
  expectedBefore: string;
  expectedToolName: string;
  forbiddenMarker: string;
}

function loadProviderFixture<T>(fixtureName: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "provider", fixtureName), "utf8"),
  ) as T;
}

describe("OcGoChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let globalState: vscode.Memento;
  let provider: OcGoChatModelProvider;

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
    provider = new OcGoChatModelProvider(secrets, "test-ua", globalState);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);
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
    expect(progress.report).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "Hello world" }));
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

  it("emits reasoning_content deltas as thinking parts", async () => {
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

  it("reports unsupported image input for non-vision normalized models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "meta/llama-4-maverick-17b-128e-instruct",
        displayName: "Llama 4 Maverick 17B 128E Instruct",
        contextWindow: 131072,
        maxOutputTokens: 16384,
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
        id: "meta/llama-4-maverick-17b-128e-instruct",
        maxInputTokens: 100000,
        maxOutputTokens: 16384,
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
        id: "meta/llama-4-maverick-17b-128e-instruct",
        displayName: "Llama 4 Maverick 17B 128E Instruct",
        contextWindow: 131072,
        maxOutputTokens: 16384,
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
        id: "meta/llama-4-maverick-17b-128e-instruct",
        maxInputTokens: 100000,
        maxOutputTokens: 16384,
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
    expect(requestBody.model).toBe("meta/llama-4-maverick-17b-128e-instruct");
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
              id: "kimi-k2.6",
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
      { id: "kimi-k2.6", maxInputTokens: 5000, maxOutputTokens: 200000 } as any,
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
});
