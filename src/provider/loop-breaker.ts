import { NvidiaApiError } from "../api/errors";
import { NimChatMessage, NimChatRequest } from "../types";
import { debugLog, outputLog } from "../shared/logging";
import { LanguageModelChatMessageRole } from "vscode";
import { normalizeLineForRepetition } from "./repetition-guard";
import { buildToolCallCanonicalKey, tryParseJsonValue } from "../tools/parser";
import { cloneNimChatRequest } from "./request-snapshot";

const MIN_NORMALIZED_LINE_LENGTH = 10;

/** True for VS Code assistant roles (enum) and plain "assistant" strings. */
function isAssistantRole(role: unknown): boolean {
  return (
    role === LanguageModelChatMessageRole.Assistant ||
    role === "assistant" ||
    (typeof role === "string" && role.toLowerCase() === "assistant")
  );
}

/** Count how many trailing entries repeat the last one (bounded by cap). */
function countTrailingMatches(values: readonly string[], cap: number): number {
  const last = values[values.length - 1];
  let consecutive = 1;
  for (let i = values.length - 2; i >= 0; i -= 1) {
    if (values[i] !== last) {
      break;
    }
    consecutive += 1;
    if (consecutive >= cap) break;
  }
  return consecutive;
}

/** Extract the first non-empty text line from an assistant message. */
function extractAssistantFirstLine(content: unknown): string | undefined {
  let fullText = "";
  if (typeof content === "string") {
    fullText = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part == null || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (typeof p.value === "string") {
        parts.push(p.value);
      } else if (typeof p.text === "string") {
        parts.push(p.text);
      }
    }
    fullText = parts.join("\n");
  }
  if (!fullText) {
    return undefined;
  }
  return fullText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? fullText;
}

/**
 * Detects inter-turn preamble loops by inspecting recent assistant messages.
 * Returns the normalized repeated preamble if a loop is detected, otherwise
 * undefined. Looks at the last `windowSize` assistant messages and checks
 * whether the same normalized first line appears `minRepeats` times
 * consecutively from the end, or `threshold` times within the window.
 */
export function detectHistoryLoop(
  messages: readonly { role: unknown; content: unknown }[],
  options: { windowSize?: number; minRepeats?: number; threshold?: number } = {},
): string | undefined {
  const windowSize = options.windowSize ?? 5;
  const minRepeats = options.minRepeats ?? 3;
  const threshold = options.threshold ?? 3;

  const assistantFirstLines: string[] = [];
  for (const msg of messages) {
    if (!isAssistantRole(msg.role)) {
      continue;
    }
    const firstLine = extractAssistantFirstLine(msg.content);
    if (firstLine !== undefined) {
      assistantFirstLines.push(firstLine);
    }
  }

  if (assistantFirstLines.length < minRepeats) {
    return undefined;
  }
  const recent = assistantFirstLines.slice(-windowSize).map(normalizeLineForRepetition);
  const lastNormalized = recent[recent.length - 1] ?? "";
  if (lastNormalized.length < MIN_NORMALIZED_LINE_LENGTH) {
    return undefined;
  }

  if (countTrailingMatches(recent, minRepeats) >= minRepeats) {
    return lastNormalized;
  }
  const total = recent.filter((t) => t === lastNormalized).length;
  if (total >= threshold && total >= minRepeats) {
    return lastNormalized;
  }
  return undefined;
}

/**
 * Detects repeated identical tool calls in recent assistant history. Returns
 * a canonical (key-order-insensitive) tool-call signature when the same call
 * is emitted `minRepeats` times consecutively, otherwise undefined.
 */
export function detectToolCallHistoryLoop(
  messages: readonly { role: unknown; content: unknown }[],
  options: { windowSize?: number; minRepeats?: number } = {},
): string | undefined {
  const windowSize = options.windowSize ?? 6;
  const minRepeats = options.minRepeats ?? 3;

  const recentToolKeys: string[] = [];
  for (const msg of messages) {
    if (!isAssistantRole(msg.role)) {
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part == null || typeof part !== "object") {
        continue;
      }
      const p = part as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : undefined;
      if (!name) {
        continue;
      }
      const rawInput = p.input ?? p.arguments;
      const parsedInput =
        typeof rawInput === "string" ? tryParseJsonValue(rawInput) : (rawInput ?? {});
      recentToolKeys.push(buildToolCallCanonicalKey(name, parsedInput));
    }
  }

  if (recentToolKeys.length < minRepeats) {
    return undefined;
  }
  const recent = recentToolKeys.slice(-windowSize);
  if (countTrailingMatches(recent, minRepeats) >= minRepeats) {
    return recent[recent.length - 1];
  }
  return undefined;
}

/**
 * Stable marker embedded in inter-turn loop-breaker messages so duplicate
 * injection can be detected exactly (a fragile substring prefix would both
 * false-positive on natural text and miss previously injected breakers).
 */
export const LOOP_BREAKER_MARKER = "[NIM_LOOP_BREAKER]";

/** Return the textual content of a message part, if any. */
function partTextValue(part: unknown): string | undefined {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object") {
    const p = part as { value?: unknown; text?: unknown };
    if (typeof p.value === "string") return p.value;
    if (typeof p.text === "string") return p.text;
  }
  return undefined;
}

/** True when a loop-breaker message is already present in the request or history. */
export function hasLoopBreaker(
  requestMessages: readonly { role: string; content: unknown }[],
  historyMessages: readonly { content: readonly unknown[] }[],
): boolean {
  for (const m of requestMessages) {
    if (typeof m.content === "string" && m.content.includes(LOOP_BREAKER_MARKER)) {
      return true;
    }
  }
  for (const m of historyMessages) {
    for (const part of m.content) {
      const text = partTextValue(part);
      if (text && text.includes(LOOP_BREAKER_MARKER)) {
        return true;
      }
    }
  }
  return false;
}

export function buildHistoryLoopBreakerContent(
  messages: readonly { role: unknown; content: unknown }[],
): string | undefined {
  const historyLoopPreamble = detectHistoryLoop(messages);
  const historyLoopTool = detectToolCallHistoryLoop(messages);
  const breakerNotices: string[] = [];
  if (historyLoopPreamble) {
    breakerNotices.push(
      `You have repeated the same preamble "${historyLoopPreamble.slice(0, 80)}" multiple times without calling a tool or making progress. Stop repeating the preamble. Directly invoke the required tool with correct arguments, or provide the final answer without a preamble. Do not start your response with "Let me fix" or "Let me run" again.`,
    );
  }
  if (historyLoopTool) {
    breakerNotices.push(
      `You have called the same tool "${historyLoopTool.slice(0, 120)}" multiple times consecutively with identical arguments without progress. Vary the arguments (e.g. a different file range or query) or stop and summarize the result instead of looping.`,
    );
  }
  if (breakerNotices.length === 0) {
    return undefined;
  }
  return `${LOOP_BREAKER_MARKER} ${breakerNotices.join(" ")}`;
}

/**
 * Inject a one-shot loop-breaker user turn when recent history is repeating.
 * Returns the original body when no loop is detected, the breaker is already
 * present, or the extra turn would exceed the token budget.
 */
export function injectHistoryLoopBreaker(options: {
  requestBody: NimChatRequest;
  historyMessages: readonly { role: unknown; content: readonly unknown[] }[];
  modelId: string;
  applyBudget: (body: NimChatRequest) => NimChatRequest;
}): NimChatRequest {
  const breakerContent = buildHistoryLoopBreakerContent(options.historyMessages);
  if (!breakerContent) {
    return options.requestBody;
  }

  if (hasLoopBreaker(options.requestBody.messages, options.historyMessages)) {
    return options.requestBody;
  }

  debugLog("repetitionGuard", { action: "injectBreaker" });
  outputLog("repetitionGuard", `Detected inter-turn loop on ${options.modelId}, injecting breaker`);

  // Injected as a user turn (not a trailing system message) because some
  // OpenAI-compatible backends reject or down-weight trailing system turns.
  const breakerTurn: NimChatMessage = {
    role: "user",
    content: breakerContent,
  };
  const bodyWithBreaker: NimChatRequest = {
    ...options.requestBody,
    messages: [...options.requestBody.messages, breakerTurn],
  };
  try {
    return options.applyBudget(bodyWithBreaker);
  } catch (error) {
    if (error instanceof NvidiaApiError && error.kind === "token_limit") {
      debugLog("repetitionGuard", "breaker dropped: context budget exceeded");
      return cloneNimChatRequest(options.requestBody);
    }
    throw error;
  }
}
