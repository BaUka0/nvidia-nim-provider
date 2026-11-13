import { LanguageModelChatMessageRole } from "vscode";
import { buildToolCallCanonicalKey } from "./canonical-key";
import { tryParseJsonValue } from "./json-args";
import { isInspectionTool } from "./tool-kinds";

interface HistoryMessage {
  readonly role: unknown;
  readonly content: unknown;
}

export interface TrackedToolCall {
  readonly name: string;
  readonly key: string;
  readonly count: number;
}

/**
 * Counts identical tool calls (same name and canonical arguments) across the
 * current task. Inspection calls accumulate per `(name, key)` even when the
 * model alternates between two inspection tools (`read_file` <-> `grep_search`),
 * while mutating or unknown tools clear prior counts for other tools so
 * legitimate `read -> mutate -> read` workflows proceed and only consecutive
 * identical calls to the same non-inspection tool trip the limit.
 */
export class IdenticalToolCallTracker {
  private lastToolName: string | undefined;
  private readonly counts = new Map<string, number>();

  private toCompositeKey(name: string, key: string): string {
    return `${name}\u0000${key}`;
  }

  private staysInCurrentGroup(name: string): boolean {
    if (this.lastToolName === undefined) {
      return true;
    }
    return isInspectionTool(name)
      ? isInspectionTool(this.lastToolName)
      : this.lastToolName === name;
  }

  /** Calls already recorded for `(name, key)` within the current uninterrupted group. */
  public countOf(name: string, key: string): number {
    if (!this.staysInCurrentGroup(name)) {
      return 0;
    }
    return this.counts.get(this.toCompositeKey(name, key)) ?? 0;
  }

  /** Records an executed call and returns its updated count. */
  public record(name: string, key: string): number {
    if (!this.staysInCurrentGroup(name)) {
      this.counts.clear();
    }
    const compositeKey = this.toCompositeKey(name, key);
    const count = (this.counts.get(compositeKey) ?? 0) + 1;
    this.counts.set(compositeKey, count);
    this.lastToolName = name;
    return count;
  }
}

/** `limit` identical calls are allowed; the next one is a loop. `limit <= 0` disables the cap. */
export function exceedsIdenticalCallLimit(count: number, limit: number): boolean {
  return limit > 0 && count > limit;
}

function isRole(role: unknown, expected: number, name: string): boolean {
  return role === expected || (typeof role === "string" && role.toLowerCase() === name);
}

/**
 * A user turn that carries typed text starts a new task. Tool-result turns and
 * data parts (cache-control breakpoints) belong to the running agent loop.
 */
function isTaskBoundary(message: HistoryMessage): boolean {
  if (!isRole(message.role, LanguageModelChatMessageRole.User, "user")) {
    return false;
  }
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((part) => {
    if (typeof part === "string") {
      return part.trim().length > 0;
    }
    if (part === null || typeof part !== "object" || "callId" in part) {
      return false;
    }
    const value = (part as { value?: unknown }).value;
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Index of the first message of the current task: the one after the last
 * typed user message, or 0 when there is none.
 */
export function findTaskStartIndex(messages: readonly HistoryMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isTaskBoundary(messages[i])) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Replays the tool calls of the current task (assistant turns after the last
 * typed user message) into a fresh tracker, so the identical-call limit spans
 * agent-loop iterations instead of resetting on every request.
 */
export function replayTaskToolCalls(messages: readonly HistoryMessage[]): {
  tracker: IdenticalToolCallTracker;
  lastCall: TrackedToolCall | undefined;
} {
  const startIndex = findTaskStartIndex(messages);
  const tracker = new IdenticalToolCallTracker();
  let lastCall: TrackedToolCall | undefined;
  for (let i = startIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      !isRole(message.role, LanguageModelChatMessageRole.Assistant, "assistant") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    for (const part of message.content) {
      if (part === null || typeof part !== "object") {
        continue;
      }
      const p = part as { name?: unknown; input?: unknown; arguments?: unknown };
      if (typeof p.name !== "string" || p.name.length === 0) {
        continue;
      }
      const rawInput = p.input ?? p.arguments;
      const input = typeof rawInput === "string" ? tryParseJsonValue(rawInput) : (rawInput ?? {});
      const key = buildToolCallCanonicalKey(p.name, input);
      lastCall = { name: p.name, key, count: tracker.record(p.name, key) };
    }
  }
  return { tracker, lastCall };
}
