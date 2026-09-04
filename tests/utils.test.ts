import * as vscode from "vscode";
import { NimChatMessage } from "../src/types";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateToolsTokens,
  estimateTokens,
} from "../src/messages/converter";
import { filterThinkTagsFromChunk, flushThinkTagFilter } from "../src/messages/think-filter";
import {
  findEarliestIndex,
  findTrailingPartialStart,
  findTrailingPartialStartAny,
  splitOnTag,
} from "../src/messages/tag-scan";
import { makeChatMessages, makeChatOptions, SYSTEM_ROLE } from "./helpers/fakes";

describe("convertMessages", () => {
  it("converts user text message", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart("Hello")],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toEqual<NimChatMessage[]>([{ role: "user", content: "Hello" }]);
  });

  it("converts assistant text message", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [new vscode.LanguageModelTextPart("Hi there")],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toEqual<NimChatMessage[]>([{ role: "assistant", content: "Hi there" }]);
  });

  it("converts system text message", () => {
    const messages = [
      {
        role: SYSTEM_ROLE,
        content: [new vscode.LanguageModelTextPart("Be helpful")],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toEqual<NimChatMessage[]>([{ role: "system", content: "Be helpful" }]);
  });

  it("handles empty messages", () => {
    const messages = [{ role: vscode.LanguageModelChatMessageRole.User, content: [] }];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toEqual<NimChatMessage[]>([{ role: "user", content: "(empty message)" }]);
  });

  it("rejects number-array images over the chat size cap", () => {
    const oversized = Array.from({ length: 20 * 1024 * 1024 + 1 }, () => 1);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [{ mimeType: "image/png", data: oversized }],
      },
    ];
    expect(() => convertMessages(makeChatMessages(...messages), { supportsVision: true })).toThrow(
      /exceeds the .* chat image limit/,
    );
  });

  it("converts image parts to image_url for vision-capable models", () => {
    const imageData = new Uint8Array([1, 2, 3]);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [{ mimeType: "image/png", data: imageData }],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages), {
      supportsVision: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const content = result[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("does not convert image parts when vision is not supported", () => {
    const imageData = new Uint8Array([1, 2, 3]);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelTextPart("Describe this image"),
          { mimeType: "image/png", data: imageData },
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages), {
      supportsVision: false,
    });
    expect(result).toEqual<NimChatMessage[]>([{ role: "user", content: "Describe this image" }]);
  });

  it("extracts thinking parts into reasoning_content for assistant messages", () => {
    class LanguageModelThinkingPart {
      constructor(public value: string) {}
    }
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new LanguageModelThinkingPart("Let me consider the problem"),
          new vscode.LanguageModelTextPart("Here is the answer"),
        ],
      },
    ];
    const result = convertMessages(
      makeChatMessages(...(messages as unknown as vscode.LanguageModelChatMessage[])),
    );
    expect(result).toEqual<NimChatMessage[]>([
      {
        role: "assistant",
        content: "Here is the answer",
        reasoning_content: "Let me consider the problem",
      },
    ]);
  });
});

describe("estimateTokens", () => {
  it("estimates tokens for ASCII text", () => {
    expect(estimateTokens("Hello world")).toBeGreaterThan(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates tokens for multiple messages", () => {
    const messages = [
      { content: [new vscode.LanguageModelTextPart("Hello")] },
      { content: [new vscode.LanguageModelTextPart("world")] },
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateTokens("Hello") + estimateTokens("world"),
    );
  });

  it("counts tool result and tool call parts by content, not a flat 2 tokens", () => {
    const longContent = "a".repeat(400);
    const args = { filePath: "/tmp/x.md", startLine: 1, endLine: 5 };
    const messages = [
      {
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart(longContent),
          ]),
        ],
      },
      {
        content: [new vscode.LanguageModelToolCallPart("call_1", "read_file", args)],
      },
    ];
    const result = estimateMessagesTokens(messages);
    expect(result).toBe(
      estimateTokens(longContent) +
        estimateTokens("read_file") +
        estimateTokens(JSON.stringify(args)),
    );
    expect(result).toBeGreaterThan(4);
  });
});

describe("convertTools", () => {
  it("returns empty object when no tools", () => {
    const result = convertTools(
      makeChatOptions({
        tools: [],
      }),
    );
    expect(result).toEqual({});
  });

  it("converts VS Code tools to NVIDIA NIM format", () => {
    const result = convertTools(
      makeChatOptions({
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0].type).toBe("function");
    expect(result.tools?.[0].function.name).toBe("test_tool");
    expect(result.tool_choice).toBe("auto");
  });

  it("keeps only payload fields in the model-facing required list", () => {
    const result = convertTools(
      makeChatOptions({
        tools: [
          {
            name: "run_in_terminal",
            description: "Run a shell command",
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
    );

    expect(result.tool_choice).toBe("auto");
    expect(result.tools?.[0].function.parameters).toEqual(
      expect.objectContaining({
        required: ["command"],
      }),
    );
    const description = result.tools?.[0].function.description ?? "";
    expect(description).toContain("Required: command");
    expect(description).not.toContain("goal");
    expect(description).not.toContain("explanation");
  });

  it("augments tool descriptions with required parameter guidance", () => {
    const result = convertTools(
      makeChatOptions({
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string", description: "Absolute path to the file" },
                offset: { type: "number" },
              },
              required: ["filePath"],
            },
          },
        ],
      }),
    );
    expect(result.tools).toHaveLength(1);
    const description = result.tools?.[0].function.description ?? "";
    expect(description).toContain("Required: filePath");
    expect(description).toContain("Read a file from disk");
  });

  it("includes enum choices for required string arguments", () => {
    const result = convertTools(
      makeChatOptions({
        tools: [
          {
            name: "memory",
            description: "Manage persistent memory",
            inputSchema: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
                  description: "Memory operation to perform",
                },
                path: {
                  type: "string",
                  description: "Target memory path",
                },
              },
              required: ["command"],
            },
          },
        ],
      }),
    );

    const description = result.tools?.[0].function.description ?? "";
    expect(description).toContain(
      "Required: command (view, create, str_replace, insert, delete, rename)",
    );
  });
});

describe("convertMessages with tools", () => {
  it("converts tool call parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new vscode.LanguageModelTextPart("Let me check"),
          new vscode.LanguageModelToolCallPart("call_1", "get_weather", { city: "Tokyo" }),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].reasoning_content).toBeUndefined();
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls?.[0].function.name).toBe("get_weather");
  });

  it("converts tool result parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart("Sunny, 25C"),
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_1");
    expect(result[0].content).toBe("Sunny, 25C");
  });

  it("converts structured tool result parts via value field", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { value: { filePath: "/tmp/a.txt", content: "hello" } },
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_1");
    expect(result[0].content).toContain("filePath");
    expect(result[0].content).toContain("/tmp/a.txt");
    expect(result[0].content).toContain("hello");
  });

  it("drops cache-control metadata from tool result parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { mimeType: "cache_control", data: "ZXBoZW1lcmFs" },
            new vscode.LanguageModelTextPart("real result"),
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("real result");
  });

  it("decodes base64 json data parts in tool results", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({ filePath: "/tmp/a.txt", content: "hello" }),
      "utf8",
    );
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { $mid: 24, mimeType: "application/json", data: jsonBytes.toString("base64") },
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toContain("filePath");
    expect(result[0].content).toContain("/tmp/a.txt");
    expect(result[0].content).toContain("hello");
  });

  it("keeps plain text data strings unchanged even if they look like base64", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { $mid: 24, mimeType: "text/plain", data: "eyJ9" },
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("eyJ9");
  });

  it("truncates tool result content when maxToolResultChars is set", () => {
    const longContent = "a".repeat(100);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart(longContent),
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages), {
      maxToolResultChars: 50,
    });
    expect(result[0].content).toBe("a".repeat(50) + "…");
  });

  it("does not truncate when content is within limit", () => {
    const shortContent = "short content";
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart(shortContent),
          ]),
        ],
      },
    ];
    const result = convertMessages(makeChatMessages(...messages), {
      maxToolResultChars: 100,
    });
    expect(result[0].content).toBe(shortContent);
  });
});

describe("tag-scan shared helpers", () => {
  it("finds the earliest tag case-insensitively", () => {
    expect(findEarliestIndex("a </THINK> b </think>", ["</think>", "</thought>"])).toEqual({
      index: 2,
      token: "</think>",
    });
    expect(findEarliestIndex("no tags here", ["</think>"])).toBeUndefined();
  });

  it("detects trailing partial tag prefixes", () => {
    expect(findTrailingPartialStart("reasoning </thi", "</think>")).toBe(10);
    expect(findTrailingPartialStart("clean text", "</think>")).toBe(-1);
    expect(findTrailingPartialStartAny("reasoning </tho", ["</think>", "</thought>"])).toBe(10);
  });

  it("splits text around a tag", () => {
    expect(splitOnTag("before</think>after", 6, "</think>".length)).toEqual({
      before: "before",
      after: "after",
    });
  });
});

describe("filterThinkTagsFromChunk cross-chunk handling", () => {
  it("buffers partial open tag and resolves in next chunk", () => {
    const state = { insideThinkBlock: false, pendingText: "" };
    const result1 = filterThinkTagsFromChunk("hello <thin", state);
    expect(result1).toEqual([{ type: "text", text: "hello " }]);

    const result2 = filterThinkTagsFromChunk("k>hidden</think> world", state);
    expect(result2).toEqual([
      { type: "thinking", text: "hidden" },
      { type: "text", text: " world" },
    ]);
    expect(state.insideThinkBlock).toBe(false);
  });

  it("buffers partial close tag inside think block across chunks", () => {
    const state = { insideThinkBlock: true, pendingText: "" };
    const result1 = filterThinkTagsFromChunk("text </thin", state);
    expect(result1).toEqual([{ type: "thinking", text: "text " }]);

    const result2 = filterThinkTagsFromChunk("k> visible", state);
    expect(result2).toEqual([{ type: "text", text: " visible" }]);
    expect(state.insideThinkBlock).toBe(false);
  });

  it("buffers partial close tag starting with </ across chunks", () => {
    const state = { insideThinkBlock: true, pendingText: "" };
    const result1 = filterThinkTagsFromChunk("text </", state);
    expect(result1).toEqual([{ type: "thinking", text: "text " }]);

    const result2 = filterThinkTagsFromChunk("think> visible", state);
    expect(result2).toEqual([{ type: "text", text: " visible" }]);
    expect(state.insideThinkBlock).toBe(false);
  });
});

describe("flushThinkTagFilter", () => {
  it("flushes pending text as a text segment when not inside a think block", () => {
    const state = { insideThinkBlock: false, pendingText: "leftover" };
    expect(flushThinkTagFilter(state)).toEqual([{ type: "text", text: "leftover" }]);
    expect(state.pendingText).toBe("");
    expect(state.insideThinkBlock).toBe(false);
  });

  it("discards a partial close tag when flushing inside a think block", () => {
    const state = { insideThinkBlock: true, pendingText: "</thi" };
    expect(flushThinkTagFilter(state)).toEqual([]);
    expect(state.pendingText).toBe("");
    expect(state.insideThinkBlock).toBe(false);
  });

  it("returns no segments when the state is already clean", () => {
    const state = { insideThinkBlock: false, pendingText: "" };
    expect(flushThinkTagFilter(state)).toEqual([]);
  });
});

describe("filterThinkTagsFromChunk think-block capture", () => {
  it("captures a complete think block as a thinking segment followed by text", () => {
    const state = { insideThinkBlock: false, pendingText: "" };
    const result = filterThinkTagsFromChunk("<think>reasoning</think>answer", state);
    expect(result).toEqual([
      { type: "thinking", text: "reasoning" },
      { type: "text", text: "answer" },
    ]);
  });

  it("emits thinking incrementally while inside a think block across chunks", () => {
    const state = { insideThinkBlock: false, pendingText: "" };
    const result1 = filterThinkTagsFromChunk("<think>part one ", state);
    expect(result1).toEqual([{ type: "thinking", text: "part one " }]);

    const result2 = filterThinkTagsFromChunk("part two</think>visible", state);
    expect(result2).toEqual([
      { type: "thinking", text: "part two" },
      { type: "text", text: "visible" },
    ]);
    expect(state.insideThinkBlock).toBe(false);
  });

  it("preserves text before a think block", () => {
    const state = { insideThinkBlock: false, pendingText: "" };
    const result = filterThinkTagsFromChunk("before<think>inner</think>after", state);
    expect(result).toEqual([
      { type: "text", text: "before" },
      { type: "thinking", text: "inner" },
      { type: "text", text: "after" },
    ]);
  });

  it("handles [THINK], <thought>, and <reasoning> tag pairs seamlessly", () => {
    const state1 = { insideThinkBlock: false, pendingText: "" };
    const res1 = filterThinkTagsFromChunk("Intro [THINK]hidden thoughts[/THINK] Outro", state1);
    expect(res1).toEqual([
      { type: "text", text: "Intro " },
      { type: "thinking", text: "hidden thoughts" },
      { type: "text", text: " Outro" },
    ]);

    const state2 = { insideThinkBlock: false, pendingText: "" };
    const res2 = filterThinkTagsFromChunk("<thought>planning</thought>action", state2);
    expect(res2).toEqual([
      { type: "thinking", text: "planning" },
      { type: "text", text: "action" },
    ]);

    const state3 = { insideThinkBlock: false, pendingText: "" };
    const res3 = filterThinkTagsFromChunk("<reasoning>logic</reasoning>result", state3);
    expect(res3).toEqual([
      { type: "thinking", text: "logic" },
      { type: "text", text: "result" },
    ]);
  });
});

describe("estimateToolsTokens", () => {
  it("returns 0 for empty tools array", () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  it("counts name + description + parameters for each tool", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
      },
    ];
    const result = estimateToolsTokens(tools);
    expect(result).toBe(
      estimateTokens("read_file") +
        estimateTokens("Read a file from disk") +
        estimateTokens(
          JSON.stringify({ type: "object", properties: { filePath: { type: "string" } } }),
        ),
    );
    expect(result).toBeGreaterThan(0);
  });

  it("sums multiple tools", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "tool_a", description: "Does A", parameters: { type: "object" } },
      },
      {
        type: "function" as const,
        function: { name: "tool_b", description: "Does B", parameters: { type: "object" } },
      },
    ];
    const result = estimateToolsTokens(tools);
    const expected =
      estimateTokens("tool_a") +
      estimateTokens("Does A") +
      estimateTokens(JSON.stringify({ type: "object" })) +
      estimateTokens("tool_b") +
      estimateTokens("Does B") +
      estimateTokens(JSON.stringify({ type: "object" }));
    expect(result).toBe(expected);
  });
});
