import { collectChoiceToolCalls, normalizeStreamToolCalls } from "../src/tools/stream-tool-calls";

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
