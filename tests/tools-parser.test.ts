import {
  buildToolCallCanonicalKey,
  extractStandaloneXmlParameters,
  getIncompleteTextToolCallName,
  getToolSchemaMap,
  hasRequiredToolArguments,
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

  it("resolves common property aliases (path -> filePath, code -> content)", () => {
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

    const rawArgs = { path: "/workspace/main.py", code: 'print("hello")' };
    const repaired = repairToolArguments("create_file", rawArgs, undefined, createFileSchema);

    expect(repaired).toEqual({
      path: "/workspace/main.py",
      code: 'print("hello")',
      filePath: "/workspace/main.py",
      content: 'print("hello")',
    });
    expect(hasRequiredToolArguments(repaired, createFileSchema)).toBe(true);
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
});
