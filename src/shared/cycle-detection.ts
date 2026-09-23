/** Trailing window scanned for repeating 6-word grams (issue #7 paragraphs). */
export const CYCLE_SCAN_CHARS = 4000;
const CYCLE_GRAM_WORDS = 6;
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
 * Returns the first 6-word gram that appears `CYCLE_MIN_REPEATS` times in a
 * trailing window of `text`. Used by the live guard (including answers with
 * newlines) and by turn-report `cycleHint`.
 */
export function detectPhraseCycle(
  text: string,
  options: { gramWords?: number; minRepeats?: number } = {},
): string | undefined {
  if (!text) {
    return undefined;
  }
  const gramWords = options.gramWords ?? CYCLE_GRAM_WORDS;
  const minRepeats = options.minRepeats ?? CYCLE_MIN_REPEATS;
  const normalized = normalizeForCycle(text);
  const window =
    normalized.length > CYCLE_SCAN_CHARS ? normalized.slice(-CYCLE_SCAN_CHARS) : normalized;
  const words = window.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < gramWords * minRepeats) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - gramWords; i += 1) {
    const gram = words.slice(i, i + gramWords).join(" ");
    if (gram.length < CYCLE_MIN_GRAM_CHARS) {
      continue;
    }
    const count = (counts.get(gram) ?? 0) + 1;
    if (count >= minRepeats) {
      return gram;
    }
    counts.set(gram, count);
  }
  return undefined;
}

const PARAGRAPH_MIN_TOKENS = 20;
const PARAGRAPH_MIN_REPEATS = 3;
const PARAGRAPH_MIN_SIMILARITY = 0.62;
const PARAGRAPH_MIN_INTERSECTION = 14;
const PARAGRAPH_TOKEN_MIN_CHARS = 4;

function intersectionSize(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

function significantWords(text: string): string[] {
  return normalizeForCycle(text)
    .split(/\s+/)
    .filter((word) => word.length >= PARAGRAPH_TOKEN_MIN_CHARS);
}

/**
 * Detects a paragraph that comes back with different wording. Exact 6-word
 * grams miss a synonym rewrite and also trip on a short tool-name phrase.
 * A block is one paragraph or a run of sentences with enough longer words.
 * A later block joins it only when they share a large slice of those words.
 */
export function detectParagraphEcho(text: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const window = text.length > CYCLE_SCAN_CHARS ? text.slice(-CYCLE_SCAN_CHARS) : text;
  const pieces = window.split(/\n\s*\n|(?<=[.!?])\s+/);
  const blocks: string[][] = [];
  let pending: string[] = [];
  const closePending = (): void => {
    const unique = [...new Set(pending)].sort();
    pending = [];
    if (unique.length >= PARAGRAPH_MIN_TOKENS) {
      blocks.push(unique);
    }
  };
  for (const piece of pieces) {
    pending.push(...significantWords(piece));
    if (new Set(pending).size >= PARAGRAPH_MIN_TOKENS) {
      closePending();
    }
  }

  const clusters: Array<{ tokens: string[]; count: number }> = [];
  for (const tokens of blocks) {
    let matched: { tokens: string[]; count: number } | undefined;
    for (const cluster of clusters) {
      const shared = intersectionSize(tokens, cluster.tokens);
      const union = tokens.length + cluster.tokens.length - shared;
      const similarity = union === 0 ? 0 : shared / union;
      if (shared >= PARAGRAPH_MIN_INTERSECTION && similarity >= PARAGRAPH_MIN_SIMILARITY) {
        matched = cluster;
        break;
      }
    }
    if (!matched) {
      clusters.push({ tokens, count: 1 });
      continue;
    }
    matched.count += 1;
    if (matched.count >= PARAGRAPH_MIN_REPEATS) {
      return matched.tokens.slice(0, 8).join(" ");
    }
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
