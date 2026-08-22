/**
 * Detects degenerate "Let me..." style loops while an answer is streaming.
 * Lines are normalized (lowercased, punctuation collapsed) so cosmetic
 * variations of the same sentence accumulate toward the repetition limit.
 */
export interface RepetitionGuardOptions {
  readonly maxRepeatedLines: number;
}

const MIN_NORMALIZED_LINE_LENGTH = 10;

export function normalizeLineForRepetition(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export class RepetitionGuard {
  private readonly lineCounts = new Map<string, number>();
  private trippedLineValue: string | undefined;

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
   * this call crossed the configured repetition limit.
   */
  add(text: string): boolean {
    const threshold = this.threshold;
    if (threshold <= 0 || this.trippedLineValue !== undefined) {
      return false;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const key = normalizeLineForRepetition(rawLine);
      if (key.length < MIN_NORMALIZED_LINE_LENGTH) {
        continue;
      }
      const count = (this.lineCounts.get(key) ?? 0) + 1;
      this.lineCounts.set(key, count);
      if (count >= threshold) {
        this.trippedLineValue = key;
        return true;
      }
    }
    return false;
  }
}
