/** Trailing window scanned for repeating 6-word grams (issue #7 paragraphs). */
export const CYCLE_SCAN_CHARS = 4000;
const CYCLE_GRAM_WORDS = 6;
const CYCLE_MIN_GRAM_CHARS = 20;
const CYCLE_MIN_REPEATS = 3;

export const MIN_CHAR_RUNAWAY_REPEATS = 30;
export const MIN_DIVIDER_RUNAWAY_REPEATS = 80;
const RUNAWAY_DIVIDER_CHARS = new Set(["-", "*", "_", "=", "~"]);
const MAX_PERIOD_LENGTH = 32;

/**
 * Detects runaway identical character sequences (e.g. 30+ "!").
 * Markdown horizontal dividers (---, ***, ___, ===) are tolerated up to 80 characters.
 */
export function detectCharacterRunaway(text: string): string | undefined {
  if (!text || text.length < MIN_CHAR_RUNAWAY_REPEATS) {
    return undefined;
  }
  const regex = /([^\s])\1{29,}/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const char = match[1];
    const len = match[0].length;
    if (RUNAWAY_DIVIDER_CHARS.has(char) && len < MIN_DIVIDER_RUNAWAY_REPEATS) {
      continue;
    }
    return match[0].slice(0, 40);
  }
  return undefined;
}

/**
 * Detects short periodic cycles in a trailing window of text (period 1 to 32 characters).
 */
export function detectPeriodicCycle(text: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trimEnd();
  if (trimmed.length < MIN_CHAR_RUNAWAY_REPEATS) {
    return undefined;
  }
  const window = trimmed.length > 500 ? trimmed.slice(-500) : trimmed;

  for (let period = 1; period <= MAX_PERIOD_LENGTH; period += 1) {
    if (window.length < period * 3) {
      break;
    }
    const pattern = window.slice(-period);
    if (/^\s+$/.test(pattern)) {
      continue;
    }
    let count = 0;
    let idx = window.length;
    while (idx >= period && window.slice(idx - period, idx) === pattern) {
      count += 1;
      idx -= period;
    }

    if (period === 1) {
      if (RUNAWAY_DIVIDER_CHARS.has(pattern) && count < MIN_DIVIDER_RUNAWAY_REPEATS) {
        continue;
      }
      if (count >= MIN_CHAR_RUNAWAY_REPEATS) {
        return pattern.repeat(Math.min(count, 40));
      }
    } else if (period >= 2 && period <= 4) {
      if (period * count >= 40 && count >= 5) {
        return pattern.repeat(Math.min(count, 10));
      }
    } else if (period >= 5 && period <= 16) {
      if (count >= 5 && period * count >= 50) {
        return pattern.repeat(Math.min(count, 5));
      }
    } else if (period >= 17 && period <= MAX_PERIOD_LENGTH) {
      if (count >= 4 && period * count >= 80) {
        return pattern.repeat(Math.min(count, 4));
      }
    }
  }

  return undefined;
}

/**
 * Detects degenerate runaway loops (repeating characters or short periodic patterns)
 * anywhere in text or at the trailing edge.
 */
export function detectRunawayCycle(text: string): string | undefined {
  return detectCharacterRunaway(text) ?? detectPeriodicCycle(text);
}

export function normalizeForCycle(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Returns the first 6-word gram that appears `CYCLE_MIN_REPEATS` times in a
 * trailing window of `text`. Used by the live guard (including answers with
 * newlines) and by turn-report `cycleHint`.
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

const PREFIX_CYCLE_MIN_REPEATS = 3;
const PREFIX_CYCLE_GRAM_WORDS = 2;
const PREFIX_MIN_GRAM_CHARS = 4;

/**
 * Extracts a normalized leading prefix N-gram (default 2 words) from text.
 * Unicode-aware, lowercase, punctuation collapsed. Returns empty string if
 * fewer than gramWords words are present.
 */
export function extractPrefixGram(text: string, gramWords = 2): string {
  if (!text) {
    return "";
  }
  const normalized = normalizeForCycle(text);
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < gramWords) {
    return "";
  }
  return words.slice(0, gramWords).join(" ");
}

/**
 * Detects whether 3 or more non-list lines/sentences in a text block share the
 * same leading 2-word prefix (e.g. "let me", "давайте я", "lassen sie").
 * Ignores markdown list items to prevent false positives on repetitive bullet points.
 * Language-agnostic, Unicode-aware, no hardcoded dictionaries.
 */
export function detectPrefixCycle(
  text: string,
  options: { minRepeats?: number; gramWords?: number } = {},
): string | undefined {
  if (!text) {
    return undefined;
  }
  const minRepeats = options.minRepeats ?? PREFIX_CYCLE_MIN_REPEATS;
  const gramWords = options.gramWords ?? PREFIX_CYCLE_GRAM_WORDS;

  const segments = text
    .split(/(?:\r?\n|(?<=[^\d\s][.!?])\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length < minRepeats) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const seg of segments) {
    // Markdown list items (- item, * item, 1. item) are legitimate structures and
    // must not be treated as conversational preamble loops.
    if (/^\s*([*+-]|\d+[.)])\s+/.test(seg)) {
      continue;
    }
    const prefix = extractPrefixGram(seg, gramWords);
    if (prefix.length < PREFIX_MIN_GRAM_CHARS) {
      continue;
    }
    const count = (counts.get(prefix) ?? 0) + 1;
    if (count >= minRepeats) {
      return prefix;
    }
    counts.set(prefix, count);
  }

  return undefined;
}

/** Boolean wrapper over phrase, runaway, and prefix cycle detectors for turn-report cycleHint. */
export function detectCycleHint(text: string): boolean {
  return (
    detectPhraseCycle(text) !== undefined ||
    detectRunawayCycle(text) !== undefined ||
    detectPrefixCycle(text) !== undefined
  );
}
