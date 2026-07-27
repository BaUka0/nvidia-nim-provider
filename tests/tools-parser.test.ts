import {
  buildToolCallCanonicalKey,
  getToolSchemaMap,
  hasRequiredToolArguments,
  parseToolArguments,
  repairToolArguments,
} from "../src/tools/parser";
import { ToolCallStreamAggregator } from "../src/provider/tool-call-aggregator";

describe("tool argument parsing and validation", () => {
  const options = {
    tools: [
      {
        name: "read_file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            startLine: { type: "integer" },
            mode: { type: "string", enum: ["full", "selection"] },
            recursive: { type: "boolean" },
          },
          required: ["filePath", "startLine", "mode"],
        },
      },
    ],
  } as any;

  it("repairs malformed JSON only after strict parsing fails", () => {
    expect(parseToolArguments('{"filePath":"/tmp/a.ts","startLine":1}')).toEqual({
      filePath: "/tmp/a.ts",
      startLine: 1,
    });
    expect(parseToolArguments("{filePath: '/tmp/a.ts', startLine: '1'}")).toEqual({
      filePath: "/tmp/a.ts",
      startLine: "1",
    });
  });

  it("normalizes scalar argument types and validates enum values", () => {
    const schema = getToolSchemaMap(options).get("read_file");
    const repaired = repairToolArguments(
      "read_file",
      { filePath: "/tmp/a.ts", startLine: "1", mode: "full", recursive: "true" },
      undefined,
      schema,
    );

    const repairedRecord = repaired as Record<string, unknown>;
    expect(repairedRecord).toEqual({
      filePath: "/tmp/a.ts",
      startLine: 1,
      mode: "full",
      recursive: true,
    });
    expect(hasRequiredToolArguments(repairedRecord, schema)).toBe(true);
    expect(hasRequiredToolArguments({ ...repairedRecord, mode: "unknown" }, schema)).toBe(false);
    expect(hasRequiredToolArguments({ ...repairedRecord, startLine: "not-a-number" }, schema)).toBe(
      false,
    );
  });

  it("flattens nested arguments objects before validation", () => {
    const schema = getToolSchemaMap(options).get("read_file");
    const repaired = repairToolArguments(
      "read_file",
      { arguments: '{"filePath":"/tmp/a.ts","startLine":"2","mode":"selection"}' },
      undefined,
      schema,
    );

    expect(repaired).toEqual({ filePath: "/tmp/a.ts", startLine: 2, mode: "selection" });
    expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
  });

  it("preserves a schema-declared string field named arguments", () => {
    const schema = getToolSchemaMap({
      tools: [
        {
          name: "run_query",
          inputSchema: {
            type: "object",
            properties: { arguments: { type: "string" } },
            required: ["arguments"],
          },
        },
      ],
    } as any).get("run_query");

    const repaired = repairToolArguments(
      "run_query",
      { arguments: '{"query":"SELECT 1"}' },
      undefined,
      schema,
    );

    expect(repaired).toEqual({ arguments: '{"query":"SELECT 1"}' });
    expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
  });

  it("validates required fields inside nested object properties", () => {
    const nestedSchema = getToolSchemaMap({
      tools: [
        {
          name: "search",
          inputSchema: {
            type: "object",
            properties: {
              filter: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        },
      ],
    } as any).get("search");

    expect(hasRequiredToolArguments({ filter: {} }, nestedSchema)).toBe(false);
    expect(hasRequiredToolArguments({ filter: { path: "/tmp" } }, nestedSchema)).toBe(true);
  });

  it("uses stable keys for duplicate calls with reordered fields", () => {
    expect(buildToolCallCanonicalKey("read_file", { b: 2, a: 1 })).toBe(
      buildToolCallCanonicalKey("read_file", { a: 1, b: 2 }),
    );
  });

  it("preserves arguments for tools with an empty schema", () => {
    expect(
      repairToolArguments("get_weather", { city: "Tokyo" }, undefined, { properties: {} }),
    ).toEqual({
      city: "Tokyo",
    });
  });

  it("repairs and validates malformed native streamed arguments at final flush", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options,
      messages: [],
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required) => skipped.push({ name, required }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments:
            "{filePath: '/tmp/a.ts', startLine: '2', mode: 'selection', recursive: 'true'}",
        },
      },
    ]);

    expect(emitted).toHaveLength(0);
    aggregator.flushRemaining();

    expect(skipped).toHaveLength(0);
    expect(emitted).toEqual([
      {
        id: "call_1",
        name: "read_file",
        args: {
          filePath: "/tmp/a.ts",
          startLine: 2,
          mode: "selection",
          recursive: true,
        },
      },
    ]);
  });

  it("assembles a native tool name split across stream deltas", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options,
      messages: [],
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required) => skipped.push({ name, required }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "call_split",
        type: "function",
        function: { name: "read_", arguments: '{"filePath":"/tmp/a.ts",' },
      },
      {
        index: 0,
        id: "",
        type: "function",
        function: { name: "file", arguments: '"startLine":1,"mode":"full"}' },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toHaveLength(0);
    expect(emitted).toEqual([
      {
        id: "call_split",
        name: "read_file",
        args: { filePath: "/tmp/a.ts", startLine: 1, mode: "full" },
      },
    ]);
  });

  it("assembles a split name when the first fragment is another tool name", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options: {
        tools: [
          {
            name: "read",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      messages: [],
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required) => skipped.push({ name, required }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "call_prefix",
        type: "function",
        function: { name: "read", arguments: '{"filePath":' },
      },
      {
        index: 0,
        id: "",
        type: "function",
        function: { name: "_file", arguments: '"/tmp/a.ts"}' },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toEqual([]);
    expect(emitted).toEqual([
      {
        id: "call_prefix",
        name: "read_file",
        args: { filePath: "/tmp/a.ts" },
      },
    ]);
  });
});
