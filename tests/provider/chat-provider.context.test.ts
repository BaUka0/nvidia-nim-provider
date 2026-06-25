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

  it("repairs empty read_file arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 158 to line 158.\n</editorContext>\n<userRequest>ツールを使ってファイルを読み込んでみてください</userRequest>",
            },
          ],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 158,
      endLine: 158,
    });
  });

  it("repairs missing read_file line arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: '{"filePath":"/tmp/example.md"}' },
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the current selection</userRequest>",
            },
          ],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 42,
      endLine: 45,
    });
  });

  it("does not inject selection lines when read_file line arguments are optional", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: '{"filePath":"/tmp/example.md"}' },
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the whole file</userRequest>",
            },
          ],
        },
      ] as any,
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
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("repairs read_file with the current file path even when no selection lines are provided", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Read the open file</userRequest>",
            },
          ],
        },
      ] as any,
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
              },
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
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("defaults read_file line arguments when the schema requires a range but chat only provides the current file", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Check the current file</userRequest>",
            },
          ],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 200,
    });
  });

  it("repairs list_dir with the current working directory from chat context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "list_dir:0",
                  type: "function",
                  function: { name: "list_dir", arguments: "{}" },
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<userRequest>List files in the current directory</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List files in a directory",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("list_dir");
    expect(toolCallReports[0][0].input).toEqual({ path: "/tmp/workspace" });
  });

  it("waits for later streamed arguments before validating a tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "grep_search:0",
                  type: "function",
                  function: { name: "grep_search" },
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
                  function: { arguments: '{"query":"causal","isRegexp":false}' },
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
      [{ role: 1, content: [{ value: "Test the memory tool" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "grep_search",
            description: "Search notes by text",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query",
                },
                isRegexp: {
                  type: "boolean",
                  description: "Whether query is a regular expression",
                },
              },
              required: ["query", "isRegexp"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("grep_search");
    expect(toolCallReports[0][0].input).toEqual({ query: "causal", isRegexp: false });
  });

  it("repairs text-embedded read_file arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                "<|tool_call_begin|>read_file<|tool_call_argument_begin|>{}<|tool_call_end|>",
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
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 10 to line 12.\n</editorContext>\n<userRequest>Read the selected lines</userRequest>",
            },
          ],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 10,
      endLine: 12,
    });
  });

  it("suppresses an immediate duplicate of the just-completed tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":158,"endLine":158}',
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
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("read_file:0", [
              new (vscode as any).LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(0);
  });

  it("allows the same tool call again after an intervening user message", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":158,"endLine":158}',
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
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("read_file:0", [
              new (vscode as any).LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
        {
          role: 1,
          content: [new (vscode as any).LanguageModelTextPart("Read that same line again.")],
        },
      ] as any,
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

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0]).toEqual(
      expect.objectContaining({ callId: "read_file:1", name: "read_file" }),
    );
  });

  it("sends non-empty reasoning_content for assistant tool call history", async () => {
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
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelTextPart("Let me check"),
            new (vscode as any).LanguageModelToolCallPart("call_1", "get_weather", {
              city: "Tokyo",
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("call_1", [
              new (vscode as any).LanguageModelTextPart("Sunny, 25C"),
            ]),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody).toBeDefined();
    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: " ",
          tool_calls: expect.any(Array),
        }),
      ]),
    );
  });
});
