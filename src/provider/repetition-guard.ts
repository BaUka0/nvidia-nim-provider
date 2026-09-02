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
import { detectPhraseCycle, normalizeForCycle } from "../shared/cycle-detection";

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

export function normalizeLineForRepetition(line: string): string {
  return normalizeForCycle(line).slice(0, MAX_KEY_LENGTH);
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
}
