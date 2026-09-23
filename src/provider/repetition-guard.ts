/**
 * Detects degenerate "Let me..." style loops while an answer is streaming.
 * Lines are normalized (NFKC, lowercased, punctuation collapsed) so cosmetic
 * variations of the same sentence accumulate toward the repetition limit.
 * Run-on paragraphs and planning loops split across newlines are caught by a
 * trailing 6-word-gram window (the Super 120B #7 cycle). Markdown code fences
 * are tracked and ignored to avoid false positives on repetitive code generation.
 * Normalization is Unicode-aware so non-English loops (Cyrillic, CJK,
 * accented) are caught too. A one- or two-word line (a section label such as
 * "Specific Issues") only counts when it repeats back to back. A code-like
 * line outside a fence needs more consecutive copies than a prose sentence.
 */
import {
  CYCLE_SCAN_CHARS,
  detectParagraphEcho,
  detectPhraseCycle,
  detectRunawayCycle,
  normalizeForCycle,
} from "../shared/cycle-detection";

/** Which check stopped the stream. Logged so a later audit can see the cause. */
export type RepetitionDetector = "lineCounter" | "phrase" | "paragraph" | "runaway";

export interface RepetitionGuardOptions {
  readonly maxRepeatedLines: number;
  /** Exact phrase length. The visible answer keeps the 6-word default. */
  readonly phraseCycleGramWords?: number;
  /**
   * Floor for identical-line repeats. Reasoning uses this so a planning
   * sentence can appear a few times before the line counter trips.
   */
  readonly minRepeatedLines?: number;
  /** Catch a paragraph that returns with synonyms. Off for visible answers. */
  readonly detectParagraphEcho?: boolean;
}

/** Reasoning-only loosening. Visible answers keep the caller's line threshold. */
export const REASONING_REPETITION_OPTIONS = {
  phraseCycleGramWords: 12,
  minRepeatedLines: 6,
  detectParagraphEcho: true,
} as const satisfies Omit<RepetitionGuardOptions, "maxRepeatedLines">;

const MIN_NORMALIZED_LINE_LENGTH = 10;
/**
 * A normalized line of at most this many words is a section label, not a
 * sentence. "specific issues" is two words. It must not accumulate across a
 * report. Back-to-back copies still trip at the normal line threshold.
 */
const SHORT_LABEL_MAX_WORDS = 2;
/**
 * The same code line outside a fence. Higher than a prose sentence so a
 * quoted signature can show up more than once. Back-to-back copies still trip.
 */
const CODE_LINE_MIN_REPEATS = 8;
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
  if (!trimmed.startsWith("```") && !trimmed.startsWith("~~~")) {
    return false;
  }
  // If the same line opens and closes the fence (e.g. ```console.log(1);```),
  // it is a self-contained single-line block, not a multi-line fence delimiter.
  if (
    trimmed.length > 6 &&
    ((trimmed.startsWith("```") && trimmed.endsWith("```")) ||
      (trimmed.startsWith("~~~") && trimmed.endsWith("~~~")))
  ) {
    return false;
  }
  return true;
}

function wordCount(normalized: string): number {
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

/** A statement or signature quoted outside a fence, not an English sentence. */
function isCodeLikeLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.length > 400) {
    return false;
  }
  if (/[{}]|::|=>|->|\?:/.test(trimmed)) {
    return true;
  }
  return /;\s*$/.test(trimmed);
}

export class RepetitionGuard {
  private readonly lineCounts = new Map<string, number>();
  private trippedLineValue: string | undefined;
  private trippedDetectorValue: RepetitionDetector | undefined;
  /** Back-to-back copies of a short label or a code line. Blank lines do not break the run. */
  private consecutiveKey = "";
  private consecutiveCount = 0;
  private inCodeFence = false;
  private fenceSkippedLines = 0;
  /** Buffers a partial line split across streamed chunks. */
  private pendingLine = "";
  /** Trailing visible text outside code fences; same window as `cycleHint`. */
  private visibleWindow = "";
  /** Last line folded into `visibleWindow`; consecutive duplicates are skipped. */
  private lastVisibleKey = "";

  constructor(private readonly options: RepetitionGuardOptions) {}

  get tripped(): boolean {
    return this.trippedLineValue !== undefined;
  }

  get trippedLine(): string | undefined {
    return this.trippedLineValue;
  }

  get trippedDetector(): RepetitionDetector | undefined {
    return this.trippedDetectorValue;
  }

  private trip(detector: RepetitionDetector, line: string): void {
    this.trippedDetectorValue = detector;
    this.trippedLineValue = line;
  }

  /**
   * Count another copy of a short label or code line. A different non-empty
   * line starts a new run. Returns the length of the current run.
   */
  private countConsecutive(key: string): number {
    if (key === this.consecutiveKey) {
      this.consecutiveCount += 1;
    } else {
      this.consecutiveKey = key;
      this.consecutiveCount = 1;
    }
    return this.consecutiveCount;
  }

  /** A real sentence between labels ends the back-to-back run. A blank line does not. */
  private breakConsecutive(key: string): void {
    if (key.length === 0 || key === this.consecutiveKey) {
      return;
    }
    this.consecutiveKey = "";
    this.consecutiveCount = 0;
  }

  private get threshold(): number {
    const configured = Math.max(0, Math.floor(this.options.maxRepeatedLines));
    if (configured === 0) {
      return 0;
    }
    const floor = this.options.minRepeatedLines ?? configured;
    return Math.max(configured, floor);
  }

  /**
   * Feeds streamed answer text into the counter. Returns true exactly when
   * this call crossed the configured repetition limit. Text may be split at
   * arbitrary points; completed lines are counted on newline, and a trailing
   * visible window (completed lines plus `pendingLine`) is scanned for
   * repeating 6-word grams so planning loops with newlines still trip.
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
    if (!this.inCodeFence && this.tripFromRunaway(remaining)) {
      return true;
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
    if (this.tripFromRunaway(rawLine)) {
      return true;
    }
    this.appendVisible(rawLine);
    const key = normalizeLineForRepetition(rawLine);
    if (
      key.length >= MIN_NORMALIZED_LINE_LENGTH &&
      this.observeRepeatedLine(rawLine, key, threshold)
    ) {
      return true;
    }
    if (key.length < MIN_NORMALIZED_LINE_LENGTH) {
      this.breakConsecutive(key);
    }
    return this.scanVisibleCycle();
  }

  /**
   * Short labels and code lines only trip back to back. Every other line
   * accumulates across the answer, which is what catches "Let me fix…".
   */
  private observeRepeatedLine(rawLine: string, key: string, threshold: number): boolean {
    const codeLike = isCodeLikeLine(rawLine);
    const shortLabel = !codeLike && wordCount(key) <= SHORT_LABEL_MAX_WORDS;
    if (codeLike || shortLabel) {
      const limit = codeLike ? Math.max(threshold, CODE_LINE_MIN_REPEATS) : threshold;
      if (this.countConsecutive(key) >= limit) {
        this.trip("lineCounter", key);
        return true;
      }
      return false;
    }
    this.breakConsecutive(key);
    if (this.lineCounts.size >= MAX_TRACKED_LINES && !this.lineCounts.has(key)) {
      // Predictable memory bound: reset counts rather than grow without limit.
      this.lineCounts.clear();
    }
    const count = (this.lineCounts.get(key) ?? 0) + 1;
    this.lineCounts.set(key, count);
    if (count >= threshold) {
      this.trip("lineCounter", key);
      return true;
    }
    return false;
  }

  private appendVisible(rawLine: string): void {
    const key = normalizeLineForRepetition(rawLine);
    // Identical consecutive lines are owned by `maxRepeatedLines`. Folding
    // them into the phrase window would trip a 6-word line at 3 copies.
    if (key.length > 0 && key === this.lastVisibleKey) {
      return;
    }
    this.lastVisibleKey = key;
    this.visibleWindow += `${rawLine}\n`;
    if (this.visibleWindow.length > CYCLE_SCAN_CHARS) {
      this.visibleWindow = this.visibleWindow.slice(-CYCLE_SCAN_CHARS);
      const code = this.visibleWindow.charCodeAt(0);
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.visibleWindow = this.visibleWindow.slice(1);
      }
    }
  }

  /**
   * Scan completed visible text plus unterminated `pendingLine` so a planning
   * loop with newlines (or a run-on paragraph) can trip before stream end.
   * Completed identical lines stay on the line-frequency counter so
   * `maxRepeatedLines` is not silently lowered.
   */
  private scanPendingCycle(): boolean {
    return this.scanVisibleCycle();
  }

  private scanVisibleCycle(): boolean {
    if (this.inCodeFence || this.trippedLineValue !== undefined) {
      return false;
    }
    const candidate = this.visibleWindow + this.pendingLine;
    if (this.tripFromRunaway(candidate)) {
      return true;
    }
    if (this.tripFromPhrase(candidate)) {
      return true;
    }
    return this.tripFromParagraph(candidate);
  }

  private tripFromRunaway(text: string): boolean {
    const runaway = detectRunawayCycle(text);
    if (!runaway) {
      return false;
    }
    this.trip("runaway", runaway);
    return true;
  }

  private tripFromPhrase(text: string): boolean {
    const gram = detectPhraseCycle(text, {
      gramWords: this.options.phraseCycleGramWords,
    });
    if (!gram) {
      return false;
    }
    this.trip("phrase", gram);
    return true;
  }

  private tripFromParagraph(text: string): boolean {
    if (!this.options.detectParagraphEcho) {
      return false;
    }
    const echo = detectParagraphEcho(text);
    if (!echo) {
      return false;
    }
    this.trip("paragraph", echo);
    return true;
  }
}
