import { LanguageModelChatMessageRole } from "vscode";
import { NvidiaApiError } from "../api/errors";
import { stripFallbackNotices } from "../messages/converter";
import { extractPrefixGram } from "../shared/cycle-detection";
import { debugLog, outputLog } from "../shared/logging";
import { buildToolCallCanonicalKey, tryParseJsonValue } from "../tools/parser";
import { NimChatMessage, NimChatRequest } from "../types";
import { normalizeLineForRepetition } from "./repetition-guard";
import { cloneNimChatRequest } from "./request-snapshot";

export type LoopBreakerNudgeReason =
  | "repetition_loop"
  | "tool_call_loop"
  | "output_truncated"
  | "content_filter"
  | "stream_timeout";

const LOOP_BREAKER_NUDGES: Record<LoopBreakerNudgeReason, string> = {
  repetition_loop:
    "Continue working without repeating the previous output. Directly call the required tool or provide the final answer.",
  tool_call_loop:
    "Continue working. Vary the arguments, call a different tool, or provide the final answer. Do not repeat the previous tool call.",
  output_truncated:
    "Your previous reply was cut off at the output token limit. Continue from where you left off. Call a tool if needed or finish the answer.",
  content_filter:
    "Your previous reply was stopped by the safety filter. Continue the answer without the blocked content. Call a tool if needed or finish the answer. Do not mention the filter.",
  stream_timeout:
    "The previous reply stalled before completing. Continue working from where you left off. Call a tool if needed or provide the final answer.",
};

/**
 * Builds a clean, neutral continuation nudge for a mid-stream retry attempt.
 */
export function buildLoopBreakerNudge(reason: LoopBreakerNudgeReason): NimChatMessage {
  return { role: "user", content: LOOP_BREAKER_NUDGES[reason] };
}

const MIN_NORMALIZED_LINE_LENGTH = 10;

/** True for VS Code assistant roles (enum/number) and plain "assistant" strings. */
function isAssistantRole(role: unknown): boolean {
  return (
    role === LanguageModelChatMessageRole.Assistant ||
    role === 2 ||
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
  const stripped = stripFallbackNotices(fullText);
  if (!stripped) {
    return undefined;
  }
  return stripped.split(/\r?\n/).find((l) => l.trim().length > 0) ?? stripped;
}

/**
 * Detects inter-turn preamble loops by inspecting recent assistant messages.
 * Returns the normalized repeated preamble or leading prefix if a loop is detected.
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

  // 1. Exact full-line match check
  if (lastNormalized.length >= MIN_NORMALIZED_LINE_LENGTH) {
    if (countTrailingMatches(recent, minRepeats) >= minRepeats) {
      return lastNormalized;
    }
    const total = recent.filter((t) => t === lastNormalized).length;
    if (total >= threshold && total >= minRepeats) {
      return lastNormalized;
    }
  }

  // 2. Leading prefix N-gram check across assistant turns (e.g. "let me", "давайте я")
  const recentPrefixes = recent.map((l) => extractPrefixGram(l, 2));
  const lastPrefix = recentPrefixes[recentPrefixes.length - 1] ?? "";
  if (lastPrefix.length >= 4) {
    if (countTrailingMatches(recentPrefixes, minRepeats) >= minRepeats) {
      return lastPrefix;
    }
    const prefixTotal = recentPrefixes.filter((p) => p === lastPrefix).length;
    if (prefixTotal >= threshold && prefixTotal >= minRepeats) {
      return lastPrefix;
    }
  }

  return undefined;
}

/**
 * Detects repeated identical tool calls in recent assistant history.
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
    if (!Array.isArray(msg.content)) {
      continue;
    }
    for (const part of msg.content) {
      if (!part || typeof part !== "object") {
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

export function buildHistoryLoopBreakerContent(
  messages: readonly { role: unknown; content: unknown }[],
): string | undefined {
  const historyLoopPreamble = detectHistoryLoop(messages);
  const historyLoopTool = detectToolCallHistoryLoop(messages);
  const breakerNotices: string[] = [];
  if (historyLoopPreamble) {
    breakerNotices.push(
      `You have repeated the preamble "${historyLoopPreamble.slice(0, 80)}" multiple times. Directly invoke the required tool or provide the final answer immediately without repeating the preamble.`,
    );
  }
  if (historyLoopTool) {
    breakerNotices.push(
      `You have called the same tool "${historyLoopTool.slice(0, 120)}" multiple times consecutively with identical arguments. Vary the arguments, call a different tool, or provide the final answer.`,
    );
  }
  if (breakerNotices.length === 0) {
    return undefined;
  }
  return breakerNotices.join(" ");
}

/**
 * Injects a neutral history loop-breaker user turn when recent history is repeating.
 */
export function injectHistoryLoopBreaker(options: {
  requestBody: NimChatRequest;
  historyMessages: readonly { role: unknown; content: unknown }[];
  modelId: string;
  applyBudget: (body: NimChatRequest) => NimChatRequest;
}): NimChatRequest {
  const breakerContent = buildHistoryLoopBreakerContent(options.historyMessages);
  if (!breakerContent) {
    return options.requestBody;
  }

  // Prevent duplicate injection if the last message is already a user message with the breaker notice
  const lastMsg = options.requestBody.messages[options.requestBody.messages.length - 1];
  if (
    lastMsg &&
    lastMsg.role === "user" &&
    typeof lastMsg.content === "string" &&
    lastMsg.content.includes(breakerContent)
  ) {
    return options.requestBody;
  }

  debugLog("repetitionGuard", { action: "injectHistoryBreaker", modelId: options.modelId });
  outputLog(
    "repetitionGuard",
    `Detected inter-turn loop on ${options.modelId}, injecting history breaker`,
  );

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
