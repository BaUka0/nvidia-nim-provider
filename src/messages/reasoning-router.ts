import { ORPHANED_CLOSE_TAGS } from "../shared/think-tags";
import { findEarliestIndex, findTrailingPartialStartAny, splitOnTag } from "./tag-scan";
import { filterThinkTagsFromChunk, flushThinkTagFilter, ThinkTagFilterState } from "./think-filter";

function countCodeFenceParity(text: string): 0 | 1 {
  let count = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      count++;
    }
  }
  return (count % 2) as 0 | 1;
}

function findOrphanedCloseTag(text: string): { index: number; tag: string } | undefined {
  const match = findEarliestIndex(text, ORPHANED_CLOSE_TAGS);
  return match ? { index: match.index, tag: match.token } : undefined;
}

function findPartialCloseTagEnd(text: string): number {
  return findTrailingPartialStartAny(text, ORPHANED_CLOSE_TAGS);
}

export interface ReasoningStreamRouterOptions {
  reasoningIsolationExpected: boolean;
  onThinking: (text: string) => void;
  onText: (text: string) => void;
  onFirstResponse?: () => void;
}

export class ReasoningStreamRouter {
  private reasoningIsolationExpected: boolean;
  private onThinking: (text: string) => void;
  private onText: (text: string) => void;
  private onFirstResponse?: () => void;

  private seenReasoningContent = false;
  private reasoningContentFlushed = false;
  private contentStartedBeforeReasoning = false;
  private answerStarted = false;
  private reasoningBuffer = "";
  private contentBuffer = "";
  private thinkTagFilterState: ThinkTagFilterState = {
    insideThinkBlock: false,
    pendingText: "",
  };

  constructor(options: ReasoningStreamRouterOptions) {
    this.reasoningIsolationExpected = options.reasoningIsolationExpected;
    this.onThinking = options.onThinking;
    this.onText = options.onText;
    this.onFirstResponse = options.onFirstResponse;
  }

  public isAnswerStarted(): boolean {
    return this.answerStarted;
  }

  public handleReasoningContent(text: string): void {
    if (!text) {
      return;
    }
    this.onFirstResponse?.();
    if (this.contentBuffer && !this.seenReasoningContent) {
      this.emitReasoning(this.contentBuffer);
      this.contentBuffer = "";
    }
    this.seenReasoningContent = true;
    this.emitReasoning(text);
  }

  public handleContent(text: string): void {
    if (!text) {
      return;
    }
    this.onFirstResponse?.();
    if (this.seenReasoningContent && !this.reasoningContentFlushed) {
      this.flushReasoning(true);
      this.reasoningContentFlushed = true;
    }
    if (!this.seenReasoningContent) {
      this.contentStartedBeforeReasoning = true;
    }

    for (const segment of filterThinkTagsFromChunk(text, this.thinkTagFilterState)) {
      if (segment.type === "thinking") {
        if (!this.seenReasoningContent) {
          this.emitReasoning(segment.text);
        }
      } else if (this.thinkTagFilterState.closedThinkBlock) {
        this.thinkTagFilterState.closedThinkBlock = false;
        this.answerStarted = true;
        this.onText(segment.text);
      } else if (!this.reasoningIsolationExpected) {
        const closeMatch = findOrphanedCloseTag(segment.text);
        if (closeMatch) {
          const { before, after } = splitOnTag(
            segment.text,
            closeMatch.index,
            closeMatch.tag.length,
          );
          if (before) {
            this.emitReasoning(before);
          }
          this.answerStarted = true;
          if (after) {
            this.onText(after);
          }
        } else {
          this.answerStarted = true;
          this.onText(segment.text);
        }
      } else if (this.reasoningIsolationExpected && !this.answerStarted) {
        if (!this.seenReasoningContent) {
          this.bufferPossibleAnswer(segment.text);
        } else if (this.contentStartedBeforeReasoning) {
          this.emitReasoning(segment.text, true);
        } else {
          this.emitAnswerOrSplitCloseTag(segment.text);
        }
      } else {
        this.onText(segment.text);
      }
    }
  }

  public flush(): void {
    for (const segment of flushThinkTagFilter(this.thinkTagFilterState)) {
      if (segment.type === "thinking") {
        this.emitReasoning(segment.text);
      } else if (this.thinkTagFilterState.closedThinkBlock) {
        this.thinkTagFilterState.closedThinkBlock = false;
        this.answerStarted = true;
        this.onText(segment.text);
      } else if (this.reasoningIsolationExpected && !this.answerStarted) {
        if (!this.seenReasoningContent) {
          this.contentBuffer += segment.text;
        } else if (this.contentStartedBeforeReasoning) {
          this.emitReasoning(segment.text, true);
        } else {
          this.emitAnswerOrSplitCloseTag(segment.text);
        }
      } else {
        this.onText(segment.text);
      }
    }

    if (this.contentBuffer) {
      if (this.seenReasoningContent && this.contentStartedBeforeReasoning) {
        this.emitReasoning(this.contentBuffer);
      } else {
        this.onText(this.contentBuffer);
      }
      this.contentBuffer = "";
      this.answerStarted = true;
    }

    this.flushReasoning(true);
  }

  private emitAnswerOrSplitCloseTag(text: string): void {
    const closeMatch = findOrphanedCloseTag(text);
    if (closeMatch) {
      const { before, after } = splitOnTag(text, closeMatch.index, closeMatch.tag.length);
      if (before) {
        this.emitReasoning(before);
      }
      this.answerStarted = true;
      if (after) {
        this.onText(after);
      }
      return;
    }
    this.answerStarted = true;
    this.onText(text);
  }

  private bufferPossibleAnswer(text: string): void {
    this.contentBuffer += text;
    const closeMatch = findOrphanedCloseTag(this.contentBuffer);
    if (closeMatch) {
      const { before, after } = splitOnTag(
        this.contentBuffer,
        closeMatch.index,
        closeMatch.tag.length,
      );
      if (before) {
        this.emitReasoning(before);
        this.flushReasoning(true);
      }
      this.answerStarted = true;
      this.contentBuffer = "";
      if (after) {
        this.onText(after);
      }
      return;
    }
    if (this.contentBuffer.length > 150) {
      this.onText(this.contentBuffer);
      this.contentBuffer = "";
      this.answerStarted = true;
    }
  }

  private emitReasoning(text: string, checkOrphanedClose: boolean = false): void {
    if (!text) {
      return;
    }
    this.onFirstResponse?.();
    this.reasoningBuffer += text;

    if (checkOrphanedClose) {
      const closeMatch = findOrphanedCloseTag(this.reasoningBuffer);
      if (closeMatch) {
        const { before, after } = splitOnTag(
          this.reasoningBuffer,
          closeMatch.index,
          closeMatch.tag.length,
        );
        this.reasoningBuffer = before;
        this.flushReasoning(true);
        this.seenReasoningContent = true;
        this.answerStarted = true;
        if (after) {
          this.onText(after);
        }
        return;
      }

      const partialEnd = findPartialCloseTagEnd(this.reasoningBuffer);
      if (partialEnd !== -1) {
        const safePart = this.reasoningBuffer.slice(0, partialEnd);
        const partialPart = this.reasoningBuffer.slice(partialEnd);
        this.reasoningBuffer = safePart;
        this.flushReasoning(false);
        this.reasoningBuffer = partialPart;
      } else {
        this.flushReasoning(false);
      }
    } else {
      this.flushReasoning(false);
    }
  }

  private flushReasoning(force: boolean = false): void {
    if (!this.reasoningBuffer) {
      return;
    }
    if (!force && countCodeFenceParity(this.reasoningBuffer) === 1) {
      return;
    }
    let text = this.reasoningBuffer;
    if (countCodeFenceParity(text) === 1) {
      text += "\n```";
    }
    this.onThinking(text);
    this.reasoningBuffer = "";
  }
}
