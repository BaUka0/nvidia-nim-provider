import { RepetitionGuard, normalizeLineForRepetition } from "../src/provider/repetition-guard";
import {
  detectCharacterRunaway,
  detectCycleHint,
  detectPeriodicCycle,
  detectPhraseCycle,
  detectPrefixCycle,
  detectRunawayCycle,
  extractPrefixGram,
} from "../src/shared/cycle-detection";

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

describe("extractPrefixGram", () => {
  it("extracts 2-word prefix grams in English and Unicode", () => {
    expect(extractPrefixGram("Let me first check the current browser page")).toBe("let me");
    expect(extractPrefixGram("Давайте я проверю страницу в браузере")).toBe("давайте я");
    expect(extractPrefixGram("Lassen Sie uns den Code prüfen")).toBe("lassen sie");
    expect(extractPrefixGram("  Hello   World  ")).toBe("hello world");
  });

  it("returns empty string if fewer than gramWords words are present", () => {
    expect(extractPrefixGram("")).toBe("");
    expect(extractPrefixGram("Hello")).toBe("");
  });
});

describe("detectPrefixCycle", () => {
  it("detects 3 lines sharing the same 2-word prefix", () => {
    const text = [
      "Let me check the page.",
      "Let me take a screenshot.",
      "Let me navigate to the URL.",
    ].join("\n");
    expect(detectPrefixCycle(text)).toBe("let me");
  });

  it("detects Russian prefix loops", () => {
    const text = [
      "Давайте я проверю страницу.",
      "Давайте я сделаю скриншот.",
      "Давайте я открою настройки.",
    ].join("\n");
    expect(detectPrefixCycle(text)).toBe("давайте я");
  });

  it("ignores markdown list items to prevent false positives on task lists", () => {
    const taskList = [
      "- Fix the login button",
      "- Fix the navigation bar",
      "- Fix the footer layout",
    ].join("\n");
    expect(detectPrefixCycle(taskList)).toBeUndefined();

    const numberedList = [
      "1. Add the user model",
      "2. Add the user controller",
      "3. Add the user route",
    ].join("\n");
    expect(detectPrefixCycle(numberedList)).toBeUndefined();
  });
});

describe("detectRunawayCycle", () => {
  it("detects 30+ consecutive identical characters", () => {
    expect(detectCharacterRunaway("!".repeat(30))).toBe("!".repeat(30));
    expect(detectCharacterRunaway("?".repeat(35))).toBe("?".repeat(35));
    expect(detectCharacterRunaway(".".repeat(32))).toBe(".".repeat(32));
    expect(detectCharacterRunaway("!".repeat(29))).toBeUndefined();
  });

  it("allows standard markdown and code dividers under 120 characters but catches runaway dividers", () => {
    expect(detectCharacterRunaway("-".repeat(40))).toBeUndefined();
    expect(detectCharacterRunaway("=".repeat(50))).toBeUndefined();
    expect(detectCharacterRunaway("-".repeat(85))).toBeUndefined();
    expect(detectCharacterRunaway("#".repeat(80))).toBeUndefined();
    expect(detectCharacterRunaway("/".repeat(80))).toBeUndefined();
    expect(detectCharacterRunaway("-".repeat(125))).toBeDefined();
  });

  it("does not trip periodic cycle scanner on code comment dividers or markdown tables", () => {
    // Issue #13: 75-char PEP 8 comment divider line was falsely detected as a period-2 cycle
    const pep8Comment = "# " + "-".repeat(75);
    expect(detectPeriodicCycle(pep8Comment)).toBeUndefined();
    expect(detectRunawayCycle(pep8Comment)).toBeUndefined();

    const cppDivider = "// " + "=".repeat(80);
    expect(detectPeriodicCycle(cppDivider)).toBeUndefined();
    expect(detectRunawayCycle(cppDivider)).toBeUndefined();

    const hashBanner = "#".repeat(80);
    expect(detectPeriodicCycle(hashBanner)).toBeUndefined();
    expect(detectRunawayCycle(hashBanner)).toBeUndefined();

    // Markdown table separator line
    const tableDivider = "|---|---|---|---|---|---|---|---|---|---|";
    expect(detectPeriodicCycle(tableDivider)).toBeUndefined();
    expect(detectRunawayCycle(tableDivider)).toBeUndefined();

    // Spaced divider patterns under 120 chars
    expect(detectPeriodicCycle("- ".repeat(30))).toBeUndefined();
    // Runaway spaced divider exceeding 120 chars
    expect(detectPeriodicCycle("- ".repeat(70))).toBeDefined();
  });

  it("detects short periodic pattern cycles", () => {
    expect(detectPeriodicCycle("!?".repeat(25))).toBeDefined();
    expect(detectPeriodicCycle("abc".repeat(15))).toBeDefined();
    expect(detectPeriodicCycle("short text")).toBeUndefined();
  });

  it("detects runaway cycles via detectRunawayCycle and flags cycleHint", () => {
    expect(detectRunawayCycle("!".repeat(30))).toBe("!".repeat(30));
    expect(detectRunawayCycle("!?".repeat(25))).toBeDefined();
    expect(detectCycleHint("!".repeat(30))).toBe(true);
    expect(detectCycleHint("!?".repeat(25))).toBe(true);
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

  it("does not treat self-contained single-line code blocks as multi-line fences", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 3 });
    guard.add('```console.log("single line");```\n');
    // Still outside code fence, so repeated lines trip as expected
    guard.add(`${line}\n`);
    guard.add(`${line}\n`);
    expect(guard.add(`${line}\n`)).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("evicts tracked lines once MAX_TRACKED_LINES is exceeded", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 2 });
    for (let i = 0; i < 4096; i += 1) {
      expect(guard.add(`line_${i} unique tracked content here\n`)).toBe(false);
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

  it("trips a Super 120B cycle that is split across unique lines", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    const withNewlines = ISSUE_7_SUPER_CYCLE.replace(/\. /g, ".\n").repeat(3);
    expect(guard.add(withNewlines)).toBe(true);
    expect(guard.tripped).toBe(true);
    expect(guard.trippedLine).toBeDefined();
  });

  it("trips a planning loop with newlines and no identical lines", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    const beat =
      "We'll re-read the entire file around the first 80 lines.\nBetter get the raw region again from the start of the namespace.\n";
    expect(guard.add(beat)).toBe(false);
    expect(guard.add(beat)).toBe(false);
    expect(guard.add(beat)).toBe(true);
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

  it("trips immediately on 30+ identical characters without newlines", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add("!".repeat(20))).toBe(false);
    expect(guard.tripped).toBe(false);
    expect(guard.add("!".repeat(10))).toBe(true);
    expect(guard.tripped).toBe(true);
    expect(guard.trippedLine).toContain("!");
  });

  it("trips on short periodic cycles without newlines", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add("!?".repeat(25))).toBe(true);
    expect(guard.tripped).toBe(true);
  });

  it("does not trip on comment divider lines or markdown table separators", () => {
    const guard = new RepetitionGuard({ maxRepeatedLines: 4 });
    expect(guard.add("# " + "-".repeat(75) + "\n")).toBe(false);
    expect(guard.add("# Agreements helpers\n")).toBe(false);
    expect(guard.add("# " + "-".repeat(75) + "\n")).toBe(false);
    expect(guard.add("|---|---|---|---|---|---|---|---|---|---|\n")).toBe(false);
    expect(guard.flush()).toBe(false);
    expect(guard.tripped).toBe(false);
  });
});
