import { LanguageModelChatMessageRole } from "vscode";
import { buildToolCallCanonicalKey } from "./canonical-key";
import { tryParseJsonValue } from "./json-args";

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
 * Counts identical tool calls (same name and canonical arguments). Counts run
 * until a different tool is called, so a model cycling through the same few
 * calls of one tool (read A, read B, read A, ...) still accumulates.
 */
export class IdenticalToolCallTracker {
  private toolName: string | undefined;
  private readonly counts = new Map<string, number>();

  /** Calls already recorded for `key` since the last switch to another tool. */
  public countOf(name: string, key: string): number {
    return name === this.toolName ? (this.counts.get(key) ?? 0) : 0;
  }

  /** Records an executed call and returns its count since the last tool switch. */
  public record(name: string, key: string): number {
    if (name !== this.toolName) {
      this.toolName = name;
      this.counts.clear();
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
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
 * Replays the tool calls of the current task (assistant turns after the last
 * typed user message) into a fresh tracker, so the identical-call limit spans
 * agent-loop iterations instead of resetting on every request.
 */
export function replayTaskToolCalls(messages: readonly HistoryMessage[]): {
  tracker: IdenticalToolCallTracker;
  lastCall: TrackedToolCall | undefined;
} {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isTaskBoundary(messages[i])) {
      startIndex = i + 1;
      break;
    }
  }

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
