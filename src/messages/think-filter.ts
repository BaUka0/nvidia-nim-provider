export interface ThinkTagFilterState {
  insideThinkBlock: boolean;
  pendingText: string;
}

export type ThinkFilterSegment =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

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

/**
 * Strip `think...</think>` blocks from streamed text.
 * Some reasoning models emit chain-of-thought wrapped in these tags
 * even when a separate reasoning_content field is present.
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

/**
 * Split a streamed chunk into ordered text/thinking segments, capturing the
 * content inside `think...</think>` blocks as `thinking` segments
 * instead of discarding it. Partial tags are buffered in `state.pendingText`
 * and resolved across chunks.
 */
export function filterThinkTagsFromChunk(
  text: string,
  state: ThinkTagFilterState,
): ThinkFilterSegment[] {
  const openTag = "<think>";
  const closeTag = "</think>";
  let remaining = state.pendingText + text;
  const segments: ThinkFilterSegment[] = [];

  state.pendingText = "";

  while (remaining.length > 0) {
    if (state.insideThinkBlock) {
      const closeIndex = remaining.toLowerCase().indexOf(closeTag);
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
      continue;
    }

    const openIndex = remaining.toLowerCase().indexOf(openTag);
    if (openIndex === -1) {
      const partialOpenIndex = findTrailingCaseInsensitivePrefixStart(remaining, openTag);
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

    if (openIndex > 0) {
      segments.push({ type: "text", text: remaining.slice(0, openIndex) });
    }
    remaining = remaining.slice(openIndex + openTag.length);
    state.insideThinkBlock = true;
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
  return segments;
}
