import * as vscode from "vscode";
import { chatCompletion, streamChatCompletion } from "../../src/api/client";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { NvidiaApiError } from "../../src/api/errors";
import {
  getLanguageModelThinkingPart,
  makeChatOptions,
  makeMemento,
  makeMessages,
  makeModel,
  makeSecrets,
  makeToken,
  makeUserMessages,
} from "../helpers/fakes";

jest.mock("../../src/api/client", () => ({
  chatCompletion: jest.fn(),
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
      get: jest.fn((key: string, defaultValue: unknown) => defaultValue),
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
  });

  it("does not invent read_file filePath from editor-context chat text", async () => {
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
    (streamChatCompletion as jest.Mock).mockImplementation(() => mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 158 to line 158.\n</editorContext>\n<userRequest>ツールを使ってファイルを読み込んでみてください</userRequest>",
          },
        ],
      }),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(0);
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the current selection</userRequest>",
          },
        ],
      }),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 200,
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the whole file</userRequest>",
          },
        ],
      }),
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
              required: ["filePath"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("does not invent read_file filePath from editor context when the model omits it", async () => {
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
    (streamChatCompletion as jest.Mock).mockImplementation(() => mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Read the open file</userRequest>",
          },
        ],
      }),
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
              },
              required: ["filePath"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(0);
  });

  it("defaults read_file range to 1-200 when the model supplies filePath without lines", async () => {
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
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md"}',
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
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Check the current file</userRequest>",
          },
        ],
      }),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 200,
    });
  });

  it("emits list_dir when the model supplies path without copying regex Cwd", async () => {
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
                  function: { name: "list_dir", arguments: '{"path":"/tmp/workspace"}' },
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
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<context>\nCwd: /tmp/workspace\n</context>\n<userRequest>List files in the current directory</userRequest>",
          },
        ],
      }),
      makeChatOptions({
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
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Test the memory tool"),
      makeChatOptions({
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
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
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
                '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/example.md"}<|tool_call_end|>',
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages({
        role: 1,
        content: [
          {
            value:
              "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 10 to line 12.\n</editorContext>\n<userRequest>Read the selected lines</userRequest>",
          },
        ],
      }),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 200,
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages(
        {
          role: 2,
          content: [
            new vscode.LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new vscode.LanguageModelToolResultPart("read_file:0", [
              new vscode.LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
      ),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages(
        {
          role: 2,
          content: [
            new vscode.LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new vscode.LanguageModelToolResultPart("read_file:0", [
              new vscode.LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
        {
          role: 1,
          content: [new vscode.LanguageModelTextPart("Read that same line again.")],
        },
      ),
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

    const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeMessages(
        {
          role: 2,
          content: [
            new vscode.LanguageModelTextPart("Let me check"),
            new vscode.LanguageModelToolCallPart("call_1", "get_weather", {
              city: "Tokyo",
            }),
          ],
        },
        {
          role: 1,
          content: [
            new vscode.LanguageModelToolResultPart("call_1", [
              new vscode.LanguageModelTextPart("Sunny, 25C"),
            ]),
          ],
        },
      ),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      token,
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

  describe("context overflow compaction retry", () => {
    // The test model is not in the curated whitelist, so its runtime context
    // window resolves to maxInputTokens + maxOutputTokens = 165536. The
    // server-reported maximum must stay below that for the retry to use it.
    const overflowError = () =>
      new NvidiaApiError("context_overflow", "HTTP 400 Bad Request: context overflow", {
        status: 400,
        contextOverflow: { reportedMaximum: 150000, actualUsage: 160000 },
      });

    const overflowMessages = () =>
      makeMessages(
        { role: 1, content: [{ value: "Hi" }] },
        { role: 2, content: [{ value: "Hello, how can I help?" }] },
        { role: 1, content: [{ value: "What is the weather in Tokyo?" }] },
      );

    const weatherTool = {
      name: "get_weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    };

    it("emits tool calls from the compacted retry instead of dropping them", async () => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");
      (chatCompletion as jest.Mock).mockResolvedValue("Compacted summary.");

      const overflowingStream = async function* () {
        throw overflowError();
      };
      const retryStream = async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_retry",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                  },
                ],
              },
            },
          ],
        };
      };
      (streamChatCompletion as jest.Mock)
        .mockImplementationOnce(() => overflowingStream())
        .mockImplementationOnce(() => retryStream());

      const progress = { report: jest.fn() };
      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        overflowMessages(),
        makeChatOptions({
          modelOptions: {},
          tools: [weatherTool],
        }),
        progress,
        makeToken(),
      );

      expect(streamChatCompletion).toHaveBeenCalledTimes(2);
      const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
      expect(retryRequest.messages[0]).toEqual(
        expect.objectContaining({
          role: "system",
          content: "[Previous conversation summary]: Compacted summary.",
        }),
      );
      expect(retryRequest.max_tokens).toBe(Math.max(1024, Math.floor(150000 * 0.05)));

      const toolCallReports = progress.report.mock.calls.filter((c) => c[0]?.callId);
      expect(toolCallReports).toHaveLength(1);
      expect(toolCallReports[0][0].name).toBe("get_weather");
      expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
    });

    it("reports reasoning_content from the compacted retry as thinking parts", async () => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");
      (chatCompletion as jest.Mock).mockResolvedValue("Compacted summary.");

      const overflowingStream = async function* () {
        throw overflowError();
      };
      const retryStream = async function* () {
        yield { choices: [{ delta: { reasoning_content: "Let me think." } }] };
        yield { choices: [{ delta: { content: "Final answer" } }] };
      };
      (streamChatCompletion as jest.Mock)
        .mockImplementationOnce(() => overflowingStream())
        .mockImplementationOnce(() => retryStream());

      const progress = { report: jest.fn() };
      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        overflowMessages(),
        makeChatOptions(),
        progress,
        makeToken(),
      );

      expect(streamChatCompletion).toHaveBeenCalledTimes(2);
      const ThinkingPart = getLanguageModelThinkingPart(vscode);
      const thinkingReports = progress.report.mock.calls.filter(
        (c) => c[0] instanceof ThinkingPart,
      );
      expect(thinkingReports).toHaveLength(1);
      expect(thinkingReports[0][0]).toEqual(expect.objectContaining({ value: "Let me think." }));
      expect(progress.report).toHaveBeenCalledWith(
        expect.objectContaining({ value: "Final answer" }),
      );
    });

    it("truncates large tool results when converting messages for the compacted retry", async () => {
      (secrets.get as jest.Mock).mockResolvedValue("test-key");
      (chatCompletion as jest.Mock).mockResolvedValue("Compacted summary.");

      const overflowingStream = async function* () {
        throw overflowError();
      };
      const retryStream = async function* () {
        yield { choices: [{ delta: { content: "Done" } }] };
      };
      (streamChatCompletion as jest.Mock)
        .mockImplementationOnce(() => overflowingStream())
        .mockImplementationOnce(() => retryStream());

      const hugeToolResult = "x".repeat(80000);
      const messages = makeMessages(
        { role: 1, content: [{ value: "Hi" }] },
        { role: 2, content: [{ value: "Hello!" }] },
        {
          role: 2,
          content: [
            new vscode.LanguageModelToolCallPart("call_1", "get_weather", {
              city: "Tokyo",
            }),
          ],
        },
        {
          role: 1,
          content: [
            new vscode.LanguageModelToolResultPart("call_1", [
              new vscode.LanguageModelTextPart(hugeToolResult),
            ]),
          ],
        },
        { role: 1, content: [{ value: "Summarize the tool output" }] },
      );

      await provider.provideLanguageModelChatResponse(
        makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
        messages,
        makeChatOptions({
          modelOptions: {},
          tools: [weatherTool],
        }),
        { report: jest.fn() },
        makeToken(),
      );

      expect(streamChatCompletion).toHaveBeenCalledTimes(2);
      const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
      const retryJson = JSON.stringify(retryRequest.messages);
      expect(retryJson.length).toBeLessThan(hugeToolResult.length);
    });
  });
});
