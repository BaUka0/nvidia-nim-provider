import { THINK_TAG_PAIRS } from "../shared/think-tags";
import {
  findEarliestIndex,
  findTrailingPartialStart,
  findTrailingPartialStartAny,
} from "./tag-scan";

export interface ThinkTagFilterState {
  insideThinkBlock: boolean;
  pendingText: string;
  closeTag?: string;
  closedThinkBlock?: boolean;
}

export type ThinkFilterSegment =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

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
      const closeTag = state.closeTag ?? THINK_TAG_PAIRS[0].close;
      const closeIndex = findEarliestIndex(remaining, [closeTag])?.index ?? -1;
      if (closeIndex === -1) {
        const partialCloseIndex = findTrailingPartialStart(remaining, closeTag);
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

    const openMatch = findEarliestIndex(remaining, openTags);
    if (openMatch === undefined) {
      const partialOpenIndex = findTrailingPartialStartAny(remaining, openTags);
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
