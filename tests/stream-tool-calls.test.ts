import { collectChoiceToolCalls, normalizeStreamToolCalls } from "../src/tools/stream-tool-calls";
import { getToolSchemaMap, parseTextEmbeddedToolCalls } from "../src/tools/parser";
import { makeChatOptions } from "./helpers/fakes";

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
});
