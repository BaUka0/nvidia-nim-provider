import * as vscode from "vscode";
import { streamChatCompletion } from "../../src/api/client";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import {
  makeChatOptions,
  makeMemento,
  makeModel,
  makeSecrets,
  makeToken,
  makeMessages,
  makeUserMessages,
} from "../helpers/fakes";

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
              id: "deepseek-ai/deepseek-v4-flash-0731",
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

  it("streams tool call parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    (globalState.get as jest.Mock).mockReturnValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 16384,
      }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({
        model: "deepseek-ai/deepseek-v4-flash-0731",
        tools: expect.any(Array),
        tool_choice: "auto",
      }),
      expect.any(AbortSignal),
      "test-ua",
      expect.objectContaining({ maxOutputTokens: 16384 }),
    );
    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      token,
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      token,
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
    (globalState.get as jest.Mock).mockImplementation((key: string) =>
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
        : undefined,
    );

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "moonshotai/kimi-k3", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
        toolMode: 2,
      }),
      progress,
      token,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody.tool_choice).toBe("required");
  });

  it("emits tool calls from the final message.tool_calls field", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "Need weather." } }] };
      yield {
        choices: [
          {
            delta: {},
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { name: "get_weather", arguments: { city: "Tokyo" } },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      makeToken(),
    );

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("get_weather");
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("retries once after finish_reason tool_calls with no payload even if thinking already streamed", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const emptyToolFinish = async function* () {
      yield { choices: [{ delta: { reasoning_content: "I will call a tool." } }] };
      yield { choices: [{ delta: { content: "\n" } }] };
      yield { choices: [{ delta: { tool_calls: [] }, finish_reason: "tool_calls" }] };
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
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => emptyToolFinish())
      .mockImplementationOnce(() => repairedStream());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("get_weather");
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("retries a missing tool payload without dumping the repair text into chat", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const emptyToolFinish = async function* () {
      yield { choices: [{ delta: { reasoning_content: "I will call a tool." } }] };
      yield { choices: [{ delta: { tool_calls: [] }, finish_reason: "tool_calls" }] };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => emptyToolFinish())
      .mockImplementationOnce(() => emptyToolFinish());

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("no tool function arguments"),
      }),
    );
    const textReports = progress.report.mock.calls
      .map((c: unknown[]) => c[0] as { value?: string })
      .filter(
        (part) =>
          typeof part.value === "string" && part.value.includes("did not include tool arguments"),
      );
    expect(textReports).toEqual([]);
  });

  it("retries a duplicate read_file with the model instead of showing it in chat", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const duplicateRead = async function* () {
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
            finish_reason: "tool_calls",
          },
        ],
      };
    };
    const repairedRead = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:2",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/types.ts","startLine":1,"endLine":40}',
                  },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock)
      .mockImplementationOnce(() => duplicateRead())
      .mockImplementationOnce(() => repairedRead());

    const progress = { report: jest.fn() };
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
              new vscode.LanguageModelTextPart("already read"),
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
      makeToken(),
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages.at(-1).content).toContain("already completed");
    const visibleRepair = progress.report.mock.calls.filter((c: unknown[]) =>
      String((c[0] as { value?: string }).value ?? "").includes("was not repeated"),
    );
    expect(visibleRepair).toEqual([]);
    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/types.ts",
      startLine: 1,
      endLine: 40,
    });
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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Hi"),
      makeChatOptions({
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
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
    const token = makeToken();

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
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
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
    const token = makeToken();

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
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    expect((streamChatCompletion as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((streamChatCompletion as jest.Mock).mock.calls[1][1].messages.at(-1).content).toContain(
      "read_file",
    );
    const textReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { value?: string })?.value,
    );
    expect(textReports.every((c) => !String(c[0].value).includes("was rejected"))).toBe(true);
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
    const token = makeToken();

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

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    expect(retryRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("read_file"),
        }),
      ]),
    );
    expect(retryRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("filePath, startLine, endLine"),
        }),
      ]),
    );

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { value?: string })?.value,
    );

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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Read the file"),
      makeChatOptions({
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
      }),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const retryRequest = (streamChatCompletion as jest.Mock).mock.calls[1][1];
    const retryMessage = retryRequest.messages[retryRequest.messages.length - 1];
    expect(retryMessage).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("read_file"),
      }),
    );
    expect(retryMessage.content).toContain("filePath, startLine, endLine");
    expect(retryMessage.content).not.toContain("list_dir with invalid arguments");

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { value?: string })?.value,
    );

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
    const token = makeToken();

    await provider.provideLanguageModelChatResponse(
      makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 }),
      makeUserMessages("Read the file"),
      makeChatOptions({
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
      }),
      progress,
      token,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const toolCallReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { callId?: string })?.callId,
    );
    const textReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { value?: string })?.value,
    );

    expect(toolCallReports).toHaveLength(0);
    expect(textReports.every((c) => !String(c[0].value).includes("was rejected"))).toBe(true);
    expect((streamChatCompletion as jest.Mock).mock.calls[1][1].messages.at(-1).content).toContain(
      "read_file",
    );
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
    const token = makeToken();

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
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      }),
      progress,
      token,
    );

    const textReports = progress.report.mock.calls.filter(
      (c: unknown[]) => (c[0] as { value?: string })?.value,
    );
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toBe(" ");
    expect((streamChatCompletion as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
