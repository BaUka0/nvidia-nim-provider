import {
  buildHistoryLoopBreakerContent,
  buildLoopBreakerNudge,
  detectHistoryLoop,
  detectToolCallHistoryLoop,
  injectHistoryLoopBreaker,
  LoopBreakerNudgeReason,
} from "../src/provider/loop-breaker";
import { NimChatRequest } from "../src/types";
import { normalizeLineForRepetition } from "../src/provider/repetition-guard";

describe("buildLoopBreakerNudge", () => {
  const reasons: LoopBreakerNudgeReason[] = [
    "repetition_loop",
    "tool_call_loop",
    "output_truncated",
    "content_filter",
    "stream_timeout",
  ];

  it.each(reasons)("builds a user role nudge for reason %s", (reason) => {
    const nudge = buildLoopBreakerNudge(reason);
    expect(nudge.role).toBe("user");
    expect(typeof nudge.content).toBe("string");
    expect(nudge.content.length).toBeGreaterThan(10);
  });

  it("nudges a stalled stream to continue from where it left off", () => {
    const nudge = buildLoopBreakerNudge("stream_timeout");
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("stalled");
  });

  it("nudges on repetition loop without adversarial tags", () => {
    const nudge = buildLoopBreakerNudge("repetition_loop");
    expect(nudge.role).toBe("user");
    expect(nudge.content).not.toContain("[NIM_LOOP_BREAKER]");
    expect(nudge.content).toContain("without repeating");
  });
});

describe("detectHistoryLoop", () => {
  const assistant = (text: string) => ({ role: 2, content: [{ value: text }] });

  it("detects 3 consecutive identical assistant preambles", () => {
    const messages = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
    ];
    expect(detectHistoryLoop(messages)).toBe(
      normalizeLineForRepetition("Let me fix the formatting issue:"),
    );
  });

  it("returns undefined below the repeat threshold", () => {
    const messages = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Something different entirely"),
    ];
    expect(detectHistoryLoop(messages)).toBeUndefined();
  });

  it("detects unicode preambles", () => {
    const messages = [
      assistant("Давайте исправим ошибку:"),
      assistant("Давайте исправим ошибку:"),
      assistant("Давайте исправим ошибку:"),
    ];
    expect(detectHistoryLoop(messages)).toBe(
      normalizeLineForRepetition("Давайте исправим ошибку:"),
    );
  });

  it("ignores non-assistant messages", () => {
    const messages = [
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
    ];
    expect(detectHistoryLoop(messages)).toBeUndefined();
  });

  it("detects prefix N-gram loops where actions differ after 'Let me'", () => {
    const messages = [
      assistant("Let me first check the current browser page to see if we're already on GitHub:"),
      assistant("Let me take a screenshot to see where the Sign in button is:"),
      assistant("Let me navigate directly to https://github.com/login using the browser:"),
    ];
    expect(detectHistoryLoop(messages)).toBe("let me");
  });
});

describe("detectToolCallHistoryLoop", () => {
  const toolCall = (name: string, input: unknown) => ({
    role: 2,
    content: [{ name, input }],
  });

  it("detects 3 identical consecutive tool calls", () => {
    const messages = [
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
    ];
    expect(detectToolCallHistoryLoop(messages)).toBeDefined();
  });

  it("returns undefined when tool arguments differ", () => {
    const messages = [
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 2 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 3 }),
    ];
    expect(detectToolCallHistoryLoop(messages)).toBeUndefined();
  });
});

describe("injectHistoryLoopBreaker", () => {
  const assistant = (text: string) => ({ role: 2, content: [{ value: text }] });

  it("injects a neutral user breaker when preamble loop is detected", () => {
    const history = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
    ];
    const body: NimChatRequest = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "continue" }],
    };
    const result = injectHistoryLoopBreaker({
      requestBody: body,
      historyMessages: history,
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      applyBudget: (b) => b,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toContain("repeated the preamble");
    expect(result.messages[1].content).not.toContain("[NIM_LOOP_BREAKER]");
  });

  it("does not inject breaker when no loop is detected", () => {
    const history = [assistant("Let me check the file:"), assistant("Finished the change.")];
    const body: NimChatRequest = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "continue" }],
    };
    const result = injectHistoryLoopBreaker({
      requestBody: body,
      historyMessages: history,
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      applyBudget: (b) => b,
    });
    expect(result.messages).toHaveLength(1);
  });

  it("does not duplicate injection if already present in requestBody", () => {
    const history = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
    ];
    const breaker = buildHistoryLoopBreakerContent(history)!;
    const body: NimChatRequest = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [
        { role: "user", content: "continue" },
        { role: "user", content: breaker },
      ],
    };
    const result = injectHistoryLoopBreaker({
      requestBody: body,
      historyMessages: history,
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      applyBudget: (b) => b,
    });
    expect(result.messages).toHaveLength(2);
  });
});
