import {
  RepetitionGuard,
  detectCycleHint,
  detectPhraseCycle,
  normalizeLineForRepetition,
} from "../src/provider/repetition-guard";

const ISSUE_7_SUPER_CYCLE = [
  "Probably it's done. Let's check subfolders. We need to see if it succeeded. Let's check a sample file. We need to check if the script is still running or finished. Let's see output more. ",
].join("");

describe("detectPhraseCycle", () => {
  it("returns a gram for the Super 120B paragraph and ignores a normal answer", () => {
    expect(detectPhraseCycle(ISSUE_7_SUPER_CYCLE.repeat(3))).toEqual(expect.any(String));
    expect(detectPhraseCycle(ISSUE_7_SUPER_CYCLE.repeat(2))).toBeUndefined();
    expect(
      detectPhraseCycle("Here is the refactored function. It now returns the parsed JSON payload."),
    ).toBeUndefined();
    expect(detectCycleHint("")).toBe(false);
    expect(detectCycleHint(ISSUE_7_SUPER_CYCLE.repeat(3))).toBe(true);
  });
});

describe("normalizeLineForRepetition", () => {
  it("lowercases and collapses punctuation to spaces", () => {
    expect(normalizeLineForRepetition("Let me fix the formatting issue:")).toBe(
      "let me fix the formatting issue",
    );
    expect(normalizeLineForRepetition("Let-me—fix the file!!")).toBe("let me fix the file");
  });

  it("is unicode-aware for Cyrillic and CJK loops", () => {
    expect(normalizeLineForRepetition("Давайте исправим ошибку:")).toBe("давайте исправим ошибку");
    expect(normalizeLineForRepetition("我来修复这个问题")).toBe("我来修复这个问题");
  });

  it("strips emoji and non-letter marks while keeping unicode letters", () => {
    expect(normalizeLineForRepetition("Let's fix it — café ☕")).toBe("let s fix it café");
  });

  it("caps the key length", () => {
    const long = "a".repeat(500);
    expect(normalizeLineForRepetition(long).length).toBeLessThanOrEqual(200);
  });
});

describe("RepetitionGuard.add", () => {
  const line = "Let me fix the formatting issue:";

  it("trips when the same normalized line repeats maxRepeatedLines times", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add(`${line}\n`)).toBe(false);
    expect(guard.add(`${line}\n`)).toBe(false);
    expect(guard.add(`${line}\n`)).toBe(false);
    expect(guard.add(`${line}\n`)).toBe(true);
    expect(guard.tripped).toBe(true);
    expect(guard.trippedLine).toBe(normalizeLineForRepetition(line));
  });

  it("does not trip below the threshold", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    guard.add(`${line}\n`);
    guard.add(`${line}\n`);
    expect(guard.add(`${line}\n`)).toBe(false);
    expect(guard.tripped).toBe(false);
  });

  it("treats cosmetic variations as the same line", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 3 });
    guard.add("Let me fix the formatting issue:\n");
    guard.add("let me FIX the formatting issue!\n");
    expect(guard.add("Let-me fix the formatting issue.\n")).toBe(true);
  });

  it("is disabled when maxRepeatedLines is 0", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 0 });
    for (let i = 0; i < 6; i += 1) {
      expect(guard.add(`${line}\n`)).toBe(false);
    }
    expect(guard.tripped).toBe(false);
  });

  it("counts lines split across streamed chunks via the pending buffer", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    // First occurrence split across two chunks.
    expect(guard.add("Let me fix the ")).toBe(false);
    expect(guard.add("formatting issue:\n")).toBe(false);
    // Second occurrence split differently.
    expect(guard.add("Let me ")).toBe(false);
    expect(guard.add("fix the formatting issue:\n")).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("does not count an unterminated fragment until flush", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    guard.add(`${line}\n`);
    expect(guard.add(line)).toBe(false); // no trailing newline yet
    expect(guard.tripped).toBe(false);
    expect(guard.flush()).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("ignores short lines under the minimum normalized length", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    // "Okay then" normalizes to "okay then" (9 chars) which is below the 10-char floor.
    for (let i = 0; i < 5; i += 1) {
      expect(guard.add("Okay then\n")).toBe(false);
    }
    expect(guard.tripped).toBe(false);
  });

  it("ignores repeated lines inside code fences", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 3 });
    guard.add("```ts\n");
    for (let i = 0; i < 5; i += 1) {
      expect(guard.add(`${line}\n`)).toBe(false);
    }
    guard.add("```\n");
    expect(guard.tripped).toBe(false);
  });

  it("tracks fence state across multiple add calls and resumes detection after", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 3 });
    guard.add("```\n");
    guard.add("some code line\n");
    guard.add("```\n");
    // Outside the fence now: repetition is detected again.
    guard.add(`${line}\n`);
    guard.add(`${line}\n`);
    expect(guard.add(`${line}\n`)).toBe(true);
  });

  it("evicts tracked lines once MAX_TRACKED_LINES is exceeded", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    for (let i = 0; i < 4096; i += 1) {
      expect(guard.add(`unique tracked line number ${i} here\n`)).toBe(false);
    }
    expect(guard.add("brand new line after eviction xx\n")).toBe(false);
    expect(guard.add("brand new line after eviction xx\n")).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("trips the Super 120B paragraph cycle from issue #7 during add without newlines", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add(ISSUE_7_SUPER_CYCLE.repeat(2))).toBe(false);
    expect(guard.add(ISSUE_7_SUPER_CYCLE)).toBe(true);
    expect(guard.tripped).toBe(true);
    expect(guard.trippedLine).toBeDefined();
  });

  it("trips the Super 120B cycle when it is split across small chunks", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    const blob = ISSUE_7_SUPER_CYCLE.repeat(3);
    let trippedAt = -1;
    for (let i = 0, chunk = 0; i < blob.length; i += 17, chunk += 1) {
      if (guard.add(blob.slice(i, i + 17))) {
        trippedAt = chunk;
        break;
      }
    }
    expect(trippedAt).toBeGreaterThanOrEqual(0);
    expect(guard.tripped).toBe(true);
  });

  it("does not trip a normal short answer or two Super 120B cycles", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(
      guard.add("Here is the refactored function. It now returns the parsed JSON payload."),
    ).toBe(false);
    expect(guard.add(ISSUE_7_SUPER_CYCLE.repeat(2))).toBe(false);
    expect(guard.tripped).toBe(false);
  });

  it("disables phrase-cycle detection when maxRepeatedLines is 0", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 0 });
    expect(guard.add(ISSUE_7_SUPER_CYCLE.repeat(8))).toBe(false);
    expect(guard.flush()).toBe(false);
    expect(guard.tripped).toBe(false);
  });

  it("trips a Super 120B paragraph when it arrives as one completed line", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add(`${ISSUE_7_SUPER_CYCLE.repeat(3)}\n`)).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("still ignores Super 120B text inside a code fence", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    guard.add("```\n");
    expect(guard.add(ISSUE_7_SUPER_CYCLE.repeat(3))).toBe(false);
    expect(guard.add(`${ISSUE_7_SUPER_CYCLE.repeat(3)}\n`)).toBe(false);
    guard.add("```\n");
    expect(guard.tripped).toBe(false);
  });

  it("stops skipping after an unclosed fence exceeds the safety cap", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    guard.add("```\n"); // fence opened but never closed
    // Push past MAX_FENCE_SKIPPED_LINES filler lines so the guard re-arms.
    for (let i = 0; i < 5001; i += 1) {
      guard.add(`filler line ${i}\n`);
    }
    expect(guard.add(`${line}\n`)).toBe(false);
    expect(guard.add(`${line}\n`)).toBe(true);
  });
});

describe("RepetitionGuard.detectHistoryLoop", () => {
  const assistant = (text: string) => ({ role: 2, content: [{ value: text }] });

  it("detects 3 consecutive identical assistant preambles", () => {
    const messages = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
    ];
    expect(RepetitionGuard.detectHistoryLoop(messages)).toBe(
      normalizeLineForRepetition("Let me fix the formatting issue:"),
    );
  });

  it("returns undefined below the repeat threshold", () => {
    const messages = [
      assistant("Let me fix the formatting issue:"),
      assistant("Let me fix the formatting issue:"),
      assistant("Something different entirely"),
    ];
    expect(RepetitionGuard.detectHistoryLoop(messages)).toBeUndefined();
  });

  it("detects unicode preambles", () => {
    const messages = [
      assistant("Давайте исправим ошибку:"),
      assistant("Давайте исправим ошибку:"),
      assistant("Давайте исправим ошибку:"),
    ];
    expect(RepetitionGuard.detectHistoryLoop(messages)).toBe(
      normalizeLineForRepetition("Давайте исправим ошибку:"),
    );
  });

  it("ignores non-assistant messages", () => {
    const messages = [
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 1, content: [{ value: "Let me fix the formatting issue:" }] },
    ];
    expect(RepetitionGuard.detectHistoryLoop(messages)).toBeUndefined();
  });

  it("accepts plain string content", () => {
    const messages = [
      { role: "assistant", content: "Let me fix the formatting issue:" },
      { role: "assistant", content: "Let me fix the formatting issue:" },
      { role: "assistant", content: "Let me fix the formatting issue:" },
    ];
    expect(RepetitionGuard.detectHistoryLoop(messages)).toBe(
      normalizeLineForRepetition("Let me fix the formatting issue:"),
    );
  });
});

describe("RepetitionGuard.detectToolCallHistoryLoop", () => {
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
    expect(RepetitionGuard.detectToolCallHistoryLoop(messages)).toBeDefined();
  });

  it("is insensitive to argument key order", () => {
    const messages = [
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { startLine: 1, filePath: "/a.ts" }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
    ];
    expect(RepetitionGuard.detectToolCallHistoryLoop(messages)).toBeDefined();
  });

  it("parses stringified arguments", () => {
    const messages = [
      toolCall("read_file", '{"filePath":"/a.ts","startLine":1}'),
      toolCall("read_file", '{"startLine":1,"filePath":"/a.ts"}'),
      toolCall("read_file", '{"filePath":"/a.ts","startLine":1}'),
    ];
    expect(RepetitionGuard.detectToolCallHistoryLoop(messages)).toBeDefined();
  });

  it("returns undefined when arguments differ", () => {
    const messages = [
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 2 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 3 }),
    ];
    expect(RepetitionGuard.detectToolCallHistoryLoop(messages)).toBeUndefined();
  });

  it("returns undefined below the repeat threshold", () => {
    const messages = [
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
      toolCall("read_file", { filePath: "/a.ts", startLine: 1 }),
    ];
    expect(RepetitionGuard.detectToolCallHistoryLoop(messages)).toBeUndefined();
  });
});
