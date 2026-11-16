/**
 * Live request activity for the status bar: phase, recent reasoning phrases,
 * time to first token, and generation speed. Kept free of `vscode` so the
 * phrase and rate logic is unit-testable.
 *
 * In the Copilot harness the BYOK proxy buffers the whole response, so the
 * chat shows nothing until the provider call ends; this is the only live
 * feedback the user gets there.
 */

/** Receives routed stream deltas from one provider call. */
export interface StreamActivitySink {
  /** A new HTTP attempt starts; time to first token is measured from here. */
  attemptStarted(): void;
  reasoning(text: string): void;
  answer(text: string): void;
  /** Streamed tool-call name or arguments delta. */
  toolCall(delta: string): void;
}

export type ActivityPhase = "waiting" | "thinking" | "writing" | "tool";

export interface GenerationStats {
  /** Attempt start to first reasoning, text, or tool-call delta. */
  readonly ttftMs?: number;
  /** First delta to last delta of the final attempt. */
  readonly generationMs?: number;
  readonly outputTokens?: number;
  /** True when `outputTokens` comes from the backend's `usage` report. */
  readonly outputTokensActual: boolean;
  readonly tokensPerSecond?: number;
}

const MAX_REASONING_TAIL_CHARS = 4000;
/** Below this window a rate is mostly chunk-arrival noise. */
const MIN_RATE_WINDOW_MS = 300;
const SENTENCE_END = /(?<=[.!?…。！？])\s+/u;
const ENDS_WITH_TERMINATOR = /[.!?…。！？]["')\]]?\s*$/u;
const CJK_PATTERN =
  /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/gu;

/**
 * Typical-case token count for generated text (about 4 Latin chars or 1.5 CJK
 * chars per token). Unlike `estimateTokens`, it does not overestimate on
 * purpose, so live speeds stay close to the backend's reported ones.
 */
export function approximateOutputTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  return (text.length - cjkCount) / 4 + cjkCount / 1.5;
}

function cleanLine(line: string): string {
  return (
    line
      .replace(/^\s*(?:[-*+>]|#{1,6}|\d+[.)])\s+/u, "")
      .replace(/`+/gu, "")
      // Emphasis markers only at word edges, so identifiers like
      // `NON_CHAT_MODEL_ID` and `a*b` keep their inner characters.
      .replace(/(?<![\p{L}\p{N}])(?:\*{1,3}|_{1,3}|~~)(?=\S)/gu, "")
      .replace(/(?<=\S)(?:\*{1,3}|_{1,3}|~~)(?![\p{L}\p{N}])/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/**
 * Splits reasoning text into finished phrases and the phrase still being
 * written. Lines and sentence terminators both end a phrase; Markdown list,
 * heading, and emphasis markers are dropped.
 */
export function splitReasoningPhrases(text: string): { complete: string[]; partial: string } {
  const phrases: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (line) {
      phrases.push(...line.split(SENTENCE_END).filter((sentence) => sentence.length > 0));
    }
  }
  const lastLineIsOpen = cleanLine(lines[lines.length - 1] ?? "").length > 0;
  const last = phrases.at(-1);
  const partial =
    lastLineIsOpen && last !== undefined && !ENDS_WITH_TERMINATOR.test(last)
      ? (phrases.pop() ?? "")
      : "";
  return { complete: phrases, partial };
}

// Status bar labels use the proportional UI font, so a fixed character count
// still changes width as the text changes. These are rough advance widths (em)
// for common UI sans fonts; padding with fixed-width spaces up to a target
// width keeps the item's left edge from jumping on every update.
const FIGURE_SPACE = "\u2007";
const THIN_SPACE = "\u2009";
const FIGURE_SPACE_EM = 0.55;
const THIN_SPACE_EM = 0.2;
const ELLIPSIS = "…";
const NARROW_CHARS = new Set([..."iljI|!.,:;'`"]);
const SEMI_NARROW_CHARS = new Set([...'ftr()[]{}/\\-"*']);
const WIDE_CHARS = new Set([..."mwMW@%"]);
const CJK_CHAR =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function charWidthEm(ch: string): number {
  if (ch === " ") {
    return 0.27;
  }
  if (ch === FIGURE_SPACE) {
    return FIGURE_SPACE_EM;
  }
  if (ch === THIN_SPACE) {
    return THIN_SPACE_EM;
  }
  if (ch === ELLIPSIS) {
    return 0.8;
  }
  if (NARROW_CHARS.has(ch)) {
    return 0.25;
  }
  if (SEMI_NARROW_CHARS.has(ch)) {
    return 0.35;
  }
  if (WIDE_CHARS.has(ch)) {
    return 0.82;
  }
  if (/[0-9]/u.test(ch)) {
    return 0.55;
  }
  if (CJK_CHAR.test(ch)) {
    return 1;
  }
  if (/\p{Lu}/u.test(ch)) {
    return 0.62;
  }
  return 0.52;
}

/** Approximate rendered width of `text` in em. */
export function textWidthEm(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charWidthEm(ch);
  }
  return width;
}

/**
 * Truncates (at a word boundary when one is near) and pads `text` so it
 * renders at about `widthEm` regardless of its content.
 */
export function fitToWidth(text: string, widthEm: number): string {
  let fitted = text;
  if (textWidthEm(text) > widthEm) {
    const limit = widthEm - charWidthEm(ELLIPSIS);
    const chars = [...text];
    let width = 0;
    let cut = 0;
    while (cut < chars.length && width + charWidthEm(chars[cut]!) <= limit) {
      width += charWidthEm(chars[cut]!);
      cut += 1;
    }
    let head = chars.slice(0, cut).join("");
    const lastSpace = head.lastIndexOf(" ");
    if (lastSpace > head.length * 0.6) {
      head = head.slice(0, lastSpace);
    }
    fitted = `${head.trimEnd()}${ELLIPSIS}`;
  }
  let remaining = widthEm - textWidthEm(fitted);
  const figures = Math.max(0, Math.floor(remaining / FIGURE_SPACE_EM));
  remaining -= figures * FIGURE_SPACE_EM;
  const thins = Math.max(0, Math.round(remaining / THIN_SPACE_EM));
  return fitted + FIGURE_SPACE.repeat(figures) + THIN_SPACE.repeat(thins);
}

/** Whole seconds, so a ticking timer changes only its digits. */
export function formatElapsedSeconds(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds - minutes * 60}s`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function formatRate(tokensPerSecond: number): string {
  return tokensPerSecond >= 100
    ? `${Math.round(tokensPerSecond)}`
    : tokensPerSecond.toFixed(tokensPerSecond >= 10 ? 0 : 1);
}

/** Tracks one provider call across its HTTP attempts. */
export class StreamActivityTracker implements StreamActivitySink {
  private readonly requestStartedAtMs: number;
  private attemptStartedAtMs: number;
  private firstDeltaAtMs: number | undefined;
  private lastDeltaAtMs: number | undefined;
  private approxTokens = 0;
  private reasoningTail = "";
  private currentPhase: ActivityPhase = "waiting";
  private attempts = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.requestStartedAtMs = now();
    this.attemptStartedAtMs = this.requestStartedAtMs;
  }

  public attemptStarted(): void {
    this.attempts += 1;
    this.attemptStartedAtMs = this.now();
    this.firstDeltaAtMs = undefined;
    this.lastDeltaAtMs = undefined;
    this.approxTokens = 0;
    this.reasoningTail = "";
    this.currentPhase = "waiting";
  }

  public reasoning(text: string): void {
    if (!text) {
      return;
    }
    this.markDelta(text);
    this.currentPhase = "thinking";
    this.reasoningTail += text;
    if (this.reasoningTail.length > MAX_REASONING_TAIL_CHARS) {
      this.reasoningTail = this.reasoningTail.slice(-MAX_REASONING_TAIL_CHARS);
    }
  }

  public answer(text: string): void {
    if (!text) {
      return;
    }
    this.markDelta(text);
    if (text.trim().length > 0) {
      this.currentPhase = "writing";
    }
  }

  public toolCall(delta: string): void {
    this.markDelta(delta);
    this.currentPhase = "tool";
  }

  private markDelta(text: string): void {
    const at = this.now();
    this.firstDeltaAtMs ??= at;
    this.lastDeltaAtMs = at;
    this.approxTokens += approximateOutputTokens(text);
  }

  public get phase(): ActivityPhase {
    return this.currentPhase;
  }

  public get attemptCount(): number {
    return this.attempts;
  }

  public elapsedMs(): number {
    return this.now() - this.requestStartedAtMs;
  }

  /** Time the current attempt has been waiting for its first delta. */
  public waitingMs(): number {
    return this.now() - this.attemptStartedAtMs;
  }

  public ttftMs(): number | undefined {
    return this.firstDeltaAtMs === undefined
      ? undefined
      : this.firstDeltaAtMs - this.attemptStartedAtMs;
  }

  /** Approximate output rate of the current attempt so far. */
  public liveTokensPerSecond(): number | undefined {
    if (this.firstDeltaAtMs === undefined) {
      return undefined;
    }
    const windowMs = this.now() - this.firstDeltaAtMs;
    return windowMs < MIN_RATE_WINDOW_MS ? undefined : (this.approxTokens * 1000) / windowMs;
  }

  /**
   * Phrase for the status bar text: the last finished one, which stays stable
   * while the next one streams, or the unfinished one before any finishes.
   */
  public currentPhrase(): string | undefined {
    const { complete, partial } = splitReasoningPhrases(this.reasoningTail);
    // After trimming, the tail may start mid-phrase; never show that fragment.
    const finished =
      this.reasoningTail.length >= MAX_REASONING_TAIL_CHARS ? complete.slice(1) : complete;
    return finished.at(-1) ?? (partial || undefined);
  }

  /** Final stats for the call; prefers the backend's completion token count. */
  public stats(completionTokens?: number): GenerationStats {
    const ttftMs = this.ttftMs();
    const generationMs =
      this.firstDeltaAtMs !== undefined && this.lastDeltaAtMs !== undefined
        ? this.lastDeltaAtMs - this.firstDeltaAtMs
        : undefined;
    const outputTokensActual = typeof completionTokens === "number" && completionTokens > 0;
    const outputTokens = outputTokensActual
      ? completionTokens
      : this.approxTokens > 0
        ? Math.round(this.approxTokens)
        : undefined;
    const tokensPerSecond =
      generationMs !== undefined && generationMs >= MIN_RATE_WINDOW_MS && outputTokens
        ? (outputTokens * 1000) / generationMs
        : undefined;
    return {
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...(generationMs !== undefined ? { generationMs } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      outputTokensActual,
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    };
  }
}
