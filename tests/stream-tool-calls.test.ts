import * as vscode from "vscode";
import { streamChatCompletion } from "../src/api/client";
import { runStreamAttempt } from "../src/provider/stream-pump";
import { DEFAULT_TOOLS_CONFIG } from "../src/shared/config";
import { collectChoiceToolCalls, normalizeStreamToolCalls } from "../src/tools/stream-tool-calls";
import { getToolSchemaMap, parseTextEmbeddedToolCalls } from "../src/tools/parser";
import { makeChatOptions, makeModel, makeToken, makeUserMessages } from "./helpers/fakes";

jest.mock("../src/api/client", () => ({
  streamChatCompletion: jest.fn(),
}));

describe("normalizeStreamToolCalls", () => {
  it("returns an empty list for empty arrays and blanks", () => {
    expect(normalizeStreamToolCalls([])).toEqual([]);
    expect(normalizeStreamToolCalls("")).toEqual([]);
    expect(normalizeStreamToolCalls(undefined)).toEqual([]);
  });

  it("stringifies object arguments and keeps a missing id", () => {
    expect(
      normalizeStreamToolCalls({
        index: 0,
        type: "function",
        function: { name: "read_file", arguments: { filePath: "/tmp/a.ts" } },
      }),
    ).toEqual([
      {
        id: "",
        index: 0,
        type: "function",
        function: { name: "read_file", arguments: '{"filePath":"/tmp/a.ts"}' },
      },
    ]);
  });

  it("parses a JSON string payload and an index-keyed object", () => {
    expect(
      normalizeStreamToolCalls(
        JSON.stringify({
          "0": {
            id: "call_1",
            function: { name: "read_file", arguments: '{"filePath":"a.ts"}' },
          },
        }),
      ),
    ).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"filePath":"a.ts"}' },
      },
    ]);
  });
});

describe("collectChoiceToolCalls", () => {
  it("prefers delta tool calls and falls back to message.tool_calls", () => {
    expect(
      collectChoiceToolCalls({
        delta: { tool_calls: [] },
        message: {
          tool_calls: [
            {
              id: "from-message",
              type: "function",
              function: { name: "read_file", arguments: '{"filePath":"a.ts"}' },
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "from-message",
        type: "function",
        function: { name: "read_file", arguments: '{"filePath":"a.ts"}' },
      },
    ]);
  });
});

describe("streamed JSON tool fallback", () => {
  const options = makeChatOptions({
    tools: [
      {
        name: "insert_edit_into_file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            code: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["filePath", "code"],
        },
      },
      {
        name: "read_file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
      },
    ],
  });
  const toolSchemas = getToolSchemaMap(options);

  it("handles streamed chunks for Nemotron raw JSON tool calls without text leakage", () => {
    const chunks = [
      '{\n  "file',
      'Path": "/home/rdp/code/stats.py",\n',
      '  "code": "from stats import count",\n',
      '  "explanation": "Add count import"\n}',
    ];

    let pending = "";
    const emittedSegments: Array<{ type: string; toolCall?: unknown; text?: string }> = [];

    for (const chunk of chunks) {
      const res = parseTextEmbeddedToolCalls(pending + chunk, toolSchemas);
      pending = res.incompleteText;
      emittedSegments.push(...res.segments);
    }

    expect(pending).toBe("");
    expect(emittedSegments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "insert_edit_into_file",
          args: {
            filePath: "/home/rdp/code/stats.py",
            code: "from stats import count",
            explanation: "Add count import",
          },
        },
      },
    ]);
  });

  it("handles fenced streamed JSON tool calls with preceding explanation", () => {
    const chunks = [
      "I will update the file:\n```json\n",
      '{\n  "filePath": "/home/rdp/code/stats.py",\n',
      '  "code": "print(1)"\n}\n```\nDone.',
    ];

    let pending = "";
    const emittedSegments: Array<{ type: string; toolCall?: unknown; text?: string }> = [];

    for (const chunk of chunks) {
      const res = parseTextEmbeddedToolCalls(pending + chunk, toolSchemas);
      pending = res.incompleteText;
      emittedSegments.push(...res.segments);
    }

    expect(pending).toBe("");
    expect(emittedSegments).toEqual([
      { type: "text", text: "I will update the file:\n" },
      {
        type: "toolCall",
        toolCall: {
          name: "insert_edit_into_file",
          args: {
            filePath: "/home/rdp/code/stats.py",
            code: "print(1)",
          },
        },
      },
      { type: "text", text: "Done." },
    ]);
  });

  it("preserves single-key or extra-key prose Markdown fenced JSON blocks as text instead of executing tools", () => {
    const singleKeyProse = 'Example config:\n```json\n{"filePath": "foo.ts"}\n```\nEnd.';
    const singleRes = parseTextEmbeddedToolCalls(singleKeyProse, toolSchemas, {
      atStreamEnd: true,
    });
    expect(singleRes.segments).toEqual([{ type: "text", text: singleKeyProse }]);

    const extraKeyProse =
      'Example payload:\n```json\n{"filePath": "foo.ts", "code": "x", "extraUnrecognized": 123}\n```\nEnd.';
    const extraRes = parseTextEmbeddedToolCalls(extraKeyProse, toolSchemas, {
      atStreamEnd: true,
    });
    expect(extraRes.segments).toEqual([{ type: "text", text: extraKeyProse }]);
  });

  it("still executes explicit named fenced JSON tool calls with a single argument", () => {
    const namedFenced =
      'Reading file:\n```json\n{"name": "read_file", "arguments": {"filePath": "foo.ts"}}\n```\nDone.';
    const res = parseTextEmbeddedToolCalls(namedFenced, toolSchemas, { atStreamEnd: true });
    expect(res.segments).toEqual([
      { type: "text", text: "Reading file:\n" },
      {
        type: "toolCall",
        toolCall: {
          name: "read_file",
          args: { filePath: "foo.ts" },
        },
      },
      { type: "text", text: "Done." },
    ]);
  });

  it("never guesses zero-required-arg tools or auxiliary-only inputs from unnamed JSON", () => {
    const schemasWithZeroReq = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "get_workspace_status",
            inputSchema: {
              type: "object",
              properties: { format: { type: "string" } },
              required: [],
            },
          },
          {
            name: "search_code",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                isRegexp: { type: "boolean" },
              },
              required: ["query", "isRegexp"],
            },
          },
        ],
      }),
    );

    const zeroReqJson = '{"format": "json"}';
    expect(parseTextEmbeddedToolCalls(zeroReqJson, schemasWithZeroReq)).toEqual({
      segments: [{ type: "text", text: zeroReqJson }],
      incompleteText: "",
      extractedParams: {},
    });

    const auxOnlyJson = '{"isRegexp": true}';
    expect(parseTextEmbeddedToolCalls(auxOnlyJson, schemasWithZeroReq)).toEqual({
      segments: [{ type: "text", text: auxOnlyJson }],
      incompleteText: "",
      extractedParams: {},
    });
  });

  it("recovers unnamed fenced read_file calls with line ranges both standalone and with prose", async () => {
    const readFileOptions = makeChatOptions({
      tools: [
        {
          name: "read_file",
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
    });
    const readFileSchemas = getToolSchemaMap(readFileOptions);

    const standaloneFenced =
      '```json\n{"filePath":"/workspace/a.ts","startLine":1,"endLine":40}\n```';
    expect(parseTextEmbeddedToolCalls(standaloneFenced, readFileSchemas)).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/workspace/a.ts", startLine: 1, endLine: 40 },
          },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const withProseFenced =
      'Reading the header:\n```json\n{"filePath":"/workspace/a.ts","startLine":1,"endLine":40}\n```\nDone.';
    expect(parseTextEmbeddedToolCalls(withProseFenced, readFileSchemas)).toEqual({
      segments: [
        { type: "text", text: "Reading the header:\n" },
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/workspace/a.ts", startLine: 1, endLine: 40 },
          },
        },
        { type: "text", text: "Done." },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    (streamChatCompletion as jest.Mock).mockReset();
    (streamChatCompletion as jest.Mock).mockReturnValueOnce(
      (async function* () {
        yield {
          choices: [
            {
              delta: {
                content: '```json\n{"filePath":"/workspace/a.ts","startLine":1,"endLine":40}\n```',
              },
              finish_reason: "stop",
            },
          ],
        };
      })(),
    );

    const progress = { report: jest.fn() };
    const attemptResult = await runStreamAttempt({
      apiKey: "test-key",
      requestBody: {
        model: "deepseek-ai/deepseek-v4-flash-0731",
        messages: [{ role: "user", content: "Read a.ts" }],
        stream: true,
      },
      signal: new AbortController().signal,
      userAgent: "test-ua",
      token: makeToken(),
      progress,
      model: makeModel({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        maxInputTokens: 100000,
        maxOutputTokens: 65536,
        capabilities: { toolCalling: 128, imageInput: false },
      }),
      options: readFileOptions,
      messages: makeUserMessages("Read a.ts"),
      reasoningIsolationExpected: false,
      maxFetchAttempts: 1,
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      hasRetriedRepetitionLoop: false,
      maxRepeatedLines: 3,
      maxLoopContinues: 0,
    });

    const emittedToolCalls = progress.report.mock.calls
      .map((call) => call[0])
      .filter((part): part is vscode.LanguageModelToolCallPart => "callId" in part);
    expect(attemptResult.emittedToolCall).toBe(true);
    expect(emittedToolCalls).toHaveLength(1);
    expect(emittedToolCalls[0]).toMatchObject({
      name: "read_file",
      input: { filePath: "/workspace/a.ts", startLine: 1, endLine: 40 },
    });
  });

  it("recovers zero-required-arg get_errors calls with filePaths while rejecting empty arrays and format metadata", () => {
    const zeroReqSchemas = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "get_errors",
            inputSchema: {
              type: "object",
              properties: { filePaths: { type: "array", items: { type: "string" } } },
              required: [],
            },
          },
          {
            name: "get_workspace_status",
            inputSchema: {
              type: "object",
              properties: { format: { type: "string" } },
              required: [],
            },
          },
        ],
      }),
    );

    const rawGetErrors = '{"filePaths":["/workspace/a.ts"]}';
    expect(parseTextEmbeddedToolCalls(rawGetErrors, zeroReqSchemas)).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: { name: "get_errors", args: { filePaths: ["/workspace/a.ts"] } },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const fencedGetErrors = '```json\n{"filePaths":["/workspace/a.ts"]}\n```';
    expect(
      parseTextEmbeddedToolCalls(fencedGetErrors, zeroReqSchemas, { atStreamEnd: true }),
    ).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: { name: "get_errors", args: { filePaths: ["/workspace/a.ts"] } },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const emptyFilePaths = '{"filePaths": []}';
    expect(
      parseTextEmbeddedToolCalls(emptyFilePaths, zeroReqSchemas, { atStreamEnd: true }),
    ).toEqual({
      segments: [{ type: "text", text: emptyFilePaths }],
      incompleteText: "",
      extractedParams: {},
    });

    const formatJson = '{"format": "json"}';
    expect(parseTextEmbeddedToolCalls(formatJson, zeroReqSchemas, { atStreamEnd: true })).toEqual({
      segments: [{ type: "text", text: formatJson }],
      incompleteText: "",
      extractedParams: {},
    });
  });

  it("recovers standalone single-key fenced JSON at stream end while holding mid-stream in case trailing prose arrives", () => {
    const singleKeySchemas = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
          {
            name: "run_in_terminal",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    );

    const fencedRead = '```json\n{"filePath": "/workspace/a.ts"}\n```';
    const midRead = parseTextEmbeddedToolCalls(fencedRead, singleKeySchemas);
    expect(midRead).toEqual({
      segments: [],
      incompleteText: fencedRead,
      extractedParams: {},
    });
    expect(
      parseTextEmbeddedToolCalls(midRead.incompleteText, singleKeySchemas, { atStreamEnd: true }),
    ).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: { name: "read_file", args: { filePath: "/workspace/a.ts" } },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const fencedCmd = '```json\n{"command": "npm test"}\n```';
    const midCmd = parseTextEmbeddedToolCalls(fencedCmd, singleKeySchemas);
    expect(midCmd).toEqual({
      segments: [],
      incompleteText: fencedCmd,
      extractedParams: {},
    });
    expect(
      parseTextEmbeddedToolCalls(midCmd.incompleteText, singleKeySchemas, { atStreamEnd: true }),
    ).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: { name: "run_in_terminal", args: { command: "npm test" } },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const withTrailingProse = parseTextEmbeddedToolCalls(
      `${midRead.incompleteText}\nThis shows the expected argument shape.`,
      singleKeySchemas,
      { atStreamEnd: true },
    );
    expect(withTrailingProse).toEqual({
      segments: [
        {
          type: "text",
          text: '```json\n{"filePath": "/workspace/a.ts"}\n```\nThis shows the expected argument shape.',
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });

    const fencedArray = '```json\n[{"filePath": "/workspace/a.ts"}]\n```';
    const midArray = parseTextEmbeddedToolCalls(fencedArray, singleKeySchemas);
    expect(midArray).toEqual({
      segments: [],
      incompleteText: fencedArray,
      extractedParams: {},
    });
    expect(
      parseTextEmbeddedToolCalls(midArray.incompleteText, singleKeySchemas, { atStreamEnd: true }),
    ).toEqual({
      segments: [
        {
          type: "toolCall",
          toolCall: { name: "read_file", args: { filePath: "/workspace/a.ts" } },
        },
      ],
      incompleteText: "",
      extractedParams: {},
    });
  });

  it("emits zero tool calls for container-fenced multi-key and zero-required-arg JSON blocks", () => {
    const containerSchemas = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
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
          {
            name: "get_errors",
            inputSchema: {
              type: "object",
              properties: { filePaths: { type: "array", items: { type: "string" } } },
              required: [],
            },
          },
        ],
      }),
    );

    const listFenced = '- ```json\n{"filePath":"/workspace/a.ts","startLine":1,"endLine":40}\n```';
    expect(
      parseTextEmbeddedToolCalls(listFenced, containerSchemas, { atStreamEnd: true }).segments,
    ).toEqual([{ type: "text", text: listFenced }]);

    const quoteFenced = '> ```json\n> {"filePaths":["/workspace/a.ts"]}\n> ```';
    expect(
      parseTextEmbeddedToolCalls(quoteFenced, containerSchemas, { atStreamEnd: true }).segments,
    ).toEqual([{ type: "text", text: quoteFenced }]);
  });
});
