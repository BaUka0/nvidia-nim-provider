export interface ThinkTagFilterState {
  insideThinkBlock: boolean;
  pendingText: string;
  closeTag?: string;
  closedThinkBlock?: boolean;
}

export type ThinkFilterSegment =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

interface ThinkTagPair {
  open: string;
  close: string;
}

const THINK_TAG_PAIRS: ThinkTagPair[] = [
  { open: "<think>", close: "</think>" },
  { open: "<mm:think>", close: "</mm:think>" },
  { open: "<thought>", close: "</thought>" },
  { open: "[THINK]", close: "[/THINK]" },
  { open: "<reasoning>", close: "</reasoning>" },
];

function findTrailingCaseInsensitivePrefixStart(text: string, token: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedToken = token.toLowerCase();
  const maxPrefixLength = Math.min(normalizedText.length, normalizedToken.length - 1);

  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (normalizedText.endsWith(normalizedToken.slice(0, prefixLength))) {
      return normalizedText.length - prefixLength;
    }
  }

  return -1;
}

function findTrailingCaseInsensitivePrefixStartAny(
  text: string,
  tokens: readonly string[],
): number {
  let bestMatch = -1;

  for (const token of tokens) {
    const matchIndex = findTrailingCaseInsensitivePrefixStart(text, token);
    if (matchIndex !== -1 && (bestMatch === -1 || matchIndex < bestMatch)) {
      bestMatch = matchIndex;
    }
  }

  return bestMatch;
}

function findEarliestCaseInsensitiveIndex(
  text: string,
  tokens: readonly string[],
): { index: number; token: string } | undefined {
  let bestIndex = -1;
  let bestToken: string | undefined;

  for (const token of tokens) {
    const idx = text.toLowerCase().indexOf(token.toLowerCase());
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestToken = token;
    }
  }

  return bestToken !== undefined ? { index: bestIndex, token: bestToken } : undefined;
}

/**
 * Split a streamed chunk into ordered text/thinking segments, capturing the
 * content inside `<think>`/`<mm:think>` blocks as `thinking` segments
 * instead of discarding it. Partial tags are buffered in `state.pendingText`
 * and resolved across chunks.
 */
export function filterThinkTagsFromChunk(
  text: string,
  state: ThinkTagFilterState,
): ThinkFilterSegment[] {
  const openTags = THINK_TAG_PAIRS.map((p) => p.open);
  const closeTagMap = new Map(THINK_TAG_PAIRS.map((p) => [p.open, p.close] as const));
  let remaining = state.pendingText + text;
  const segments: ThinkFilterSegment[] = [];

  state.pendingText = "";

  while (remaining.length > 0) {
    if (state.insideThinkBlock) {
      const closeTag = state.closeTag ?? "</think>";
      const closeIndex = remaining.toLowerCase().indexOf(closeTag.toLowerCase());
      if (closeIndex === -1) {
        const partialCloseIndex = findTrailingCaseInsensitivePrefixStart(remaining, closeTag);
        if (partialCloseIndex === -1) {
          if (remaining.length > 0) {
            segments.push({ type: "thinking", text: remaining });
          }
        } else {
          if (partialCloseIndex > 0) {
            segments.push({ type: "thinking", text: remaining.slice(0, partialCloseIndex) });
          }
          state.pendingText = remaining.slice(partialCloseIndex);
        }
        return segments;
      }

      if (closeIndex > 0) {
        segments.push({ type: "thinking", text: remaining.slice(0, closeIndex) });
      }
      remaining = remaining.slice(closeIndex + closeTag.length);
      state.insideThinkBlock = false;
      state.closeTag = undefined;
      state.closedThinkBlock = true;
      continue;
    }

    const openMatch = findEarliestCaseInsensitiveIndex(remaining, openTags);
    if (openMatch === undefined) {
      const partialOpenIndex = findTrailingCaseInsensitivePrefixStartAny(remaining, openTags);
      if (partialOpenIndex === -1) {
        if (remaining.length > 0) {
          segments.push({ type: "text", text: remaining });
        }
      } else {
        if (partialOpenIndex > 0) {
          segments.push({ type: "text", text: remaining.slice(0, partialOpenIndex) });
        }
        state.pendingText = remaining.slice(partialOpenIndex);
      }
      return segments;
    }

    const { index: openIndex, token: matchedOpenTag } = openMatch;
    if (openIndex > 0) {
      segments.push({ type: "text", text: remaining.slice(0, openIndex) });
    }
    remaining = remaining.slice(openIndex + matchedOpenTag.length);
    state.insideThinkBlock = true;
    state.closeTag = closeTagMap.get(matchedOpenTag);
  }

  return segments;
}

export function flushThinkTagFilter(state: ThinkTagFilterState): ThinkFilterSegment[] {
  const segments: ThinkFilterSegment[] = [];
  if (!state.insideThinkBlock && state.pendingText) {
    segments.push({ type: "text", text: state.pendingText });
  }
  state.pendingText = "";
  state.insideThinkBlock = false;
  state.closeTag = undefined;
  return segments;
}
