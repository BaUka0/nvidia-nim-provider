import { ConfigManager } from "../src/shared/config";
import {
  buildInvalidToolCallRetryMessage,
  buildToolCallCanonicalKey,
  extractStandaloneXmlParameters,
  getIncompleteTextToolCallName,
  getToolSchemaMap,
  hasRequiredToolArguments,
  missingRequiredToolArguments,
  parseTextEmbeddedToolCalls,
  ParsedTextSegment,
  parseToolArguments,
  repairToolArguments,
  stripKnownControlText,
  TextParseContext,
} from "../src/tools/parser";
import { ToolCallStreamAggregator } from "../src/provider/tool-call-aggregator";
import { makeChatOptions } from "./helpers/fakes";

describe("tool argument parsing and validation", () => {
  const options = makeChatOptions({
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
  });

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

  it("auto-fills required startLine and mode defaults when model supplies only filePath", () => {
    const schema = getToolSchemaMap(options).get("read_file");
    const repaired = repairToolArguments("read_file", { filePath: "/tmp/a.ts" }, undefined, schema);

    expect(repaired).toEqual({ filePath: "/tmp/a.ts", startLine: 1, mode: "full" });
    expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
  });

  it("auto-fills Copilot read_file line range when startLine/endLine are properties but not required", () => {
    const schema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["filePath"],
            },
          },
        ],
      }),
    ).get("read_file");

    const repaired = repairToolArguments(
      "read_file",
      { filePath: "/tmp/example.md" },
      undefined,
      schema,
    );

    expect(repaired).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 2000,
    });
    expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
  });

  it("auto-fills MCP StartLine/EndLine keys declared by the schema", () => {
    const schema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                TargetFile: { type: "string" },
                StartLine: { type: "integer" },
                EndLine: { type: "integer" },
              },
              required: ["TargetFile", "StartLine", "EndLine"],
            },
          },
        ],
      }),
    ).get("read_file");

    const repaired = repairToolArguments(
      "read_file",
      { TargetFile: "/tmp/example.md" },
      undefined,
      schema,
    );

    expect(repaired).toEqual({
      TargetFile: "/tmp/example.md",
      StartLine: 1,
      EndLine: 2000,
    });
    expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
  });

  it("does not overwrite a string start cursor on a generic read tool", () => {
    const schema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_resource",
            inputSchema: {
              type: "object",
              properties: {
                uri: { type: "string" },
                start: { type: "string" },
                end: { type: "string" },
              },
              required: ["uri"],
            },
          },
        ],
      }),
    ).get("read_resource");

    const repaired = repairToolArguments(
      "read_resource",
      { uri: "file:///tmp/x", start: "cursor-a" },
      undefined,
      schema,
    );

    expect(repaired).toEqual({ uri: "file:///tmp/x", start: "cursor-a" });
  });

  it("reports only still-missing payload fields after read_file line defaults", () => {
    const schema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      }),
    ).get("read_file");
    const repaired = repairToolArguments("read_file", {}, undefined, schema);

    expect(repaired).toEqual({ startLine: 1, endLine: 2000 });
    expect(missingRequiredToolArguments(repaired, schema)).toEqual(["filePath"]);

    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      }),
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required) => skipped.push({ name, required }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "call_empty",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ]);
    aggregator.flushRemaining();

    expect(emitted).toEqual([]);
    expect(skipped).toEqual([{ name: "read_file", required: ["filePath"] }]);
    const retry = buildInvalidToolCallRetryMessage(
      skipped.map((call) => ({ ...call, reason: "invalid" as const })),
    );
    expect(retry).toContain("filePath");
    expect(retry).not.toContain("startLine");
  });

  it("preserves a schema-declared string field named arguments", () => {
    const schema = getToolSchemaMap(
      makeChatOptions({
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
      }),
    ).get("run_query");

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
    const nestedSchema = getToolSchemaMap(
      makeChatOptions({
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
      }),
    ).get("search");

    expect(hasRequiredToolArguments({ filter: {} }, nestedSchema)).toBe(false);
    expect(hasRequiredToolArguments({ filter: { path: "/tmp" } }, nestedSchema)).toBe(true);
  });

  it("normalizes and repairs stringified array and object properties", () => {
    const todoSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "manage_todo_list",
            inputSchema: {
              type: "object",
              properties: {
                todoList: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      title: { type: "string" },
                      status: { type: "string" },
                    },
                    required: ["id", "title", "status"],
                  },
                },
              },
              required: ["todoList"],
            },
          },
        ],
      }),
    ).get("manage_todo_list");

    const rawArgs = {
      todoList:
        '[{"id": 1, "title": "A", "status": "in-progress"}, {"id": 2, "title": "B", "status": "not-started"}, {"id": 4", "title": "C", "status": "not-started"}]',
    };

    const repaired = repairToolArguments("manage_todo_list", rawArgs, undefined, todoSchema);
    expect(hasRequiredToolArguments(repaired, todoSchema)).toBe(true);
    expect(repaired).toEqual({
      todoList: [
        { id: 1, title: "A", status: "in-progress" },
        { id: 2, title: "B", status: "not-started" },
        { id: 4, title: "C", status: "not-started" },
      ],
    });
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
      toolsConfig: ConfigManager.getToolsConfig(),
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

  it("does not reuse a completed slot for index-less native tool calls", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      }),
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: () => undefined,
    });

    aggregator.handleToolCalls([
      {
        id: "call_a",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"filePath":"/tmp/a.ts","startLine":1,"endLine":20}',
        },
      },
    ]);
    aggregator.handleToolCalls([
      {
        id: "call_b",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"filePath":"/tmp/b.ts","startLine":1,"endLine":20}',
        },
      },
    ]);

    expect(emitted.map((call) => call.args.filePath)).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  it("assembles a native tool name split across stream deltas", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options,
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
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
      options: makeChatOptions({
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
      }),
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
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

  it("emits a native tool call when the stream omits id and sends object arguments", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[] }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options,
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required) => skipped.push({ name, required }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ filePath: "/tmp/a.ts", startLine: 1, mode: "full" }),
        },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe("read_file");
    expect(emitted[0].args).toEqual({ filePath: "/tmp/a.ts", startLine: 1, mode: "full" });
    expect(emitted[0].id.length).toBeGreaterThan(0);
  });

  it("forwards a duplicate of an already-completed call for re-execution", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
    const aggregator = new ToolCallStreamAggregator({
      options,
      messages: [
        {
          role: 2,
          content: [
            {
              callId: "read_file:0",
              name: "read_file",
              input: { filePath: "/tmp/a.ts", startLine: 1, mode: "full" },
            },
          ],
        } as never,
        {
          role: 1,
          content: [{ callId: "read_file:0", content: [{ value: "ok" }] }],
        } as never,
      ],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "read_file:1",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"filePath":"/tmp/a.ts","startLine":1,"mode":"full"}',
        },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe("read_file");
    expect(emitted[0].args).toEqual({ filePath: "/tmp/a.ts", startLine: 1, mode: "full" });
  });

  describe("forwarding invalid native tool calls", () => {
    const forwardOptions = makeChatOptions({
      tools: [
        {
          name: "web_search",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              depth: { type: "string" },
            },
            required: ["query", "depth"],
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

    const makeAggregator = () => {
      const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
      const aggregator = new ToolCallStreamAggregator({
        options: forwardOptions,
        messages: [],
        toolsConfig: ConfigManager.getToolsConfig(),
        onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
        onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
      });
      return { aggregator, emitted, skipped };
    };

    it("forwards a known-tool call with partial required arguments", () => {
      const { aggregator, emitted, skipped } = makeAggregator();

      aggregator.handleToolCalls([
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"vscode api"}' },
        },
      ]);
      aggregator.flushRemaining();

      expect(skipped).toEqual([]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].name).toBe("web_search");
      expect(emitted[0].args).toEqual({ query: "vscode api" });
    });

    it("still skips an empty payload for a known tool", () => {
      const { aggregator, emitted, skipped } = makeAggregator();

      aggregator.handleToolCalls([
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: "{}" },
        },
      ]);
      aggregator.flushRemaining();

      expect(emitted).toEqual([]);
      expect(skipped).toEqual([{ name: "web_search", required: ["query", "depth"] }]);
    });

    it("still skips a hallucinated tool name that was never offered", () => {
      const { aggregator, emitted, skipped } = makeAggregator();

      aggregator.handleToolCalls([
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: {
            name: "str_replace_in_file",
            arguments: '{"filePath":"/tmp/a.ts","oldString":"a","newString":"b"}',
          },
        },
      ]);
      aggregator.flushRemaining();

      expect(emitted).toEqual([]);
      expect(skipped).toEqual([{ name: "str_replace_in_file", required: [] }]);
    });

    it("applies the identical-call loop guard to forwarded calls", () => {
      const { aggregator, emitted, skipped } = makeAggregator();

      for (let index = 0; index < 5; index += 1) {
        aggregator.handleToolCalls([
          {
            index,
            id: `call_${index}`,
            type: "function",
            function: { name: "web_search", arguments: '{"query":"vscode api"}' },
          },
        ]);
      }
      aggregator.flushRemaining();

      expect(emitted).toHaveLength(4);
      expect(skipped).toHaveLength(1);
      expect(aggregator.getToolCallLoop()).toBeDefined();
    });
  });

  it("re-emits run_in_terminal even when the same command already completed", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
    const terminalArgs = {
      command: "npm run compile",
      explanation: "Compile again",
      goal: "Compile again",
      mode: "sync",
    };
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "run_in_terminal",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                explanation: { type: "string" },
                goal: { type: "string" },
                mode: { type: "string", enum: ["sync", "terminal"] },
              },
              required: ["command", "explanation", "goal", "mode"],
            },
          },
        ],
      }),
      messages: [
        {
          role: 2,
          content: [
            {
              callId: "term:0",
              name: "run_in_terminal",
              input: terminalArgs,
            },
          ],
        } as never,
        {
          role: 1,
          content: [{ callId: "term:0", content: [{ value: "error TS" }] }],
        } as never,
      ],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "term:1",
        type: "function",
        function: {
          name: "run_in_terminal",
          arguments: JSON.stringify(terminalArgs),
        },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toEqual([]);
    expect(emitted).toEqual([{ id: "term:1", name: "run_in_terminal", args: terminalArgs }]);
  });

  it("drops the fifth identical native tool call in one stream", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
    const terminalArgs = {
      command: "npm run compile",
      explanation: "Compile again",
      goal: "Compile again",
      mode: "sync",
    };
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "run_in_terminal",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                explanation: { type: "string" },
                goal: { type: "string" },
                mode: { type: "string", enum: ["sync", "terminal"] },
              },
              required: ["command", "explanation", "goal", "mode"],
            },
          },
        ],
      }),
      messages: [],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
    });

    for (let index = 0; index < 5; index += 1) {
      aggregator.handleToolCalls([
        {
          index,
          id: `term:${index}`,
          type: "function",
          function: {
            name: "run_in_terminal",
            arguments: JSON.stringify(terminalArgs),
          },
        },
      ]);
    }

    expect(emitted).toHaveLength(4);
    expect(skipped).toEqual([]);
    expect(aggregator.getToolCallLoop()).toEqual({
      key: expect.stringContaining('run_in_terminal:{"command":"npm run compile"'),
      name: "run_in_terminal",
      count: 5,
    });
  });

  it("does not cap identical tool calls when maxConsecutiveIdenticalCalls is 0", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const terminalArgs = {
      command: "npm run compile",
      explanation: "Compile again",
      goal: "Compile again",
      mode: "sync",
    };
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "run_in_terminal",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                explanation: { type: "string" },
                goal: { type: "string" },
                mode: { type: "string", enum: ["sync", "terminal"] },
              },
              required: ["command", "explanation", "goal", "mode"],
            },
          },
        ],
      }),
      messages: [],
      toolsConfig: { ...ConfigManager.getToolsConfig(), maxConsecutiveIdenticalCalls: 0 },
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: () => undefined,
    });

    for (let index = 0; index < 5; index += 1) {
      aggregator.handleToolCalls([
        {
          index,
          id: `term:${index}`,
          type: "function",
          function: {
            name: "run_in_terminal",
            arguments: JSON.stringify(terminalArgs),
          },
        },
      ]);
    }

    expect(emitted).toHaveLength(5);
    expect(aggregator.getToolCallLoop()).toBeUndefined();
  });

  describe("identical-call limit across agent steps", () => {
    const readOptions = makeChatOptions({
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
          name: "grep_search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });
    const readA = { filePath: "/tmp/a.ts", startLine: 1, endLine: 40 };
    const readB = { filePath: "/tmp/b.ts", startLine: 1, endLine: 40 };
    const userText = (value: string) => ({ role: 1, content: [{ value }] });
    let callSeq = 0;
    const round = (name: string, input: Record<string, unknown>) => {
      const callId = `hist_${callSeq++}`;
      return [
        { role: 2, content: [{ callId, name, input }] },
        { role: 1, content: [{ callId, content: [{ value: "result" }] }] },
      ];
    };
    const rounds = (...calls: Array<[string, Record<string, unknown>]>) =>
      calls.flatMap(([name, input]) => round(name, input));

    const streamCall = (messages: unknown[], name: string, input: Record<string, unknown>) => {
      const emitted: Array<{ name: string; args: Record<string, unknown> }> = [];
      const aggregator = new ToolCallStreamAggregator({
        options: readOptions,
        messages: messages as never,
        toolsConfig: ConfigManager.getToolsConfig(),
        onEmitToolCall: (_id, emittedName, args) => emitted.push({ name: emittedName, args }),
        onSkipToolCall: () => undefined,
      });
      aggregator.handleToolCalls([
        {
          index: 0,
          id: "call_new",
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        },
      ]);
      aggregator.flushRemaining();
      return { emitted, loop: aggregator.getToolCallLoop() };
    };

    it("drops the fifth identical call when four already ran earlier in the task", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
        ),
      ];

      const { emitted, loop } = streamCall(history, "read_file", readA);

      expect(emitted).toEqual([]);
      expect(loop).toEqual({
        key: expect.stringContaining('"filePath":"/tmp/a.ts"'),
        name: "read_file",
        count: 5,
      });
    });

    it("allows the fourth identical call", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(["read_file", readA], ["read_file", readA], ["read_file", readA]),
      ];

      const { emitted, loop } = streamCall(history, "read_file", readA);

      expect(emitted).toHaveLength(1);
      expect(loop).toBeUndefined();
    });

    it("keeps counting while the model cycles between files with the same tool", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(
          ["read_file", readA],
          ["read_file", readB],
          ["read_file", readA],
          ["read_file", readB],
          ["read_file", readA],
          ["read_file", readB],
          ["read_file", readA],
          ["read_file", readB],
        ),
      ];

      const { emitted, loop } = streamCall(history, "read_file", readA);

      expect(emitted).toEqual([]);
      expect(loop?.count).toBe(5);
    });

    it("resets the count when a different tool runs", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
          ["grep_search", { query: "TODO" }],
        ),
      ];

      const { emitted, loop } = streamCall(history, "read_file", readA);

      expect(emitted).toHaveLength(1);
      expect(loop).toBeUndefined();
    });

    it("resets the count when the user sends a new message", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
        ),
        userText("Read it once more"),
      ];

      const { emitted, loop } = streamCall(history, "read_file", readA);

      expect(emitted).toHaveLength(1);
      expect(loop).toBeUndefined();
    });

    it("does not treat cache-control data parts as a new user message", () => {
      const history = [
        userText("Fix the bug"),
        ...rounds(
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
          ["read_file", readA],
        ),
        { role: 1, content: [{ mimeType: "cache_control", data: new Uint8Array([1]) }] },
      ];

      const { emitted } = streamCall(history, "read_file", readA);

      expect(emitted).toEqual([]);
    });
  });

  it("defaults missing grep isRegexp to false so the call is not rejected", () => {
    const grepSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "grep_search",
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
    ).get("grep_search");

    const repaired = repairToolArguments(
      "grep_search",
      { query: "static fields" },
      undefined,
      grepSchema,
    );

    expect(repaired).toEqual({ query: "static fields", isRegexp: false });
    expect(hasRequiredToolArguments(repaired, grepSchema)).toBe(true);
  });

  it("re-emits grep_search even when the same query already completed", () => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
    const grepArgs = { query: "static fields", isRegexp: false };
    const aggregator = new ToolCallStreamAggregator({
      options: makeChatOptions({
        tools: [
          {
            name: "grep_search",
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
      messages: [
        {
          role: 2,
          content: [{ callId: "grep:0", name: "grep_search", input: grepArgs }],
        } as never,
        {
          role: 1,
          content: [{ callId: "grep:0", content: [{ value: "matches" }] }],
        } as never,
      ],
      toolsConfig: ConfigManager.getToolsConfig(),
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: "grep:1",
        type: "function",
        function: { name: "grep_search", arguments: JSON.stringify(grepArgs) },
      },
    ]);
    aggregator.flushRemaining();

    expect(skipped).toEqual([]);
    expect(emitted).toEqual([{ id: "grep:1", name: "grep_search", args: grepArgs }]);
  });

  it("explains missing payloads and truncated arguments in retry text", () => {
    expect(
      buildInvalidToolCallRetryMessage([
        { name: "tool_call", required: [], reason: "missing_payload" },
      ]),
    ).toContain("complete JSON arguments");
    const truncated = buildInvalidToolCallRetryMessage([
      { name: "read_file", required: ["filePath"] },
      { name: "replace_string_in_file", required: [], reason: "truncated" },
    ]);
    expect(truncated).toContain('"replace_string_in_file" was cut off');
    expect(truncated).toContain("smaller tool calls");
  });

  it("parses Hermes/Nemotron XML tool calls and strips XML tags from text", () => {
    const rawStreamText =
      'Now I will create the file.\n<tool_call>\n<function=create_file>\n<parameter=filePath>\n/workspace/src/app.ts\n</parameter>\n<parameter=content>\nconsole.log("hello");\n</parameter>\n</function>\n</tool_call>\nDone creating file.';

    const { segments } = parseTextEmbeddedToolCalls(rawStreamText);

    expect(segments).toEqual([
      { type: "text", text: "Now I will create the file.\n" },
      {
        type: "toolCall",
        toolCall: {
          name: "create_file",
          args: {
            filePath: "/workspace/src/app.ts",
            content: 'console.log("hello");',
          },
        },
      },
      { type: "text", text: "\nDone creating file." },
    ]);
  });

  it("parses Standard/Anthropic XML tool calls", () => {
    const rawStreamText =
      '<tool_call name="read_file">\n<parameter name="filePath">/workspace/package.json</parameter>\n<parameter name="startLine">1</parameter>\n</tool_call>';

    const { segments } = parseTextEmbeddedToolCalls(rawStreamText);

    expect(segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "read_file",
          args: {
            filePath: "/workspace/package.json",
            startLine: 1,
          },
        },
      },
    ]);
  });

  it("parses Qwen JSON inside XML tool calls", () => {
    const rawStreamText =
      '<tool_call>\n{"name": "read_file", "arguments": {"filePath": "/tmp/test.ts"}}\n</tool_call>';

    const { segments } = parseTextEmbeddedToolCalls(rawStreamText);

    expect(segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "read_file",
          args: { filePath: "/tmp/test.ts" },
        },
      },
    ]);
  });

  it("extracts standalone XML parameters and strips them from the text stream", () => {
    const rawText =
      "I am preparing the code:\n<parameter=filePath>\n/workspace/src/index.ts\n</parameter>\nLet us proceed.";

    const { cleanText, extractedParams } = extractStandaloneXmlParameters(rawText);

    expect(extractedParams).toEqual({
      filePath: "/workspace/src/index.ts",
    });
    expect(cleanText).toBe("I am preparing the code:\n\nLet us proceed.");
  });

  it("fuses standalone XML parameters into native tool call arguments missing required fields", () => {
    const createFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "create_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
              },
              required: ["filePath", "content"],
            },
          },
        ],
      }),
    ).get("create_file");

    // Native tool call received only content
    const nativeArgs = { content: "export const x = 10;" };
    const requestContext = {
      extractedParameters: {
        filePath: "/workspace/src/constants.ts",
      },
      extractedParametersToolName: "create_file",
    };

    const repaired = repairToolArguments(
      "create_file",
      nativeArgs,
      requestContext,
      createFileSchema,
    );

    expect(repaired).toEqual({
      filePath: "/workspace/src/constants.ts",
      content: "export const x = 10;",
    });
    expect(hasRequiredToolArguments(repaired, createFileSchema)).toBe(true);
  });

  it("does not fuse unscoped XML parameters into a later native tool call", () => {
    const createFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "create_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
              },
              required: ["filePath", "content"],
            },
          },
        ],
      }),
    ).get("create_file");

    const repaired = repairToolArguments(
      "create_file",
      { content: "export const x = 10;" },
      { extractedParameters: { filePath: "/etc/passwd" } },
      createFileSchema,
    );

    expect(repaired.filePath).toBeUndefined();
  });

  it("resolves common property aliases (file_path -> filePath, code -> content)", () => {
    const createFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "create_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
              },
              required: ["filePath", "content"],
            },
          },
        ],
      }),
    ).get("create_file");

    const rawArgs = { file_path: "/workspace/main.py", code: 'print("hello")' };
    const repaired = repairToolArguments("create_file", rawArgs, undefined, createFileSchema);

    expect(repaired).toEqual({
      file_path: "/workspace/main.py",
      code: 'print("hello")',
      filePath: "/workspace/main.py",
      content: 'print("hello")',
    });
    expect(hasRequiredToolArguments(repaired, createFileSchema)).toBe(true);
  });

  it("does not alias generic path onto filePath for filesystem tools", () => {
    const createFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "create_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
              },
              required: ["filePath", "content"],
            },
          },
        ],
      }),
    ).get("create_file");

    const repaired = repairToolArguments(
      "create_file",
      { path: "/etc/passwd", code: "x" },
      { filePath: "/workspace/secret.ts" },
      createFileSchema,
    );

    expect(repaired.filePath).toBeUndefined();
    expect(repaired.path).toBe("/etc/passwd");
    expect(hasRequiredToolArguments(repaired, createFileSchema)).toBe(false);
  });

  it("rejects invalid/multi-line code text in getIncompleteTextToolCallName", () => {
    const codeSnippet =
      '<|tool_call_begin|>";\nconst deepSeekCallsBeginToken = "";\nconst x = 1;\n';

    // Must return undefined because it is TypeScript source code, not a valid tool name
    expect(getIncompleteTextToolCallName(codeSnippet)).toBeUndefined();

    // Valid tool name should still be extracted
    expect(
      getIncompleteTextToolCallName("<|tool_call_begin|>read_file<|tool_call_argument_begin|>"),
    ).toBe("read_file");
    expect(getIncompleteTextToolCallName("<tool_call>\n<function=create_file>")).toBe(
      "create_file",
    );
  });

  it("strips Llama 3/4, GLM, ChatML, and orphaned XML tool tags", () => {
    const rawText =
      "<|python_tag|><|start_header_id|>assistant<|end_header_id|>Hello [gMASK]<sop> world!<|eot_id|></parameter></function></tool_call>";

    expect(stripKnownControlText(rawText)).toBe("Hello  world!");
  });

  it("preserves source code containing XML token string literals without corrupting text", () => {
    const codeSnippet =
      'Here is the source code:\n```typescript\nconst toolCallsStartToken = "<tool_calls>";\nconst toolCallsEndPattern = /^\\s*<\\/tool_calls>/;\n```\nAll done.';

    const { segments, incompleteText } = parseTextEmbeddedToolCalls(codeSnippet);

    expect(incompleteText).toBe("");
    expect(segments).toEqual([
      {
        type: "text",
        text: 'Here is the source code:\n```typescript\nconst toolCallsStartToken = "<tool_calls>";\nconst toolCallsEndPattern = /^\\s*<\\/tool_calls>/;\n```\nAll done.',
      },
    ]);
  });

  it("does not leak '; after quoted tool tokens in unfenced TypeScript source", () => {
    const source = [
      'const toolCallsStartToken = "<tool_calls>";',
      "const toolCallsEndPattern = /^\\s*<\\/tool_calls>/;",
      'const toolCallEndToken = "</tool_call>";',
      'const beginToken = "<|tool_call_begin|>";',
      'const unicodeDsmlToken = "<｜DSML｜";',
      'const asciiDsmlToken = "<|DSML|>";',
      'const xmlStartTokens = ["<tool_call>", "<tool_call "] as const;',
    ].join("\n");

    const { segments, incompleteText } = parseTextEmbeddedToolCalls(source);

    expect(incompleteText).toBe("");
    expect(segments).toEqual([{ type: "text", text: source }]);
  });

  it('does not treat <tool_calls>"; as a container and leak the trailing quote', () => {
    const chunk = '<tool_calls>";\nconst toolCallsEndPattern = /^\\s*<\\/tool_calls>/;';
    const result = parseTextEmbeddedToolCalls(chunk);
    expect(result.incompleteText).toBe("");
    expect(result.segments).toEqual([{ type: "text", text: chunk }]);
  });

  it("still strips a real <tool_calls> wrapper around a Hermes call", () => {
    const text =
      "<tool_calls>\n<tool_call>\n<function=read_file>\n<parameter=filePath>/tmp/a.ts</parameter>\n</function>\n</tool_call>\n</tool_calls>";
    const result = parseTextEmbeddedToolCalls(text);
    expect(result.incompleteText).toBe("");
    expect(result.segments.filter((segment) => segment.type === "toolCall")).toEqual([
      {
        type: "toolCall",
        toolCall: { name: "read_file", args: { filePath: "/tmp/a.ts" } },
      },
    ]);
  });

  it("buffers in-flight Hermes XML tool calls across chunks even when content contains quotes and tag strings", () => {
    const chunk1 =
      'Now let me create the file.\n<tool_call>\n<function=create_file>\n<parameter=filePath>\n/src/parser.ts\n</parameter>\n<parameter=content>\nconst token = "<tool_calls>";\n';

    const res1 = parseTextEmbeddedToolCalls(chunk1);
    expect(res1.segments).toEqual([{ type: "text", text: "Now let me create the file.\n" }]);
    expect(res1.incompleteText).toBe(
      '<tool_call>\n<function=create_file>\n<parameter=filePath>\n/src/parser.ts\n</parameter>\n<parameter=content>\nconst token = "<tool_calls>";\n',
    );

    const chunk2 = "const x = 1;\n</parameter>\n</function>\n</tool_call>\nDone.";
    const res2 = parseTextEmbeddedToolCalls(res1.incompleteText + chunk2);

    expect(res2.incompleteText).toBe("");
    expect(res2.segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "create_file",
          args: {
            filePath: "/src/parser.ts",
            content: 'const token = "<tool_calls>";\nconst x = 1;',
          },
        },
      },
      { type: "text", text: "\nDone." },
    ]);
  });

  it("keeps literal </tool_call> and </function> inside Hermes parameter values", () => {
    const fullCode =
      'export function parseXmlStyleToolCall(text: string): ParsedXmlStyleToolCallResult {\n  const toolCallsStartToken = "<tool_calls>";\n  const toolCallEndToken = "</tool_call>";\n  const funcEnd = "</function>";\n  return { consumed: 0 };\n}';
    const text = `<tool_call>\n<function=edit_file>\n<parameter=filePath>src/parser.ts</parameter>\n<parameter=newString>${fullCode}</parameter>\n</function>\n</tool_call>`;

    const result = parseTextEmbeddedToolCalls(text);

    expect(result.incompleteText).toBe("");
    expect(result.segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "edit_file",
          args: {
            filePath: "src/parser.ts",
            newString: fullCode,
          },
        },
      },
    ]);
  });

  it("keeps literal </function> inside a standalone function parameter", () => {
    const content = 'const close = "</function>";';
    const text = `<function=edit_file><parameter=filePath>src/index.ts</parameter><parameter=content>${content}</parameter></function>`;

    const result = parseTextEmbeddedToolCalls(text);

    expect(result.incompleteText).toBe("");
    expect(result.segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "edit_file",
          args: {
            filePath: "src/index.ts",
            content,
          },
        },
      },
    ]);
  });

  it("keeps literal </tool_call> inside a Standard tool_parameter value", () => {
    const fullCode = 'const end = "</tool_call>";';
    const text = `<tool_call name="edit_file">\n<tool_parameter name="newString">${fullCode}</tool_parameter>\n</tool_call>`;

    const result = parseTextEmbeddedToolCalls(text);

    expect(result.incompleteText).toBe("");
    expect(result.segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "edit_file",
          args: {
            newString: fullCode,
          },
        },
      },
    ]);
  });

  it("buffers a split newString that contains a quoted </tool_call> across chunks", () => {
    const chunk1 =
      '<tool_call>\n<function=edit_file>\n<parameter=filePath>src/parser.ts</parameter>\n<parameter=newString>\nconst toolCallEndToken = "</tool_';
    const result1 = parseTextEmbeddedToolCalls(chunk1);

    expect(result1.segments).toEqual([]);
    expect(result1.incompleteText).toContain("<parameter=newString>");

    const chunk2 = `${result1.incompleteText}call>";\n</parameter>\n</function>\n</tool_call>\nDone.`;
    const result2 = parseTextEmbeddedToolCalls(chunk2);

    expect(result2.incompleteText).toBe("");
    expect(result2.segments).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "edit_file",
          args: {
            filePath: "src/parser.ts",
            newString: 'const toolCallEndToken = "</tool_call>";',
          },
        },
      },
      { type: "text", text: "\nDone." },
    ]);
  });

  it("copies explanation into a missing terminal goal and does not invent file payloads", () => {
    const terminalSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "run_in_terminal",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                explanation: { type: "string" },
                goal: { type: "string" },
                mode: { type: "string", enum: ["sync", "terminal"] },
              },
              required: ["command", "explanation", "goal", "mode"],
            },
          },
        ],
      }),
    ).get("run_in_terminal");

    const repaired = repairToolArguments(
      "run_in_terminal",
      {
        mode: "sync",
        explanation: "Check if node_modules was created",
        command: "cd /tmp && ls node_modules",
      },
      undefined,
      terminalSchema,
    );

    expect(repaired).toEqual({
      mode: "sync",
      explanation: "Check if node_modules was created",
      goal: "Check if node_modules was created",
      command: "cd /tmp && ls node_modules",
    });
    expect(hasRequiredToolArguments(repaired, terminalSchema)).toBe(true);
  });

  it("does not invent missing file content so the call stays invalid", () => {
    const createFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "create_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
              },
              required: ["filePath", "content"],
            },
          },
        ],
      }),
    ).get("create_file");

    const repaired = repairToolArguments(
      "create_file",
      { filePath: "src/a.ts" },
      undefined,
      createFileSchema,
    );

    expect(repaired).toEqual({ filePath: "src/a.ts" });
    expect(hasRequiredToolArguments(repaired, createFileSchema)).toBe(false);
  });

  it("does not invent MCP rollback or empty collections to force schema success", () => {
    const deploySchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "custom_mcp_service.deploy",
            inputSchema: {
              type: "object",
              properties: {
                environment: { type: "string", enum: ["staging", "production"] },
                rollbackOnFailure: { type: "boolean" },
                timeoutSeconds: { type: "integer" },
                tags: { type: "array" },
                metadata: { type: "object" },
              },
              required: ["environment", "rollbackOnFailure", "timeoutSeconds", "tags", "metadata"],
            },
          },
        ],
      }),
    ).get("custom_mcp_service.deploy");

    const repaired = repairToolArguments(
      "custom_mcp_service.deploy",
      { environment: "staging" },
      undefined,
      deploySchema,
    );

    expect(repaired).toEqual({ environment: "staging" });
    expect(repaired.rollbackOnFailure).toBeUndefined();
    expect(hasRequiredToolArguments(repaired, deploySchema)).toBe(false);
  });

  describe("tool calls cut off by a short stream", () => {
    const editOptions = makeChatOptions({
      tools: [
        {
          name: "replace_string_in_file",
          inputSchema: {
            type: "object",
            properties: {
              explanation: { type: "string" },
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["explanation", "filePath", "oldString", "newString"],
          },
        },
      ],
    });

    const flushWith = (args: string, argumentsMayBeTruncated: boolean) => {
      const emitted: Array<{ name: string; args: Record<string, unknown> }> = [];
      const skipped: Array<{ name: string; required: string[]; reason?: string }> = [];
      const aggregator = new ToolCallStreamAggregator({
        options: editOptions,
        messages: [],
        toolsConfig: ConfigManager.getToolsConfig(),
        onEmitToolCall: (_id, name, emittedArgs) => emitted.push({ name, args: emittedArgs }),
        onSkipToolCall: (name, required, reason) => skipped.push({ name, required, reason }),
      });
      aggregator.handleToolCalls([
        {
          index: 0,
          id: "edit_1",
          type: "function",
          function: { name: "replace_string_in_file", arguments: args },
        },
      ]);
      aggregator.flushRemaining({ argumentsMayBeTruncated });
      return { emitted, skipped };
    };

    // Cut inside newString and no explanation yet: jsonrepair plus the
    // explanation fill would otherwise yield a valid call with half the edit.
    const cutMidEdit =
      '{"filePath":"/tmp/a.ts","oldString":"function foo() {\\n  return 1;\\n}","newString":"function foo() {\\n  ret';

    it("skips unfinished arguments instead of repairing them into an edit", () => {
      const { emitted, skipped } = flushWith(cutMidEdit, true);

      expect(emitted).toEqual([]);
      expect(skipped).toEqual([
        { name: "replace_string_in_file", required: [], reason: "truncated" },
      ]);
    });

    it("still runs a call whose JSON was complete before the stream was cut", () => {
      // Without explanation the strict streaming check waits for more data, so
      // this call reaches the stream-end flush with complete JSON.
      const complete = JSON.stringify({
        filePath: "/tmp/a.ts",
        oldString: "return 1;",
        newString: "return 2;",
      });
      const { emitted, skipped } = flushWith(complete, true);

      expect(skipped).toEqual([]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].args.newString).toBe("return 2;");
    });

    it("keeps repairing malformed but finished JSON when the stream ended normally", () => {
      const { emitted, skipped } = flushWith(
        '{"filePath":"/tmp/a.ts","oldString":"a","newString":"b",}',
        false,
      );

      expect(skipped).toEqual([]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].args).toEqual(
        expect.objectContaining({ filePath: "/tmp/a.ts", oldString: "a", newString: "b" }),
      );
    });
  });

  describe("edit tool explanation fill", () => {
    const editOptions = makeChatOptions({
      tools: [
        {
          name: "replace_string_in_file",
          inputSchema: {
            type: "object",
            properties: {
              explanation: { type: "string" },
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["explanation", "filePath", "oldString", "newString"],
          },
        },
        {
          name: "multi_replace_string_in_file",
          inputSchema: {
            type: "object",
            properties: {
              explanation: { type: "string" },
              replacements: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    filePath: { type: "string" },
                    oldString: { type: "string" },
                    newString: { type: "string" },
                  },
                  required: ["filePath", "oldString", "newString"],
                },
              },
            },
            required: ["explanation", "replacements"],
          },
        },
        {
          name: "insert_edit_into_file",
          inputSchema: {
            type: "object",
            properties: {
              explanation: { type: "string" },
              filePath: { type: "string" },
              code: { type: "string" },
            },
            required: ["explanation", "code"],
          },
        },
      ],
    });

    it("fills a missing required explanation on a single-file edit", () => {
      const schema = getToolSchemaMap(editOptions).get("replace_string_in_file");
      const repaired = repairToolArguments(
        "replace_string_in_file",
        {
          filePath: "/home/blue/code/wispos/WispOS.Kernel/Shell.cs",
          oldString: "old body",
          newString: "new body",
        },
        undefined,
        schema,
      );

      expect(repaired.explanation).toBe(
        "Applied edit to /home/blue/code/wispos/WispOS.Kernel/Shell.cs",
      );
      expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
    });

    it("fills a missing explanation on a batch edit from the first replacement path", () => {
      const schema = getToolSchemaMap(editOptions).get("multi_replace_string_in_file");
      const repaired = repairToolArguments(
        "multi_replace_string_in_file",
        {
          replacements: [
            { filePath: "/tmp/one.cs", oldString: "a", newString: "b" },
            { filePath: "/tmp/two.cs", oldString: "c", newString: "d" },
          ],
        },
        undefined,
        schema,
      );

      expect(repaired.explanation).toBe("Applied edit to /tmp/one.cs");
      expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
    });

    it("falls back to a neutral explanation when no path is available", () => {
      const schema = getToolSchemaMap(editOptions).get("insert_edit_into_file");
      const repaired = repairToolArguments(
        "insert_edit_into_file",
        { code: "print(1)" },
        undefined,
        schema,
      );

      expect(repaired.explanation).toBe("Applied edit");
      expect(hasRequiredToolArguments(repaired, schema)).toBe(true);
    });

    it("does not fill the explanation when a core edit field is also missing", () => {
      const schema = getToolSchemaMap(editOptions).get("replace_string_in_file");
      const repaired = repairToolArguments(
        "replace_string_in_file",
        { oldString: "a", newString: "b" },
        undefined,
        schema,
      );

      // No filePath anywhere: explanation stays absent so the call is still
      // rejected by validation instead of being executed without a target.
      expect(hasRequiredToolArguments(repaired, schema)).toBe(false);
      expect(missingRequiredToolArguments(repaired, schema)).toEqual(["explanation", "filePath"]);
    });
  });

  describe("Issue #8: cross-file line range scoping and read_file defaulting", () => {
    const readFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      }),
    ).get("read_file");

    const editFileSchema = getToolSchemaMap(
      makeChatOptions({
        tools: [
          {
            name: "edit_file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
                content: { type: "string" },
              },
              required: ["filePath", "startLine", "endLine", "content"],
            },
          },
        ],
      }),
    ).get("edit_file");

    const requestContext = {
      filePath: "/workspace/src/AutoroutePartHandler.cs",
      startLine: 471,
      endLine: 483,
    };

    it("does not pollute read_file on a secondary file with context selection line numbers", () => {
      const repaired = repairToolArguments(
        "read_file",
        { filePath: "/workspace/test/AutoroutePartHandlerTests.cs" },
        requestContext,
        readFileSchema,
      );

      expect(repaired).toEqual({
        filePath: "/workspace/test/AutoroutePartHandlerTests.cs",
        startLine: 1,
        endLine: 2000,
      });
      expect(hasRequiredToolArguments(repaired, readFileSchema)).toBe(true);
    });

    it("defaults read_file to start from line 1 even when reading the context file without startLine", () => {
      const repaired = repairToolArguments(
        "read_file",
        { filePath: "/workspace/src/AutoroutePartHandler.cs" },
        requestContext,
        readFileSchema,
      );

      expect(repaired).toEqual({
        filePath: "/workspace/src/AutoroutePartHandler.cs",
        startLine: 1,
        endLine: 2000,
      });
      expect(hasRequiredToolArguments(repaired, readFileSchema)).toBe(true);
    });

    it("preserves explicit startLine and defaults endLine to startLine + 1999 for read_file", () => {
      const repaired = repairToolArguments(
        "read_file",
        { filePath: "/workspace/src/AutoroutePartHandler.cs", startLine: 50 },
        requestContext,
        readFileSchema,
      );

      expect(repaired).toEqual({
        filePath: "/workspace/src/AutoroutePartHandler.cs",
        startLine: 50,
        endLine: 2049,
      });
    });

    it("does not apply context selection line numbers to edit_file on a different file", () => {
      const repaired = repairToolArguments(
        "edit_file",
        { filePath: "/workspace/test/OtherFile.cs", content: "new code" },
        requestContext,
        editFileSchema,
      );

      expect(repaired.filePath).toBe("/workspace/test/OtherFile.cs");
      expect(repaired.startLine).toBeUndefined();
      expect(repaired.endLine).toBeUndefined();
      expect(hasRequiredToolArguments(repaired, editFileSchema)).toBe(false);
    });

    it("applies context selection line numbers to edit_file on the matching context file", () => {
      const repaired = repairToolArguments(
        "edit_file",
        { filePath: "/workspace/src/AutoroutePartHandler.cs", content: "new code" },
        requestContext,
        editFileSchema,
      );

      expect(repaired).toEqual({
        filePath: "/workspace/src/AutoroutePartHandler.cs",
        startLine: 471,
        endLine: 483,
        content: "new code",
      });
      expect(hasRequiredToolArguments(repaired, editFileSchema)).toBe(true);
    });

    it("handles MCP-style view_file tool with AbsolutePath, StartLine, EndLine without line pollution", () => {
      const viewFileSchema = getToolSchemaMap(
        makeChatOptions({
          tools: [
            {
              name: "view_file",
              inputSchema: {
                type: "object",
                properties: {
                  AbsolutePath: { type: "string" },
                  StartLine: { type: "integer" },
                  EndLine: { type: "integer" },
                },
                required: ["AbsolutePath", "StartLine", "EndLine"],
              },
            },
          ],
        }),
      ).get("view_file");

      // Model calls view_file on another file supplying filePath instead of AbsolutePath and omitting lines
      const repaired = repairToolArguments(
        "view_file",
        { filePath: "/workspace/test/AutoroutePartHandlerTests.cs" },
        requestContext,
        viewFileSchema,
      );

      expect(repaired).toEqual({
        AbsolutePath: "/workspace/test/AutoroutePartHandlerTests.cs",
        filePath: "/workspace/test/AutoroutePartHandlerTests.cs",
        StartLine: 1,
        EndLine: 2000,
      });
      expect(hasRequiredToolArguments(repaired, viewFileSchema)).toBe(true);
    });

    it("resolves bidirectional aliases for MCP write_to_file (TargetFile, CodeContent)", () => {
      const writeToFileSchema = getToolSchemaMap(
        makeChatOptions({
          tools: [
            {
              name: "write_to_file",
              inputSchema: {
                type: "object",
                properties: {
                  TargetFile: { type: "string" },
                  CodeContent: { type: "string" },
                },
                required: ["TargetFile", "CodeContent"],
              },
            },
          ],
        }),
      ).get("write_to_file");

      const repaired = repairToolArguments(
        "write_to_file",
        { filePath: "/workspace/src/file.ts", content: "export const a = 1;" },
        requestContext,
        writeToFileSchema,
      );

      expect(repaired.TargetFile).toBe("/workspace/src/file.ts");
      expect(repaired.CodeContent).toBe("export const a = 1;");
      expect(hasRequiredToolArguments(repaired, writeToFileSchema)).toBe(true);
    });
  });
  it("keeps a tool tag inside return'...' as text", () => {
    const text =
      "return'hello <tool_call> <function=read_file> <parameter=filePath> /tmp/a.ts </parameter> </function> </tool_call>'";
    const result = parseTextEmbeddedToolCalls(text);
    expect(result.segments.filter((segment) => segment.type === "toolCall")).toEqual([]);
    const visible = result.segments
      .filter((segment): segment is { type: "text"; text: string } => segment.type === "text")
      .map((segment) => segment.text)
      .join("");
    expect(visible).toContain("<tool_call>");
  });

  it("still executes a tool call after a plural possessive", () => {
    const text =
      "users' <tool_call> <function=read_file> <parameter=filePath> /tmp/a.ts </parameter> </function> </tool_call>";
    const result = parseTextEmbeddedToolCalls(text);
    const toolCalls = result.segments.filter((segment) => segment.type === "toolCall");
    expect(toolCalls).toEqual([
      {
        type: "toolCall",
        toolCall: {
          name: "read_file",
          args: { filePath: "/tmp/a.ts" },
        },
      },
    ]);
  });

  it("parses single-line XML tool call with preceding reasoning prose and apostrophe", () => {
    const text =
      "Let's start with getApiKeyFromConfiguration.\n\nI need to find where getApiKeyFromConfiguration is defined and replace its body with a delegation.\n\nLet's locate the function. I'll search for \"function getApiKeyFromConfiguration\". <tool_call> <function=grep_search> <parameter=includePattern> src/provider.ts </parameter> <parameter=query> function getApiKeyFromConfiguration </parameter> <parameter=isRegexp> false </parameter> </function> </tool_call>\n\nNow I need to replace the API key related functions with calls to the apiKeyManager.";

    for (const chunkSize of [1, 5, 13, text.length]) {
      let pending = "";
      const allSegments: ParsedTextSegment[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        const res = parseTextEmbeddedToolCalls(pending + chunk);
        pending = res.incompleteText;
        allSegments.push(...res.segments);
      }
      if (pending) {
        const finalRes = parseTextEmbeddedToolCalls(pending);
        allSegments.push(...finalRes.segments);
      }

      const toolCalls = allSegments.filter(
        (
          s,
        ): s is {
          type: "toolCall";
          toolCall: { name: string; args: Record<string, unknown> };
        } => s.type === "toolCall",
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall).toEqual({
        name: "grep_search",
        args: {
          includePattern: "src/provider.ts",
          query: "function getApiKeyFromConfiguration",
          isRegexp: false,
        },
      });

      const textSegments = allSegments
        .filter((s): s is { type: "text"; text: string } => s.type === "text")
        .map((s) => s.text)
        .join("");
      expect(textSegments).not.toContain("<tool_call>");
      expect(textSegments).not.toContain("</tool_call>");
      expect(textSegments).not.toContain("<function");
      expect(textSegments).not.toContain("</function>");
      expect(textSegments).not.toContain("<parameter");
      expect(textSegments).toContain("Let's start with getApiKeyFromConfiguration.");
      expect(textSegments).toContain("Now I need to replace the API key related functions");
    }
  });

  it("parses screenshot text with read_file XML tool call", () => {
    const text =
      "We have read the tokenizer.ts file. It's a small utility for token estimation.\n\nNow, let's look at the message-parts.ts to understand the LegacyPart.\n<tool_call> <function=read_file> <parameter=endLine> 2000 </parameter> <parameter=filePath> c:\\Users\\bauir\\source\\project\\nvidia-nim-provider by hidenobunagai\\src\\message-parts.ts </parameter> <parameter=startLine> 1 </parameter> </function> </tool_call>";

    for (const chunkSize of [1, 5, 13, text.length]) {
      let pending = "";
      const allSegments: ParsedTextSegment[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        const res = parseTextEmbeddedToolCalls(pending + chunk);
        pending = res.incompleteText;
        allSegments.push(...res.segments);
      }
      if (pending) {
        const finalRes = parseTextEmbeddedToolCalls(pending);
        allSegments.push(...finalRes.segments);
      }

      const toolCalls = allSegments.filter(
        (s): s is { type: "toolCall"; toolCall: { name: string; args: Record<string, unknown> } } =>
          s.type === "toolCall",
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall.name).toBe("read_file");

      const textSegments = allSegments
        .filter((s): s is { type: "text"; text: string } => s.type === "text")
        .map((s) => s.text)
        .join("");
      expect(textSegments).not.toContain("<tool_call>");
      expect(textSegments).not.toContain("</tool_call>");
    }
  });

  describe("text-embedded JSON tool fallback parsing (Issue #15)", () => {
    const multiToolOptions = makeChatOptions({
      tools: [
        {
          name: "read_file",
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              startLine: { type: "integer" },
              endLine: { type: "integer" },
            },
            required: ["filePath"],
          },
        },
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
          name: "run_in_terminal",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string" },
              explanation: { type: "string" },
            },
            required: ["command"],
          },
        },
      ],
    });
    const toolSchemas = getToolSchemaMap(multiToolOptions);

    it("recovers Nemotron raw JSON tool call matching insert_edit_into_file without native wrapper (Issue #15)", () => {
      const rawText = JSON.stringify(
        {
          filePath: "/home/rdp/code/blue-forks/mwmbl/mwmbl/crawler/stats.py",
          code: "\nfrom mwmbl.crawler.urls import URLDatabase",
          explanation: "Add import for URLDatabase from mwmbl.crawler.urls",
        },
        null,
        2,
      );

      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "insert_edit_into_file",
            args: {
              filePath: "/home/rdp/code/blue-forks/mwmbl/mwmbl/crawler/stats.py",
              code: "\nfrom mwmbl.crawler.urls import URLDatabase",
              explanation: "Add import for URLDatabase from mwmbl.crawler.urls",
            },
          },
        },
      ]);
    });

    it("parses fenced ```json tool call block and strips fences from text", () => {
      const text = [
        "I will update stats.py now:",
        "```json",
        JSON.stringify(
          {
            filePath: "/home/rdp/code/blue-forks/mwmbl/mwmbl/crawler/stats.py",
            code: "\nfrom mwmbl.crawler.urls import URLDatabase",
          },
          null,
          2,
        ),
        "```",
        "Done updating.",
      ].join("\n");

      const result = parseTextEmbeddedToolCalls(text, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        { type: "text", text: "I will update stats.py now:\n" },
        {
          type: "toolCall",
          toolCall: {
            name: "insert_edit_into_file",
            args: {
              filePath: "/home/rdp/code/blue-forks/mwmbl/mwmbl/crawler/stats.py",
              code: "\nfrom mwmbl.crawler.urls import URLDatabase",
            },
          },
        },
        { type: "text", text: "Done updating." },
      ]);
    });

    it("drops forbidden keys copied from a flat JSON tool call", () => {
      const rawText =
        '{"name":"read_file","filePath":"/tmp/a.ts","constructor":"nope","prototype":"nope","__proto__":{"polluted":true}}';
      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/tmp/a.ts" },
          },
        },
      ]);
    });

    it("drops forbidden keys nested in a JSON arguments object", () => {
      const rawText =
        '{"name":"read_file","arguments":{"filePath":"/tmp/a.ts","constructor":"nope","__proto__":{"polluted":true}}}';
      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/tmp/a.ts" },
          },
        },
      ]);
    });

    it("parses explicit tool call with name and arguments", () => {
      const rawText =
        '{"name": "read_file", "arguments": {"filePath": "/tmp/a.ts", "startLine": 1}}';
      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/tmp/a.ts", startLine: 1 },
          },
        },
      ]);
    });

    it("parses explicit tool call with tool and parameters keys", () => {
      const rawText = '{"tool": "run_in_terminal", "parameters": {"command": "npm test"}}';
      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "run_in_terminal",
            args: { command: "npm test" },
          },
        },
      ]);
    });

    it("parses array of tool calls in JSON", () => {
      const rawText = JSON.stringify([
        { name: "read_file", arguments: { filePath: "/tmp/a.ts" } },
        { name: "read_file", arguments: { filePath: "/tmp/b.ts" } },
      ]);
      const result = parseTextEmbeddedToolCalls(rawText, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/tmp/a.ts" },
          },
        },
        {
          type: "toolCall",
          toolCall: {
            name: "read_file",
            args: { filePath: "/tmp/b.ts" },
          },
        },
      ]);
    });

    it("does not treat normal user JSON as a tool call", () => {
      const normalJson = JSON.stringify(
        {
          name: "my-package",
          version: "1.0.0",
          description: "A test package",
        },
        null,
        2,
      );

      const result = parseTextEmbeddedToolCalls(normalJson, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([{ type: "text", text: normalJson }]);
    });

    it("buffers incomplete JSON tool calls across stream chunks", () => {
      const chunk1 = '{\n  "filePath": "/workspace/stats.py",\n  "co';
      const chunk2 = 'de": "import os"\n}';

      const res1 = parseTextEmbeddedToolCalls(chunk1, toolSchemas);
      expect(res1.segments).toEqual([]);
      expect(res1.incompleteText).toBe(chunk1);

      const res2 = parseTextEmbeddedToolCalls(res1.incompleteText + chunk2, toolSchemas);
      expect(res2.incompleteText).toBe("");
      expect(res2.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "insert_edit_into_file",
            args: { filePath: "/workspace/stats.py", code: "import os" },
          },
        },
      ]);
    });

    it("identifies incomplete JSON tool name from partial stream", () => {
      const partialExplicit = '{\n  "name": "insert_edit_into_file",\n  "arguments": {';
      expect(getIncompleteTextToolCallName(partialExplicit, toolSchemas)).toBe(
        "insert_edit_into_file",
      );

      const partialImplicit = '{\n  "command": "npm run build';
      expect(getIncompleteTextToolCallName(partialImplicit, toolSchemas)).toBe("run_in_terminal");
    });

    it("keeps non-tool wrapper objects intact without extracting nested objects", () => {
      const wrapperJson = JSON.stringify({
        summary: "x",
        edit: { filePath: "a.ts", code: "y" },
      });
      const result = parseTextEmbeddedToolCalls(wrapperJson, toolSchemas);
      expect(result.segments).toEqual([{ type: "text", text: wrapperJson }]);
      expect(result.incompleteText).toBe("");
    });

    it("holds an unclosed non-tool wrapper instead of executing the nested object", () => {
      const open = '{"summary":"x","edit":{"filePath":"a.ts","code":"y"}';
      const held = parseTextEmbeddedToolCalls(open, toolSchemas);
      expect(held.segments.filter((segment) => segment.type === "toolCall")).toEqual([]);
      expect(held.incompleteText).toBe(open);

      const closed = parseTextEmbeddedToolCalls(`${held.incompleteText}}`, toolSchemas);
      expect(closed.incompleteText).toBe("");
      expect(closed.segments).toEqual([{ type: "text", text: `${open}}` }]);

      const ended = parseTextEmbeddedToolCalls(open, toolSchemas, { atStreamEnd: true });
      expect(ended.segments.filter((segment) => segment.type === "toolCall")).toEqual([]);
      expect(getIncompleteTextToolCallName(open, toolSchemas)).toBeUndefined();
    });

    it("still extracts a tool call that follows a closed stray brace", () => {
      const text = 'Use {braces} in prose {"filePath":"a.ts","code":"y"}';
      const result = parseTextEmbeddedToolCalls(text, toolSchemas);
      expect(result.incompleteText).toBe("");
      expect(result.segments).toEqual([
        { type: "text", text: "Use {braces} in prose " },
        {
          type: "toolCall",
          toolCall: {
            name: "insert_edit_into_file",
            args: { filePath: "a.ts", code: "y" },
          },
        },
      ]);
    });

    it("commits a complete fenced tool call when the stream ends without a closing fence", () => {
      const fenced = '```json\n{"filePath":"a.ts","code":"y"}\nsome trailing text';
      const midStream = parseTextEmbeddedToolCalls(fenced, toolSchemas);
      expect(midStream.segments).toEqual([]);
      expect(midStream.incompleteText).toBe(fenced);

      const ended = parseTextEmbeddedToolCalls(fenced, toolSchemas, { atStreamEnd: true });
      expect(ended.incompleteText).toBe("");
      expect(ended.segments).toEqual([
        {
          type: "toolCall",
          toolCall: {
            name: "insert_edit_into_file",
            args: { filePath: "a.ts", code: "y" },
          },
        },
        { type: "text", text: "some trailing text" },
      ]);
    });

    it("waits for closing fence on fenced JSON payload", () => {
      const fencedPartial = '```json\n{"filePath":"a.ts","code":"y"}\nsome trailing text';
      const result = parseTextEmbeddedToolCalls(fencedPartial, toolSchemas);
      expect(result.incompleteText).toBe(fencedPartial);
      expect(result.segments).toEqual([]);
    });

    it("does not treat explicit name JSON as tool call when tools are disabled", () => {
      const json = JSON.stringify({ name: "my-package", version: "1.0.0" });
      const result = parseTextEmbeddedToolCalls(json, undefined);
      expect(result.segments).toEqual([{ type: "text", text: json }]);
    });

    it("does not treat prose mentioning property names as incomplete tool calls", () => {
      const prose = 'Note that "filePath" is a required parameter for reading files.';
      expect(getIncompleteTextToolCallName(prose, toolSchemas)).toBeUndefined();
    });
  });
});

describe("text tool calls across chunks and at stream end", () => {
  const readFileCall =
    "<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>";
  const toolCalls = (result: ReturnType<typeof parseTextEmbeddedToolCalls>) =>
    result.segments.filter((segment) => segment.type === "toolCall");
  const visibleText = (result: ReturnType<typeof parseTextEmbeddedToolCalls>) =>
    result.segments.map((segment) => (segment.type === "text" ? segment.text : "")).join("");

  it("emits a held closing code fence as text when the stream ends", () => {
    const midStream = parseTextEmbeddedToolCalls("code\n```", undefined);
    expect(midStream.incompleteText).toBe("```");

    const ended = parseTextEmbeddedToolCalls("```", undefined, { atStreamEnd: true });
    expect(ended.incompleteText).toBe("");
    expect(visibleText(ended)).toBe("```");
  });

  it("emits a held tag-like tail as text when the stream ends", () => {
    const ended = parseTextEmbeddedToolCalls("Use x<p", undefined, { atStreamEnd: true });
    expect(ended.incompleteText).toBe("");
    expect(visibleText(ended)).toBe("Use x<p");
  });

  it("keeps a truncated named tool call incomplete at stream end", () => {
    const truncated = "<tool_call>\n<function=read_file>\n<parameter=path>\na.t";
    const ended = parseTextEmbeddedToolCalls(truncated, undefined, { atStreamEnd: true });
    expect(ended.segments).toEqual([]);
    expect(ended.incompleteText).toBe(truncated);
  });

  it("commits an XML call that is only missing its closing tags at stream end", () => {
    const unclosed =
      "<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n";
    const midStream = parseTextEmbeddedToolCalls(unclosed, undefined);
    expect(toolCalls(midStream)).toEqual([]);

    const ended = parseTextEmbeddedToolCalls(unclosed, undefined, { atStreamEnd: true });
    expect(ended.incompleteText).toBe("");
    expect(toolCalls(ended)).toEqual([
      { type: "toolCall", toolCall: { name: "read_file", args: { path: "a.txt" } } },
    ]);
  });

  it("holds a chunk that ends inside the name attribute", () => {
    const first = parseTextEmbeddedToolCalls('Let me check.\n<invoke name="read_fi', undefined);
    expect(visibleText(first)).toBe("Let me check.\n");
    expect(first.incompleteText).toBe('<invoke name="read_fi');

    const second = parseTextEmbeddedToolCalls(
      `${first.incompleteText}le"><parameter name="path">a.txt</parameter></invoke>`,
      undefined,
    );
    expect(toolCalls(second)).toEqual([
      { type: "toolCall", toolCall: { name: "read_file", args: { path: "a.txt" } } },
    ]);
  });

  it("extracts a real call that follows a fenced example", () => {
    const text = `Format:\n\`\`\`xml\n<tool_call>x</tool_call>\n\`\`\`\n\n${readFileCall}`;
    const result = parseTextEmbeddedToolCalls(text, undefined);
    expect(toolCalls(result)).toEqual([
      { type: "toolCall", toolCall: { name: "read_file", args: { path: "a.txt" } } },
    ]);
    expect(visibleText(result)).toContain("<tool_call>x</tool_call>");
  });

  it("does not run an example inside a fence opened in an earlier chunk", () => {
    const context = new TextParseContext();
    const first = parseTextEmbeddedToolCalls("Format example:\n```xml\n", undefined, {
      contextPrefix: context.prefix(),
    });
    context.append(visibleText(first));

    const second = parseTextEmbeddedToolCalls(`${readFileCall}\n\`\`\``, undefined, {
      contextPrefix: context.prefix(),
      atStreamEnd: true,
    });
    expect(toolCalls(second)).toEqual([]);
    expect(visibleText(second)).toContain("<function=read_file>");
  });

  it("parses a call after a fence that an earlier chunk closed", () => {
    const context = new TextParseContext();
    context.append("```xml\n<tool_call>x</tool_call>\n```\n");
    expect(context.prefix()).toBe("");

    const result = parseTextEmbeddedToolCalls(readFileCall, undefined, {
      contextPrefix: context.prefix(),
    });
    expect(toolCalls(result)).toHaveLength(1);
  });
});
