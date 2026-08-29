import * as vscode from "vscode";

/**
 * Detects degenerate "Let me..." style loops while an answer is streaming.
 * Lines are normalized (NFKC, lowercased, punctuation collapsed) so cosmetic
 * variations of the same sentence accumulate toward the repetition limit.
 * Run-on paragraphs without newlines are caught by a trailing 6-word-gram
 * window (the Super 120B #7 cycle). Markdown code fences are tracked and
 * ignored to avoid false positives on repetitive code generation.
 * Normalization is Unicode-aware so non-English loops (Cyrillic, CJK,
 * accented) are caught too.
 */
import { buildToolCallCanonicalKey, tryParseJsonValue } from "../tools/parser";

export interface RepetitionGuardOptions {
  readonly maxRepeatedLines: number;
}

const MIN_NORMALIZED_LINE_LENGTH = 10;
/** Cap the normalized key length so a single huge line cannot bloat the map. */
const MAX_KEY_LENGTH = 200;
/**
 * Safety valve: if more than this many lines are skipped inside a single code
 * fence, assume the fence was never closed (truncated output) and stop
 * skipping so a real loop after an unclosed fence is still detected.
 */
const MAX_FENCE_SKIPPED_LINES = 5000;
/** Bound the number of distinct lines tracked to keep memory predictable. */
const MAX_TRACKED_LINES = 4096;
/** Trailing window scanned for repeating 6-word grams (issue #7 paragraphs). */
const CYCLE_SCAN_CHARS = 4000;
const CYCLE_GRAM_WORDS = 6;
const CYCLE_MIN_GRAM_CHARS = 20;
const CYCLE_MIN_REPEATS = 3;

function normalizeForCycle(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeLineForRepetition(line: string): string {
  return normalizeForCycle(line).slice(0, MAX_KEY_LENGTH);
}

/**
 * Returns the first 6-word gram that appears `CYCLE_MIN_REPEATS` times in a
 * trailing window of `text`. Used by the live guard and by turn-report
 * `cycleHint`. Does not stop a stream by itself.
 */
export function detectPhraseCycle(text: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = normalizeForCycle(text);
  const window =
    normalized.length > CYCLE_SCAN_CHARS ? normalized.slice(-CYCLE_SCAN_CHARS) : normalized;
  const words = window.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < CYCLE_GRAM_WORDS * CYCLE_MIN_REPEATS) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - CYCLE_GRAM_WORDS; i += 1) {
    const gram = words.slice(i, i + CYCLE_GRAM_WORDS).join(" ");
    if (gram.length < CYCLE_MIN_GRAM_CHARS) {
      continue;
    }
    const count = (counts.get(gram) ?? 0) + 1;
    if (count >= CYCLE_MIN_REPEATS) {
      return gram;
    }
    counts.set(gram, count);
  }
  return undefined;
}

/** Boolean wrapper over `detectPhraseCycle` for turn-report `cycleHint`. */
export function detectCycleHint(text: string): boolean {
  return detectPhraseCycle(text) !== undefined;
}

/**
 * A markdown fence delimiter is a line that begins with ``` or ~~~ after
 * optional leading whitespace. The language tag (if any) is irrelevant here.
 */
function isCodeFenceMarker(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

export class RepetitionGuard {
  private readonly lineCounts = new Map<string, number>();
  private trippedLineValue: string | undefined;
  private inCodeFence = false;
  private fenceSkippedLines = 0;
  /** Buffers a partial line split across streamed chunks. */
  private pendingLine = "";

  constructor(private readonly options: RepetitionGuardOptions) {}

  get tripped(): boolean {
    return this.trippedLineValue !== undefined;
  }

  get trippedLine(): string | undefined {
    return this.trippedLineValue;
  }

  private get threshold(): number {
    return Math.max(0, Math.floor(this.options.maxRepeatedLines));
  }

  /**
   * Feeds streamed answer text into the counter. Returns true exactly when
   * this call crossed the configured repetition limit. Text may be split at
   * arbitrary points; completed lines are counted on newline, and unterminated
   * `pendingLine` is scanned for repeating 6-word grams so run-on paragraphs
   * still trip mid-stream.
   */
  add(text: string): boolean {
    const threshold = this.threshold;
    if (threshold <= 0 || this.trippedLineValue !== undefined || !text) {
      return false;
    }
    const combined = this.pendingLine + text;
    const parts = combined.split(/\r?\n/);
    // The last element is either "" (text ended with a newline) or an
    // unterminated fragment that must wait for more chunks.
    this.pendingLine = parts.pop() ?? "";
    for (const rawLine of parts) {
      if (this.observeLine(rawLine, threshold)) {
        return true;
      }
    }
    return this.scanPendingCycle();
  }

  /**
   * Flush any buffered partial line at stream end. Returns true if this final
   * fragment crosses the repetition limit.
   */
  flush(): boolean {
    const threshold = this.threshold;
    if (threshold <= 0 || this.trippedLineValue !== undefined) {
      return false;
    }
    const remaining = this.pendingLine;
    this.pendingLine = "";
    if (!remaining) {
      return false;
    }
    return this.observeLine(remaining, threshold);
  }

  private observeLine(rawLine: string, threshold: number): boolean {
    if (isCodeFenceMarker(rawLine)) {
      this.inCodeFence = !this.inCodeFence;
      this.fenceSkippedLines = 0;
      return false;
    }
    if (this.inCodeFence) {
      this.fenceSkippedLines += 1;
      if (this.fenceSkippedLines >= MAX_FENCE_SKIPPED_LINES) {
        // Unclosed fence: stop skipping so later loops are still caught.
        this.inCodeFence = false;
        this.fenceSkippedLines = 0;
      } else {
        return false;
      }
    }
    const key = normalizeLineForRepetition(rawLine);
    if (key.length < MIN_NORMALIZED_LINE_LENGTH) {
      return this.tripFromPhrase(rawLine);
    }
    if (this.lineCounts.size >= MAX_TRACKED_LINES && !this.lineCounts.has(key)) {
      // Predictable memory bound: reset counts rather than grow without limit.
      this.lineCounts.clear();
    }
    const count = (this.lineCounts.get(key) ?? 0) + 1;
    this.lineCounts.set(key, count);
    if (count >= threshold) {
      this.trippedLineValue = key;
      return true;
    }
    // A single huge line can itself be a run-on paragraph cycle (#7 on flush).
    return this.tripFromPhrase(rawLine);
  }

  /**
   * Scan unterminated `pendingLine` so a run-on paragraph can trip before a
   * newline (or stream end) arrives. Completed identical lines stay on the
   * line-frequency counter so `maxRepeatedLines` is not silently lowered.
   */
  private scanPendingCycle(): boolean {
    if (this.inCodeFence || this.trippedLineValue !== undefined) {
      return false;
    }
    return this.tripFromPhrase(this.pendingLine);
  }

  private tripFromPhrase(text: string): boolean {
    const gram = detectPhraseCycle(text);
    if (!gram) {
      return false;
    }
    this.trippedLineValue = gram;
    return true;
  }

  /**
   * Extract the first non-empty text line from an assistant message. Content
   * may be an array of parts ({value}/{text}) or a plain string.
   */
  private static extractAssistantFirstLine(content: unknown): string | undefined {
    let fullText = "";
    if (typeof content === "string") {
      fullText = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part == null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (typeof p.value === "string") {
          parts.push(p.value);
        } else if (typeof p.text === "string") {
          parts.push(p.text);
        }
      }
      fullText = parts.join("\n");
    }
    if (!fullText) {
      return undefined;
    }
    return fullText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? fullText;
  }

  private static isAssistantRole(role: unknown): boolean {
    return (
      role === vscode.LanguageModelChatMessageRole.Assistant ||
      role === "assistant" ||
      (typeof role === "string" && role.toLowerCase() === "assistant")
    );
  }

  /**
   * Detects inter-turn preamble loops by inspecting recent assistant messages.
   * Returns the normalized repeated preamble if a loop is detected, otherwise
   * undefined. Looks at the last `windowSize` assistant messages and checks
   * whether the same normalized first line appears `minRepeats` times
   * consecutively from the end, or `threshold` times within the window.
   */
  static detectHistoryLoop(
    messages: readonly { role: unknown; content: unknown }[],
    options: { windowSize?: number; minRepeats?: number; threshold?: number } = {},
  ): string | undefined {
    const windowSize = options.windowSize ?? 5;
    const minRepeats = options.minRepeats ?? 3;
    const threshold = options.threshold ?? 3;

    const assistantFirstLines: string[] = [];
    for (const msg of messages) {
      if (!RepetitionGuard.isAssistantRole(msg.role)) {
        continue;
      }
      const firstLine = RepetitionGuard.extractAssistantFirstLine(msg.content);
      if (firstLine !== undefined) {
        assistantFirstLines.push(firstLine);
      }
    }

    if (assistantFirstLines.length < minRepeats) {
      return undefined;
    }
    const recent = assistantFirstLines.slice(-windowSize);
    const lastNormalized = normalizeLineForRepetition(recent[recent.length - 1] ?? "");
    if (lastNormalized.length < MIN_NORMALIZED_LINE_LENGTH) {
      return undefined;
    }

    let consecutive = 1;
    for (let i = recent.length - 2; i >= 0; i -= 1) {
      if (normalizeLineForRepetition(recent[i]) === lastNormalized) {
        consecutive += 1;
      } else {
        break;
      }
      if (consecutive >= minRepeats) break;
    }
    if (consecutive >= minRepeats) {
      return lastNormalized;
    }

    let total = 0;
    for (const t of recent) {
      if (normalizeLineForRepetition(t) === lastNormalized) total += 1;
    }
    if (total >= threshold && total >= minRepeats) {
      return lastNormalized;
    }

    return undefined;
  }

  /**
   * Detects repeated identical tool calls in recent assistant history. Returns
   * a canonical (key-order-insensitive) tool-call signature when the same call
   * is emitted `minRepeats` times consecutively, otherwise undefined.
   */
  static detectToolCallHistoryLoop(
    messages: readonly { role: unknown; content: unknown }[],
    options: { windowSize?: number; minRepeats?: number } = {},
  ): string | undefined {
    const windowSize = options.windowSize ?? 6;
    const minRepeats = options.minRepeats ?? 3;

    const recentToolKeys: string[] = [];
    for (const msg of messages) {
      if (!RepetitionGuard.isAssistantRole(msg.role)) {
        continue;
      }
      const content = msg.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (part == null || typeof part !== "object") {
          continue;
        }
        const p = part as Record<string, unknown>;
        const name = typeof p.name === "string" ? p.name : undefined;
        if (!name) {
          continue;
        }
        const rawInput = p.input ?? p.arguments;
        const parsedInput =
          typeof rawInput === "string" ? tryParseJsonValue(rawInput) : (rawInput ?? {});
        recentToolKeys.push(buildToolCallCanonicalKey(name, parsedInput));
      }
    }

    if (recentToolKeys.length < minRepeats) {
      return undefined;
    }
    const recent = recentToolKeys.slice(-windowSize);
    const lastKey = recent[recent.length - 1];
    if (!lastKey) {
      return undefined;
    }
    let consecutive = 1;
    for (let i = recent.length - 2; i >= 0; i -= 1) {
      if (recent[i] === lastKey) {
        consecutive += 1;
      } else {
        break;
      }
      if (consecutive >= minRepeats) break;
    }
    if (consecutive >= minRepeats) {
      return lastKey;
    }
    return undefined;
  }
}
