import * as vscode from "vscode";
import {
  buildInvalidToolCallFallback,
  buildInvalidToolCallRetryMessage,
  buildToolCallCanonicalKey,
  extractStandaloneXmlParameters,
  getIncompleteTextToolCallName,
  getToolSchemaMap,
  hasRequiredToolArguments,
  isDuplicateSuppressionEnabled,
  parseTextEmbeddedToolCalls,
  parseToolArguments,
  repairToolArguments,
  stripKnownControlText,
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

  it("reports a completed duplicate instead of dropping it silently", () => {
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

    expect(emitted).toEqual([]);
    expect(skipped).toEqual([{ name: "read_file", required: [], reason: "duplicate" }]);
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

  it("explains missing tool-call payloads and duplicates in fallback text", () => {
    expect(
      buildInvalidToolCallFallback([
        { name: "tool_call", required: [], reason: "missing_payload" },
      ]),
    ).toContain("did not include tool arguments");
    expect(
      buildInvalidToolCallRetryMessage([
        { name: "tool_call", required: [], reason: "missing_payload" },
      ]),
    ).toContain("empty tool_calls array");
    expect(
      buildInvalidToolCallFallback([{ name: "read_file", required: [], reason: "duplicate" }]),
    ).toContain("already completed");
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

  it("unwraps Copilot scaffold tags and keeps inner markdown", () => {
    const rawText = [
      "<steps>### Verification</steps>",
      "<suggested_fix>Add a fallback pixmap.</suggested_fix>",
      "<next_steps>Want a patch?</next_steps>",
    ].join(" ");

    expect(stripKnownControlText(rawText)).toBe(
      "### Verification Add a fallback pixmap. Want a patch?",
    );
  });

  it("replaces _vscodecontentref_ markdown links with the label and drops bare refs", () => {
    const rawText =
      "See [natureprovider.cpp](http://_vscodecontentref_/0) and https://_vscodecontentref_/1 then _vscodecontentref_/2.";

    expect(stripKnownControlText(rawText)).toBe("See natureprovider.cpp and  then .");
  });

  it("preserves _vscodecontentref_ and scaffold tags inside fences and string literals", () => {
    const fenced = '```ts\nconst url = "http://_vscodecontentref_/0";\nconst tag = "<steps>";\n```';
    expect(stripKnownControlText(fenced)).toBe(fenced);

    const quoted = 'const link = "[file.cpp](http://_vscodecontentref_/0)";';
    expect(stripKnownControlText(quoted)).toBe(quoted);
  });

  it("does not unwrap HTML, C# doc tags, or tool XML as scaffold", () => {
    expect(stripKnownControlText("<div>keep</div>")).toBe("<div>keep</div>");
    expect(stripKnownControlText("/// <summary>Docs</summary>")).toBe(
      "/// <summary>Docs</summary>",
    );
    expect(stripKnownControlText('<tool_call name="read_file">')).toBe(
      '<tool_call name="read_file">',
    );
  });

  it("buffers an incomplete scaffold tag or vscodecontentref URL across chunks", () => {
    const splitTag = parseTextEmbeddedToolCalls("Before <steps");
    expect(splitTag.incompleteText).toBe("<steps");
    expect(splitTag.segments).toEqual([{ type: "text", text: "Before " }]);

    const completedTag = parseTextEmbeddedToolCalls(splitTag.incompleteText + ">Look here</steps>");
    expect(completedTag.incompleteText).toBe("");
    expect(completedTag.segments).toEqual([{ type: "text", text: "Look here" }]);

    const splitRef = parseTextEmbeddedToolCalls("See [file.cpp](http://_vscodecontentref_");
    expect(splitRef.incompleteText).toContain("_vscodecontentref_");
    expect(splitRef.segments).toEqual([{ type: "text", text: "See " }]);
    const completedRef = parseTextEmbeddedToolCalls(splitRef.incompleteText + "/0)");
    expect(completedRef.incompleteText).toBe("");
    expect(completedRef.segments).toEqual([{ type: "text", text: "file.cpp" }]);
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

  it("skips argument repair when autoRepairArguments is disabled", () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "tools.autoRepairArguments") return false;
        return defaultValue;
      }),
    });

    const schema = getToolSchemaMap(options).get("read_file");
    const raw = { path: "/tmp/a.ts", startLine: "1" };
    const repaired = repairToolArguments("read_file", raw, undefined, schema);

    expect(repaired).toEqual({ path: "/tmp/a.ts", startLine: "1" });
    expect(repaired.filePath).toBeUndefined();
  });

  it("disables duplicate suppression when suppressDuplicateReads is false", () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "tools.suppressDuplicateReads") return false;
        return defaultValue;
      }),
    });

    expect(isDuplicateSuppressionEnabled("read_file")).toBe(false);
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
        endLine: 200,
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
        endLine: 200,
      });
      expect(hasRequiredToolArguments(repaired, readFileSchema)).toBe(true);
    });

    it("preserves explicit startLine and defaults endLine to startLine + 199 for read_file", () => {
      const repaired = repairToolArguments(
        "read_file",
        { filePath: "/workspace/src/AutoroutePartHandler.cs", startLine: 50 },
        requestContext,
        readFileSchema,
      );

      expect(repaired).toEqual({
        filePath: "/workspace/src/AutoroutePartHandler.cs",
        startLine: 50,
        endLine: 249,
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
        EndLine: 200,
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
});
