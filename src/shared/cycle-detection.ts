/** Trailing window scanned for repeating 6-word grams (issue #7 paragraphs). */
const CYCLE_SCAN_CHARS = 4000;
const CYCLE_GRAM_WORDS = 6;
const CYCLE_MIN_GRAM_CHARS = 20;
const CYCLE_MIN_REPEATS = 3;

export function normalizeForCycle(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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
