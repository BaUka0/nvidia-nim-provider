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
    readFileSync(join(__dirname, "..", "fixtures", "provider", fixtureName), "utf8"),
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
                id: "nemotron-70b",
                displayName: "Nemotron 70B",
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

  it("emits a tool call parsed from text-embedded control tokens", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/example.md"}<|tool_call_end|>',
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
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("emits a tool call parsed from DeepSeek-style text-embedded control tokens", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"filePath":"/tmp/example.md"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
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
      { id: "deepseek-ai/deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
    expect(textReports).toHaveLength(0);
  });

  it("strips raw DSML control markers from streamed text output", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content: "Let me inspect the workspace.\n\n<｜DSML｜tool_calls",
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
      { id: "deepseek-ai/deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Inspect the workspace" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toBe("Let me inspect the workspace.\n\n");
  });

  it.each(
    loadProviderFixture<StreamTextFixtureCase[]>("split-dsml-control-text.json").map(
      ({ name, chunks, expectedText }) => [name, chunks, expectedText] as const,
    ),
  )(
    "strips split DSML control markers from streamed text output: %s",
    async (_fixtureName: string, chunks: string[], expectedText: string) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: "deepseek-ai/deepseek-v4-pro",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Inspect the workspace")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(textReports).toHaveLength(1);
      expect(textReports[0][0]).toEqual(expect.objectContaining({ value: expectedText }));
    },
  );

  it.each(
    loadProviderFixture<StreamTextFixtureCase[]>("truncated-control-text.json").map(
      ({ name, chunks, expectedText }) => [name, chunks, expectedText] as const,
    ),
  )(
    "suppresses truncated control text at stream end: %s",
    async (_fixtureName: string, chunks: string[], expectedText: string) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: "deepseek-ai/deepseek-v4-pro",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Inspect the workspace")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(textReports).toHaveLength(1);
      expect(textReports[0][0]).toEqual(expect.objectContaining({ value: expectedText }));
    },
  );

  it.each(
    loadProviderFixture<MixedToolCallFixtureCase[]>("deepseek-mixed-tool-call.json").map(
      ({ name, chunks, expectedBefore, expectedAfter, expectedToolName, expectedToolInput }) =>
        [name, chunks, expectedBefore, expectedAfter, expectedToolName, expectedToolInput] as const,
    ),
  )(
    "preserves text order around a DeepSeek-style tool call: %s",
    async (
      _fixtureName: string,
      chunks: string[],
      expectedBefore: string,
      expectedAfter: string,
      expectedToolName: string,
      expectedToolInput: Record<string, string>,
    ) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: "deepseek-ai/deepseek-v4-pro",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Inspect the workspace")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      expect(progress.report.mock.calls).toHaveLength(3);
      expect(progress.report.mock.calls[0][0]).toEqual(
        expect.objectContaining({ value: expectedBefore }),
      );
      expect(progress.report.mock.calls[1][0]).toEqual(
        expect.objectContaining({ name: expectedToolName, input: expectedToolInput }),
      );
      expect(progress.report.mock.calls[2][0]).toEqual(
        expect.objectContaining({ value: expectedAfter }),
      );
    },
  );

  it.each(
    loadProviderFixture<InvalidToolCallFixtureCase[]>("deepseek-invalid-tool-call.json").map(
      ({ name, chunks, expectedToolName, expectedRequiredArgs }) =>
        [name, chunks, expectedToolName, expectedRequiredArgs] as const,
    ),
  )(
    "falls back to text for malformed DeepSeek-style tool calls: %s",
    async (
      _fixtureName: string,
      chunks: string[],
      expectedToolName: string,
      expectedRequiredArgs: string[],
    ) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: "deepseek-ai/deepseek-v4-pro",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Read the file")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const toolCallReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "callId" in (call[0] as object),
      );
      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(toolCallReports).toHaveLength(0);
      expect(textReports).toHaveLength(1);
      expect(textReports[0][0]).toEqual(
        expect.objectContaining({
          value: expect.stringContaining(expectedToolName),
        }),
      );
      for (const arg of expectedRequiredArgs) {
        expect(textReports[0][0]).toEqual(
          expect.objectContaining({
            value: expect.stringContaining(arg),
          }),
        );
      }
      expect(textReports[0][0]).toEqual(
        expect.not.objectContaining({
          value: expect.stringContaining("<｜tool"),
        }),
      );
    },
  );

  it.each(
    loadProviderFixture<InvalidToolCallFixtureCase[]>("openai-invalid-tool-call.json").map(
      ({ name, chunks, expectedToolName, expectedRequiredArgs }) =>
        [name, chunks, expectedToolName, expectedRequiredArgs] as const,
    ),
  )(
    "falls back to text for malformed OpenAI-style tool calls: %s",
    async (
      _fixtureName: string,
      chunks: string[],
      expectedToolName: string,
      expectedRequiredArgs: string[],
    ) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: "kimi-k2.6",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Read the file")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const toolCallReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "callId" in (call[0] as object),
      );
      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(toolCallReports).toHaveLength(0);
      expect(textReports).toHaveLength(1);
      expect(textReports[0][0]).toEqual(
        expect.objectContaining({
          value: expect.stringContaining(expectedToolName),
        }),
      );
      for (const arg of expectedRequiredArgs) {
        expect(textReports[0][0]).toEqual(
          expect.objectContaining({
            value: expect.stringContaining(arg),
          }),
        );
      }
      expect(textReports[0][0]).toEqual(
        expect.not.objectContaining({
          value: expect.stringContaining("<|tool_call"),
        }),
      );
    },
  );

  it.each(
    loadProviderFixture<GenericInvalidToolCallFixtureCase[]>("generic-invalid-tool-call.json").map(
      ({ name, modelId, chunks, expectedBefore, expectedToolName, forbiddenMarker }) =>
        [name, modelId, chunks, expectedBefore, expectedToolName, forbiddenMarker] as const,
    ),
  )(
    "returns a generic fallback for malformed optional-argument tool calls: %s",
    async (
      _fixtureName: string,
      modelId: string,
      chunks: string[],
      expectedBefore: string,
      expectedToolName: string,
      forbiddenMarker: string,
    ) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const mockStream = async function* () {
        for (const content of chunks) {
          yield {
            choices: [
              {
                delta: {
                  content,
                },
              },
            ],
          };
        }
      };
      (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: modelId,
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("List the directory")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List directory entries",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const toolCallReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "callId" in (call[0] as object),
      );
      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(toolCallReports).toHaveLength(0);
      expect(textReports).toHaveLength(2);
      expect(textReports[0][0]).toEqual(expect.objectContaining({ value: expectedBefore }));
      expect(textReports[1][0]).toEqual(
        expect.objectContaining({
          value: expect.stringContaining(expectedToolName),
        }),
      );
      expect(textReports[1][0]).toEqual(
        expect.objectContaining({
          value: expect.stringContaining("invalid arguments"),
        }),
      );
      expect(textReports[1][0]).toEqual(
        expect.not.objectContaining({
          value: expect.stringContaining(forbiddenMarker),
        }),
      );
    },
  );

  it.each([
    {
      name: "openai-style optional tool call",
      modelId: "kimi-k2.6",
      invalidChunks: [
        '<|tool_call_begin|>list_dir<|tool_call_argument_begin|>{"path":"/tmp"<|tool_call_end|>',
      ],
      repairedChunks: [
        '<|tool_call_begin|>list_dir<|tool_call_argument_begin|>{"path":"/tmp"}<|tool_call_end|>',
      ],
      forbiddenMarker: "<|tool_call",
    },
    {
      name: "DeepSeek-style optional tool call",
      modelId: "deepseek-ai/deepseek-v4-pro",
      invalidChunks: [
        '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>list_dir\n```json\n{"path":"/tmp"\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
      ],
      repairedChunks: [
        '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>list_dir\n```json\n{"path":"/tmp"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
      ],
      forbiddenMarker: "<｜tool",
    },
  ])(
    "retries once when the model emits a malformed optional-argument tool call: $name",
    async ({ modelId, invalidChunks, repairedChunks, forbiddenMarker }) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");

      const invalidStream = async function* () {
        for (const content of invalidChunks) {
          yield { choices: [{ delta: { content } }] };
        }
      };

      const repairedStream = async function* () {
        for (const content of repairedChunks) {
          yield { choices: [{ delta: { content } }] };
        }
      };

      (streamChatCompletion as jest.Mock)
        .mockImplementationOnce(() => invalidStream())
        .mockImplementationOnce(() => repairedStream());

      const progress = { report: jest.fn() };
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as unknown as vscode.CancellationToken;
      const model = {
        id: modelId,
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("List the directory")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List directory entries",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      expect(streamChatCompletion).toHaveBeenCalledTimes(2);

      const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
      expect(retryRequest.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("list_dir"),
          }),
        ]),
      );
      expect(retryRequest.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("invalid or incomplete arguments"),
          }),
        ]),
      );
      expect(retryRequest.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Do not emit malformed JSON or empty arguments."),
          }),
        ]),
      );

      const toolCallReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "callId" in (call[0] as object),
      );
      const textReports = progress.report.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" && call[0] !== null && "value" in (call[0] as object),
      );

      expect(toolCallReports).toHaveLength(1);
      expect(toolCallReports[0][0]).toEqual(
        expect.objectContaining({
          name: "list_dir",
          input: { path: "/tmp" },
        }),
      );
      expect(textReports).toHaveLength(0);
      expect(retryRequest.messages).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(forbiddenMarker),
          }),
        ]),
      );
    },
  );

  it("applies the DeepSeek request profile defaults when tools are enabled", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "deepseek-ai/deepseek-v4-pro",
              displayName: "deepseek-v4-pro",
              contextWindow: 131072,
              maxOutputTokens: 16384,
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

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-ai/deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Inspect the workspace" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];

    expect(requestBody.temperature).toBe(0);
    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not reveal internal control tokens"),
        }),
      ]),
    );
  });

  it("keeps explicit temperature overrides for DeepSeek request profiles", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
      key === "nvidia-nim.models"
        ? [
            {
              id: "deepseek-ai/deepseek-v4-pro",
              displayName: "deepseek-v4-pro",
              contextWindow: 131072,
              maxOutputTokens: 16384,
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

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-ai/deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Inspect the workspace" }] }] as any,
      {
        modelOptions: { temperature: 0.35 },
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];

    expect(requestBody.temperature).toBe(0.35);
  });

  it.each([
    ["kimi-k2.6", 0.1, "Do not reveal chain-of-thought"],
    ["zai-org/glm-4.5", 0.05, "strict JSON arguments"],
    ["nemotron-70b", 0.1, "Do not wrap tool arguments in markdown fences"],
  ])(
    "applies the provider request profile for %s when tools are enabled",
    async (modelId: string, expectedTemperature: number, expectedMessageSnippet: string) => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");
      (globalState.get as jest.Mock).mockImplementation((key: string) =>
        key === "nvidia-nim.models"
          ? [
              {
                id: modelId,
                displayName: modelId,
                contextWindow: 131072,
                maxOutputTokens: 16384,
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
      } as unknown as vscode.CancellationToken;
      const model = {
        id: modelId,
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
      } as vscode.LanguageModelChatInformation;
      const requestMessages = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Inspect the workspace")],
        },
      ] as unknown as vscode.LanguageModelChatMessage[];
      const requestOptions = {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

      await provider.provideLanguageModelChatResponse(
        model,
        requestMessages,
        requestOptions,
        progress,
        token,
      );

      const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];

      expect(requestBody.temperature).toBe(expectedTemperature);
      expect(requestBody.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(expectedMessageSnippet),
          }),
        ]),
      );
    },
  );

  it("preserves text order around a text-embedded tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                'Before <|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/example.md"}<|tool_call_end|> after',
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
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(3);
    expect(progress.report.mock.calls[0][0]).toEqual(expect.objectContaining({ value: "Before " }));
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ name: "read_file" }),
    );
    expect(progress.report.mock.calls[2][0]).toEqual(expect.objectContaining({ value: " after" }));
  });

  it("emits a tool call when text-embedded control tokens are split across chunks", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/exa',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content: 'mple.md"}<|tool_call_end|>',
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
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
    expect(textReports).toHaveLength(0);
  });
});
