/** Case-insensitive tag search used by think-filter and the reasoning router. */
export function findEarliestIndex(
  text: string,
  tokens: readonly string[],
  caseSensitive = false,
): { index: number; token: string } | undefined {
  const source = caseSensitive ? text : text.toLowerCase();
  let bestIndex = -1;
  let bestToken: string | undefined;
  for (const token of tokens) {
    const needle = caseSensitive ? token : token.toLowerCase();
    const idx = source.indexOf(needle);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestToken = token;
    }
  }
  return bestToken !== undefined ? { index: bestIndex, token: bestToken } : undefined;
}

/** Start offset of a trailing partial `token` prefix, or -1. Longest match wins. */
export function findTrailingPartialStart(
  text: string,
  token: string,
  caseSensitive = false,
): number {
  const source = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? token : token.toLowerCase();
  const maxPrefixLength = Math.min(source.length, needle.length - 1);
  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (source.endsWith(needle.slice(0, prefixLength))) {
      return source.length - prefixLength;
    }
  }
  return -1;
}

/** Earliest trailing-partial start across tokens, or -1. */
export function findTrailingPartialStartAny(
  text: string,
  tokens: readonly string[],
  caseSensitive = false,
): number {
  let bestMatch = -1;
  for (const token of tokens) {
    const matchIndex = findTrailingPartialStart(text, token, caseSensitive);
    if (matchIndex !== -1 && (bestMatch === -1 || matchIndex < bestMatch)) {
      bestMatch = matchIndex;
    }
  }
  return bestMatch;
}

export function splitOnTag(
  text: string,
  index: number,
  tagLength: number,
): { before: string; after: string } {
  return {
    before: text.slice(0, index),
    after: text.slice(index + tagLength),
  };
}
