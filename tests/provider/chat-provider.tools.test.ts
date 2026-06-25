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

  it("streams tool call parts", async () => {
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
                  function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
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
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "meta/llama-4-maverick-17b-128e-instruct",
        maxInputTokens: 100000,
        maxOutputTokens: 16384,
      } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({
        model: "meta/llama-4-maverick-17b-128e-instruct",
        tools: expect.any(Array),
      }),
      expect.any(AbortSignal),
      "test-ua",
      { maxOutputTokens: 16384 },
    );
    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports.length).toBe(1);
    expect(toolCallReports[0][0].callId).toBe("call_1");
    expect(toolCallReports[0][0].name).toBe("get_weather");
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("emits text that appears before a tool call in the same response", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Let me check " } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
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
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(2);
    expect(progress.report.mock.calls[0][0]).toEqual(
      expect.objectContaining({ value: "Let me check " }),
    );
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ callId: "call_1", name: "get_weather" }),
    );
  });

  it("emits text that appears after a tool call in the same response", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

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
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
      yield { choices: [{ delta: { content: "Now I have the weather." } }] };
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
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(2);
    expect(progress.report.mock.calls[0][0]).toEqual(
      expect.objectContaining({ callId: "call_1", name: "get_weather" }),
    );
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ value: "Now I have the weather." }),
    );
  });

  it("sends required tool choice when tool mode requires a tool", async () => {
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
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
        toolMode: 2,
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody.tool_choice).toBe("required");
  });

  it("assembles tool call arguments split across chunks", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

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
                  function: { name: "get_weather", arguments: '{"city": ' },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"Tokyo"}' },
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
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports.length).toBe(1);
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("does not emit tool calls with empty arguments when schema requires fields", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

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
                  function: { name: "read_file", arguments: "{}" },
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
    expect(toolCallReports).toHaveLength(0);
  });

  it("returns a text fallback when all tool calls are skipped as invalid", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

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
                  function: { name: "read_file", arguments: "{}" },
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

    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toContain("filePath");
    expect(textReports[0][0].value).toContain("read_file");
  });

  it("retries once when the model emits an invalid required-argument tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

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

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("read_file"),
        }),
      ]),
    );
    expect(retryRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("filePath, startLine, endLine"),
        }),
      ]),
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 20,
    });
    expect(textReports).toHaveLength(0);
  });

  it("prefers required-argument retry guidance when multiple invalid tool calls are skipped", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const invalidStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>list_dir<|tool_call_argument_begin|>{"path":"/tmp"<|tool_call_end|>',
            },
          },
        ],
      };

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
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
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

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    const retryMessage = retryRequest.messages[retryRequest.messages.length - 1];
    expect(retryMessage).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("read_file"),
      }),
    );
    expect(retryMessage.content).toContain("filePath, startLine, endLine");
    expect(retryMessage.content).not.toContain("list_dir with invalid arguments");

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 20,
    });
    expect(textReports).toHaveLength(0);
  });

  it("prefers required-argument fallback text when multiple invalid tool calls are skipped twice", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const invalidStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>list_dir<|tool_call_argument_begin|>{"path":"/tmp"<|tool_call_end|>',
            },
          },
        ],
      };

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

    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => invalidStream())
      .mockImplementationOnce(() => invalidStream());

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
            name: "list_dir",
            description: "List directory entries",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
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

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(0);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toContain("read_file");
    expect(textReports[0][0].value).toContain("filePath");
    expect(textReports[0][0].value).toContain("startLine");
    expect(textReports[0][0].value).toContain("endLine");
    expect(textReports[0][0].value).not.toContain("list_dir with invalid arguments");
  });

  it("returns a text fallback when invalid tool calls are preceded by whitespace content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: " " } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
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

    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toContain("filePath");
    expect(textReports[0][0].value).toContain("read_file");
  });

});
