/**
 * Detects degenerate "Let me..." style loops while an answer is streaming.
 * Lines are normalized (lowercased, punctuation collapsed) so cosmetic
 * variations of the same sentence accumulate toward the repetition limit.
 * Code fences are tracked and ignored to avoid false positives on repetitive code.
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

/**
 * Checks if a raw line is likely inside a markdown code fence.
 * Tracks fence state across multiple add() calls.
 */
function isCodeFenceMarker(line: string): boolean {
  return line.trim().startsWith("```");
}

export class RepetitionGuard {
  private readonly lineCounts = new Map<string, number>();
  private trippedLineValue: string | undefined;
  private inCodeFence = false;

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
      if (isCodeFenceMarker(rawLine)) {
        this.inCodeFence = !this.inCodeFence;
        continue;
      }
      if (this.inCodeFence) {
        continue;
      }
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

  /**
   * Detects inter-turn preamble loops by inspecting recent assistant messages.
   * Returns the normalized repeated preamble if a loop is detected, otherwise undefined.
   * Looks at the last `windowSize` assistant messages and checks if the same
   * normalized first line appears `minRepeats` times consecutively from the end.
   */
  static detectHistoryLoop(
    messages: readonly { role: unknown; content: unknown }[],
    options: { windowSize?: number; minRepeats?: number; threshold?: number } = {},
  ): string | undefined {
    const windowSize = options.windowSize ?? 5;
    const minRepeats = options.minRepeats ?? 3;
    const threshold = options.threshold ?? 3;

    // Extract assistant texts: VS Code roles are numeric (1=user,2=assistant,3=system)
    // Fallback: also check string roles.
    const assistantTexts: string[] = [];
    for (const msg of messages) {
      const role = (msg as { role?: unknown }).role;
      const isAssistant =
        role === 2 ||
        role === "assistant" ||
        (typeof role === "string" && role.toLowerCase() === "assistant");
      if (!isAssistant) continue;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      const parts: string[] = [];
      for (const part of content as unknown[]) {
        if (part == null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        // VS Code LanguageModelTextPart has .value
        if (typeof p.value === "string") {
          parts.push(p.value);
        } else if (typeof p.text === "string") {
          parts.push(p.text);
        }
      }
      if (parts.length === 0) continue;
      const fullText = parts.join("\n");
      // Use first non-empty line as preamble signature
      const firstLine = fullText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? fullText;
      assistantTexts.push(firstLine);
    }

    if (assistantTexts.length < minRepeats) return undefined;
    const recent = assistantTexts.slice(-windowSize);
    // Check consecutive repeats from the end
    const lastNormalized = normalizeLineForRepetition(recent[recent.length - 1] ?? "");
    if (lastNormalized.length < MIN_NORMALIZED_LINE_LENGTH) return undefined;

    let consecutive = 1;
    for (let i = recent.length - 2; i >= 0; i -= 1) {
      if (normalizeLineForRepetition(recent[i]) === lastNormalized) {
        consecutive += 1;
      } else {
        break;
      }
      if (consecutive >= minRepeats) break;
    }
    if (consecutive >= minRepeats) return lastNormalized;

    // Also check overall frequency in window (non-consecutive)
    let total = 0;
    for (const t of recent) {
      if (normalizeLineForRepetition(t) === lastNormalized) total += 1;
    }
    if (total >= threshold && total >= minRepeats) return lastNormalized;

    return undefined;
  }

  /**
   * Detects repeated identical tool calls in recent assistant history.
   * Returns the repeated tool canonical key if loop detected.
   */
  static detectToolCallHistoryLoop(
    messages: readonly { role: unknown; content: unknown }[],
    options: { windowSize?: number; minRepeats?: number } = {},
  ): string | undefined {
    const windowSize = options.windowSize ?? 6;
    const minRepeats = options.minRepeats ?? 3;
    const recentToolKeys: string[] = [];
    for (const msg of messages) {
      const role = (msg as { role?: unknown }).role;
      const isAssistant =
        role === 2 ||
        role === "assistant" ||
        (typeof role === "string" && role.toLowerCase() === "assistant");
      if (!isAssistant) continue;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content as unknown[]) {
        if (part == null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        // VS Code tool call part: has name + input or callId+name+input
        const name = typeof p.name === "string" ? p.name : undefined;
        const input = p.input ?? p.arguments;
        if (!name) continue;
        // Build a stable key: name + sorted JSON of input
        try {
          const key = `${name}:${JSON.stringify(input ?? {})}`;
          recentToolKeys.push(key);
        } catch {
          recentToolKeys.push(name);
        }
      }
    }
    if (recentToolKeys.length < minRepeats) return undefined;
    const recent = recentToolKeys.slice(-windowSize);
    const lastKey = recent[recent.length - 1];
    if (!lastKey) return undefined;
    let consecutive = 1;
    for (let i = recent.length - 2; i >= 0; i -= 1) {
      if (recent[i] === lastKey) consecutive += 1;
      else break;
      if (consecutive >= minRepeats) break;
    }
    if (consecutive >= minRepeats) return lastKey;
    return undefined;
  }
}
