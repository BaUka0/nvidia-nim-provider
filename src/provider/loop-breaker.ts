import { NvidiaApiError } from "../api/errors";
import { NimChatMessage, NimChatRequest } from "../types";
import { debugLog, outputLog } from "../shared/logging";
import { RepetitionGuard } from "./repetition-guard";
import { cloneNimChatRequest } from "./request-snapshot";

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
  const historyLoopPreamble = RepetitionGuard.detectHistoryLoop(messages);
  const historyLoopTool = RepetitionGuard.detectToolCallHistoryLoop(messages);
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
