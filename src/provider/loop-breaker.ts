import { NvidiaApiError } from "../api/errors";
import { NimChatMessage, NimChatRequest } from "../types";
import { debugLog, outputLog } from "../shared/logging";
import { LanguageModelChatMessageRole } from "vscode";
import { normalizeLineForRepetition } from "./repetition-guard";
import { replayTaskToolCalls } from "../tools/parser";
import { cloneNimChatRequest } from "./request-snapshot";
import { BoundedMap } from "../shared/bounded-map";
import { DEFAULT_TOOLS_CONFIG } from "../shared/config";
import { stripFallbackNotices } from "../messages/converter";
import { extractPrefixGram } from "../shared/cycle-detection";

const MAX_INJECTED_LOOPS_TRACKED = 128;
const recentInjectedLoops = new BoundedMap<string, number>(MAX_INJECTED_LOOPS_TRACKED);

export function resetInjectedLoopsForTests(): void {
  recentInjectedLoops.clear();
}

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
  const stripped = stripFallbackNotices(fullText);
  if (!stripped) {
    return undefined;
  }
  return stripped.split(/\r?\n/).find((l) => l.trim().length > 0) ?? stripped;
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
 * Detects an identical-call loop in the current task's history using the same
 * accounting as the stream-side guard. Returns the canonical signature of the
 * last tool call once it has run `limit` times since the last switch to another
 * tool, so the model is warned before the next identical call is dropped.
 * `limit <= 0` disables detection.
 */
export function detectToolCallHistoryLoop(
  messages: readonly { role: unknown; content: unknown }[],
  options: { limit?: number } = {},
): string | undefined {
  const limit = options.limit ?? DEFAULT_TOOLS_CONFIG.maxConsecutiveIdenticalCalls;
  if (limit <= 0) {
    return undefined;
  }
  const { lastCall } = replayTaskToolCalls(messages);
  // A single call is not a repeat, even when the cap allows only one.
  if (!lastCall || lastCall.count < 2 || lastCall.count < limit) {
    return undefined;
  }
  return lastCall.key;
}

/*
 * Breaker and nudge text goes to the model verbatim, so it carries no internal
 * tags: a bracketed marker was read by the model as part of the instruction
 * and discussed in its reasoning (#34). Injected turns live only in the HTTP
 * body and never come back in Copilot history, so repeat injection is tracked
 * in `recentInjectedLoops` instead of by scanning messages for a marker.
 */

export type LoopBreakerNudgeReason =
  | "repetition_loop"
  | "tool_call_loop"
  | "hanging_colon"
  | "output_truncated"
  | "content_filter"
  | "stream_timeout"
  | "stream_dropped"
  | "reasoning_only";

const LOOP_BREAKER_NUDGES: Record<LoopBreakerNudgeReason, string> = {
  repetition_loop:
    "Continue with the next step of your task without repeating the previous output. Call the next required tool or proceed with the implementation.",
  tool_call_loop:
    "Continue working. Use the existing findings, vary the arguments, or call a different tool to proceed with the task. Do not repeat the previous tool call.",
  hanging_colon:
    "The previous reply ended before the next action. Continue working and take that action.",
  output_truncated:
    "Your previous reply was cut off at the output token limit. Continue from where you left off. Call a tool if needed or finish the answer.",
  content_filter:
    "Your previous reply was stopped by the safety filter. Continue the answer without the blocked content. Call a tool if needed or finish the answer. Do not mention the filter.",
  stream_timeout:
    "The previous reply stalled before completing. Continue working from where you left off. Call the required tool or proceed with the task.",
  stream_dropped:
    "The connection dropped before your previous reply finished. Continue from where you left off: call the required tool or finish the answer.",
  reasoning_only:
    "Your previous reply contained only reasoning, with no answer and no tool call. Act on that reasoning now: call the next required tool, or write the final answer.",
};

const HISTORY_LOOP_ESCALATION_NUDGE =
  "The same loop is still going after the previous correction. Continue working. Change the tool or arguments, or proceed with the next step. Do not repeat the previous preamble or tool call.";

/**
 * Nudges for an attempt that streamed reasoning but no visible text. Only
 * visible text is carried into the retry, so the generic "continue from where
 * you left off" points at nothing; these hand the model its reasoning tail.
 */
const REASONING_TAIL_NUDGES: Partial<Record<LoopBreakerNudgeReason, string>> = {
  stream_timeout:
    "Your previous reply stalled while you were still reasoning, before any answer or tool call.",
  stream_dropped:
    "The connection dropped while you were still reasoning, before any answer or tool call.",
  output_truncated:
    "Your previous reply hit the output token limit while you were still reasoning, before any answer or tool call.",
  reasoning_only: "Your previous reply contained only reasoning, with no answer and no tool call.",
};

/** Retry after the reasoning guard stopped a looping think with no visible text. */
const REASONING_LOOP_NUDGE =
  "Your previous reasoning started repeating itself and was stopped. Do not go over the same points again. Call the next required tool or write the answer.";

/** Upper bound on the reasoning tail quoted back into a retry nudge. */
export const MAX_NUDGE_REASONING_TAIL_CHARS = 4000;

export interface LoopBreakerNudgeContext {
  /**
   * Reasoning the failed attempt streamed when it produced no visible text
   * and no tool call. Ignored for reasons that do not resume a stopped think.
   */
  reasoningTail?: string;
  /** The repetition guard tripped inside reasoning, before any visible text. */
  reasoningLoop?: boolean;
}

function trimReasoningTail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_NUDGE_REASONING_TAIL_CHARS) {
    return trimmed;
  }
  let tail = trimmed.slice(-MAX_NUDGE_REASONING_TAIL_CHARS);
  const code = tail.charCodeAt(0);
  if (code >= 0xdc00 && code <= 0xdfff) {
    tail = tail.slice(1);
  }
  // Start at a word boundary so the quote does not open mid-token.
  const firstSpace = tail.search(/\s/);
  if (firstSpace > 0 && firstSpace < 80) {
    tail = tail.slice(firstSpace + 1);
  }
  return `…${tail.trimStart()}`;
}

export function buildLoopBreakerNudge(
  reason: LoopBreakerNudgeReason,
  context: LoopBreakerNudgeContext = {},
): NimChatMessage {
  if (reason === "repetition_loop" && context.reasoningLoop) {
    return { role: "user", content: REASONING_LOOP_NUDGE };
  }
  const tailLead = REASONING_TAIL_NUDGES[reason];
  const tail = context.reasoningTail ? trimReasoningTail(context.reasoningTail) : "";
  if (tailLead && tail) {
    return {
      role: "user",
      content: `${tailLead} Your reasoning so far ended with:\n\n${tail}\n\nPick up from there without restarting the analysis: call the next required tool or write the answer.`,
    };
  }
  return { role: "user", content: LOOP_BREAKER_NUDGES[reason] };
}

/**
 * Chat notice for a turn that ends because the model kept asking for a call
 * the identical-call limit dropped. The count resets on a new user message,
 * so sending one lets the task continue.
 */
export function buildToolCallLoopNotice(toolName: string | undefined, limit: number): string {
  const tool = toolName ? `\`${toolName}\`` : "The same tool call";
  const times = `${limit} time${limit === 1 ? "" : "s"}`;
  return `> **NVIDIA NIM:** Stopped a repeated tool call. ${tool} already ran ${times} with the same arguments in this task, and the model kept asking for it again. Send a new message to continue.\n\n`;
}

export function buildHistoryLoopBreakerContent(
  messages: readonly { role: unknown; content: unknown }[],
  maxIdenticalToolCalls?: number,
): string | undefined {
  const historyLoopPreamble = detectHistoryLoop(messages);
  const historyLoopTool = detectToolCallHistoryLoop(messages, { limit: maxIdenticalToolCalls });
  const breakerNotices: string[] = [];
  if (historyLoopPreamble) {
    breakerNotices.push(
      `You have repeated the preamble "${historyLoopPreamble.slice(0, 80)}" multiple times. Continue with the next step of your task: invoke the required tool or proceed with the implementation without repeating the preamble.`,
    );
  }
  if (historyLoopTool) {
    breakerNotices.push(
      `You have called the same tool "${historyLoopTool.slice(0, 120)}" multiple times with identical arguments; another identical call will be dropped. Use the existing results, call a different tool, or proceed with the next step of your task.`,
    );
  }
  if (breakerNotices.length === 0) {
    return undefined;
  }
  return breakerNotices.join(" ");
}

/**
 * Inject a loop-breaker user turn when recent history is repeating.
 * First detection injects the standard nudge; a loop that persists into the
 * next request gets one escalation. Returns the original body when no loop is
 * detected, the escalation was already sent, or the extra turn would exceed
 * the token budget. Never aborts the Copilot turn.
 */
export function injectHistoryLoopBreaker(options: {
  requestBody: NimChatRequest;
  historyMessages: readonly { role: unknown; content: readonly unknown[] }[];
  modelId: string;
  applyBudget: (body: NimChatRequest) => NimChatRequest;
  /** `tools.maxConsecutiveIdenticalCalls`; defaults to the shipped setting value. */
  maxIdenticalToolCalls?: number;
}): NimChatRequest {
  const historyLoopPreamble = detectHistoryLoop(options.historyMessages);
  const historyLoopTool = detectToolCallHistoryLoop(options.historyMessages, {
    limit: options.maxIdenticalToolCalls,
  });
  const loopContent = buildHistoryLoopBreakerContent(
    options.historyMessages,
    options.maxIdenticalToolCalls,
  );
  if (!loopContent) {
    return options.requestBody;
  }

  const loopKey = historyLoopTool ?? historyLoopPreamble ?? loopContent;
  const previousInjections = recentInjectedLoops.get(loopKey) ?? 0;
  if (previousInjections >= 2) {
    return options.requestBody;
  }

  const escalate = previousInjections >= 1;
  const breakerContent = escalate ? HISTORY_LOOP_ESCALATION_NUDGE : loopContent;

  recentInjectedLoops.set(loopKey, previousInjections + 1);

  const trippedLine = historyLoopTool ?? historyLoopPreamble;
  debugLog("repetitionGuard", {
    action: escalate ? "injectBreakerEscalation" : "injectBreaker",
    model: options.modelId,
    detector:
      historyLoopTool !== undefined
        ? "toolCallLoop"
        : historyLoopPreamble !== undefined
          ? "preamble"
          : undefined,
    ...(trippedLine !== undefined ? { trippedLine } : {}),
    escalate,
  });
  outputLog(
    "repetitionGuard",
    `Detected inter-turn loop (${historyLoopTool ? "toolCallLoop" : "preamble"}) on ${options.modelId}, injecting ${escalate ? "escalation breaker" : "breaker"}`,
  );

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
