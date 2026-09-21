/**
 * Trailing window scanned for a repeated passage (issue #7 paragraphs).
 * The gram is 12 words, not 6: a 6-word topical clause ("since the user is
 * not available", "need to perform a deep refactoring") recurs in normal
 * reasoning without the surrounding words matching. Real loops repeat a
 * longer stretch. The planning-beat fixture normalizes to exactly 12.
 */
export const CYCLE_SCAN_CHARS = 4000;
const CYCLE_GRAM_WORDS = 12;
const CYCLE_MIN_GRAM_CHARS = 20;
const CYCLE_MIN_REPEATS = 3;

export const MIN_CHAR_RUNAWAY_REPEATS = 30;
export const MIN_DIVIDER_RUNAWAY_REPEATS = 120;
export const RUNAWAY_DIVIDER_CHARS = new Set([
  "-",
  "*",
  "_",
  "=",
  "~",
  "#",
  "/",
  "+",
  "|",
  "─",
  "═",
  "━",
]);
const MAX_PERIOD_LENGTH = 32;

/**
 * Checks if a pattern consists solely of divider/table formatting characters and/or whitespace.
 * e.g. "--", "- ", "* * ", "====", "##", "/* ", "|---|", ":---|:"
 */
export function isDividerPattern(pattern: string): boolean {
  const nonWhitespace = pattern.replace(/[\s:]+/gu, "");
  if (nonWhitespace.length === 0) {
    return false;
  }
  for (const char of nonWhitespace) {
    if (!RUNAWAY_DIVIDER_CHARS.has(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Detects runaway identical character sequences (e.g. 30+ "!").
 * Markdown and code horizontal dividers (---, ***, ___, ===, ###, ///, |---|) are tolerated up to 120 characters.
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
    // Skip composite periods (e.g. "--" when period 1 already handles "-", or "abab" when period 2 handles "ab")
    if (period >= 2 && (pattern + pattern).indexOf(pattern, 1) < pattern.length) {
      continue;
    }

    let count = 0;
    let idx = window.length;
    while (idx >= period && window.slice(idx - period, idx) === pattern) {
      count += 1;
      idx -= period;
    }

    const isDivider = isDividerPattern(pattern);
    const totalChars = period * count;

    if (period === 1) {
      if (isDivider && count < MIN_DIVIDER_RUNAWAY_REPEATS) {
        continue;
      }
      if (count >= MIN_CHAR_RUNAWAY_REPEATS) {
        return pattern.repeat(Math.min(count, 40));
      }
    } else {
      if (isDivider) {
        if (totalChars >= MIN_DIVIDER_RUNAWAY_REPEATS) {
          return pattern.repeat(Math.min(count, Math.ceil(40 / period)));
        }
        continue;
      }
      if (period >= 2 && period <= 4) {
        if (totalChars >= 40 && count >= 5) {
          return pattern.repeat(Math.min(count, 10));
        }
      } else if (period >= 5 && period <= 16) {
        if (count >= 5 && totalChars >= 50) {
          return pattern.repeat(Math.min(count, 5));
        }
      } else if (period >= 17 && period <= MAX_PERIOD_LENGTH) {
        if (count >= 4 && totalChars >= 80) {
          return pattern.repeat(Math.min(count, 4));
        }
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
 * Returns the first repeated passage (`CYCLE_GRAM_WORDS` words) that appears
 * `CYCLE_MIN_REPEATS` times in a trailing window of `text`. Used by the live
 * guard (including answers with newlines) and by turn-report `cycleHint`.
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
 * True when the line opens with a contraction (`We'll`, `Let's`).
 * `normalizeForCycle` splits the apostrophe, so the prefix gram becomes
 * `we ll` / `let s` — one word, not a repeated preamble.
 */
function leadingTokenIsContraction(segment: string): boolean {
  const first = segment.trim().split(/\s+/, 1)[0] ?? "";
  return /['’ʼ＇]/u.test(first);
}

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
 * Detects whether 3 or more non-list lines in a text block share the same leading
 * 2-word prefix (e.g. "let me", "давайте я", "lassen sie").
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
    .split(/\r?\n/)
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
    if (leadingTokenIsContraction(seg)) {
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
