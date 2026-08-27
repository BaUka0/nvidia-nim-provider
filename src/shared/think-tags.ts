export interface ThinkTagPair {
  open: string;
  close: string;
}

/**
 * Canonical think / reasoning wrappers recognized in streamed model output.
 * `ORPHANED_CLOSE_TAGS` is derived from this list so scanners cannot drift.
 */
export const THINK_TAG_PAIRS: readonly ThinkTagPair[] = [
  { open: "<think>", close: "</think>" },
  { open: "<mm:think>", close: "</mm:think>" },
  { open: "<thought>", close: "</thought>" },
  { open: "[THINK]", close: "[/THINK]" },
  { open: "<reasoning>", close: "</reasoning>" },
];

export const ORPHANED_CLOSE_TAGS: readonly string[] = THINK_TAG_PAIRS.map((pair) => pair.close);
