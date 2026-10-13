import { chatCompletion } from "../api/client";
import { debugLog } from "../shared/logging";
import { NimChatMessage } from "../types";
import { findToolCallOwnerIndex } from "../messages/tool-call-pairing";
import { FALLBACK_MODEL_ID } from "./catalog";
import { withReasoningOff } from "./adapters";
import { estimateNimMessagesTokens, truncateMessagesForContext } from "../messages/converter";
import { DEFAULT_NETWORK_CONFIG } from "../shared/config";
import { COMPACTION_RECENT_FRACTION } from "../shared/constants";
import { FetchAttemptBudget, httpAttemptsFromConfig } from "../shared/fetch-attempt-budget";

export class SummarizationError extends Error {
  readonly kind = "summarization_failed" as const;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SummarizationError";
  }
}

const SUMMARIZATION_PROMPT = `Summarize the following conversation concisely, preserving:
- Key decisions and their rationale
- File paths, function names, and code references mentioned
- Important context about the user's intent and requirements
- Any unresolved questions or open tasks

Do not include greetings, pleasantries, or filler. Focus on technical substance.
Return only the summary, no meta-commentary.`;
const MAX_SUMMARIZATION_INPUT_CHARS = 48000;
const SUMMARIZATION_TRUNCATION_NOTICE = "[Earlier content clipped before summarization.]\n\n";
const LINE_SEPARATOR = "\n\n";

/** Last `maxChars` UTF-16 units of `text`, never starting on a lone low surrogate. */
function takeTailPreservingSurrogates(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }
  return text.slice(start);
}

function messageToSummaryLine(
  msg: NimChatMessage,
): { prefix: string; content: string } | undefined {
  const role =
    msg.role === "user"
      ? "User"
      : msg.role === "assistant"
        ? "Assistant"
        : msg.role === "tool"
          ? "Tool Result"
          : "System";
  const content =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .map((part) => {
            if (part.type === "image_url") {
              return "[image omitted from summary]";
            }
            if (part.type === "text" && typeof part.text === "string") {
              return part.text;
            }
            return JSON.stringify(part);
          })
          .join(" ");
  const metadata = [
    msg.reasoning_content ? `[reasoning]: ${msg.reasoning_content}` : "",
    msg.tool_call_id ? `[tool_call_id]: ${msg.tool_call_id}` : "",
    msg.tool_calls?.length ? `[tool_calls]: ${JSON.stringify(msg.tool_calls)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const summaryContent = [content, metadata].filter(Boolean).join(" ");
  return summaryContent.trim() ? { prefix: `[${role}]: `, content: summaryContent } : undefined;
}

/**
 * Flatten old turns for the summarizer. Over budget, the oldest content is
 * dropped first: the turns closest to the verbatim recent tail matter most.
 */
function messagesToText(messages: NimChatMessage[]): string {
  const lines = messages
    .map(messageToSummaryLine)
    .filter((line): line is { prefix: string; content: string } => line !== undefined);
  const full = lines.map((line) => line.prefix + line.content).join(LINE_SEPARATOR);
  if (full.length <= MAX_SUMMARIZATION_INPUT_CHARS) {
    return full;
  }

  const budget = MAX_SUMMARIZATION_INPUT_CHARS - SUMMARIZATION_TRUNCATION_NOTICE.length;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const separatorLength = kept.length > 0 ? LINE_SEPARATOR.length : 0;
    const { prefix, content } = lines[i];
    if (used + separatorLength + prefix.length + content.length <= budget) {
      kept.unshift(prefix + content);
      used += separatorLength + prefix.length + content.length;
      continue;
    }
    // Keep the end of the boundary message, next to the turns that follow it.
    const room = budget - used - separatorLength - prefix.length - 1;
    if (room > 0) {
      kept.unshift(`${prefix}…${takeTailPreservingSurrogates(content, room)}`);
    }
    break;
  }
  return SUMMARIZATION_TRUNCATION_NOTICE + kept.join(LINE_SEPARATOR);
}

/**
 * Summarize old conversation messages via a lightweight API call.
 * Uses dedicated summarization model from config or custom argument.
 * Falls back to simple truncation if the API call fails.
 */
export async function summarizeOldMessages(
  oldMessages: NimChatMessage[],
  apiKey: string,
  userAgent: string,
  signal?: AbortSignal,
  summarizationModel?: string,
  fetchAttemptBudget?: FetchAttemptBudget,
  maxHttpRetries?: number,
): Promise<NimChatMessage> {
  const targetModel = summarizationModel?.trim() || FALLBACK_MODEL_ID;
  const conversationText = messagesToText(oldMessages);
  try {
    debugLog(
      "summarizer",
      `Summarizing ${oldMessages.length} messages (${conversationText.length} chars) via ${targetModel}.`,
    );
    const configuredAttempts = httpAttemptsFromConfig(
      maxHttpRetries ?? DEFAULT_NETWORK_CONFIG.maxHttpRetries,
    );
    const attempts = fetchAttemptBudget
      ? fetchAttemptBudget.consume(configuredAttempts)
      : configuredAttempts;
    if (attempts <= 0) {
      throw new SummarizationError("Fetch attempt budget exhausted before summarization");
    }
    const summary = await chatCompletion(
      apiKey,
      withReasoningOff({
        model: targetModel,
        messages: [
          { role: "system", content: SUMMARIZATION_PROMPT },
          { role: "user", content: conversationText },
        ],
        max_tokens: 4096,
        temperature: 0,
      }),
      signal,
      userAgent,
      attempts,
    );
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      throw new SummarizationError("Summarization returned an empty response");
    }
    return {
      role: "system",
      content: `[Previous conversation summary]: ${trimmedSummary}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    debugLog(
      "summarizer",
      `API summarization failed on ${targetModel}, using simple truncation: ${error instanceof Error ? error.message : String(error)}`,
    );
    const truncated = truncateMessagesForContext(oldMessages, 8192);
    const truncatedText = messagesToText(truncated);
    return {
      role: "system",
      content: `[Previous conversation — truncated due to context limits]:\n${truncatedText}`,
    };
  }
}

/**
 * Split messages into "old" (to summarize) and "recent" (to keep verbatim).
 * Preserves system messages in the recent portion.
 */
export function splitMessagesForSummarization(
  messages: NimChatMessage[],
  maxRecentTokens: number,
): { oldMessages: NimChatMessage[]; recentMessages: NimChatMessage[] } {
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const recentBudget = Math.max(1, maxRecentTokens);

  let recentTokenCount = 0;
  let splitIndex = nonSystemMessages.length;

  for (let i = nonSystemMessages.length - 1; i >= 0; i -= 1) {
    const messageTokens = estimateNimMessagesTokens([nonSystemMessages[i]]);
    // The newest message always stays verbatim, even when it alone exceeds
    // the budget: summarizing it would bury the user's current request.
    const isNewest = i === nonSystemMessages.length - 1;
    if (!isNewest && recentTokenCount + messageTokens > recentBudget) {
      splitIndex = i + 1;
      break;
    }
    recentTokenCount += messageTokens;
    splitIndex = i;
  }

  // Keep at least one historical non-system message available for a summary
  // when there is enough history to split, even if the requested recent budget
  // is larger than this small test/conversation.
  if (splitIndex === 0 && nonSystemMessages.length > 1) {
    splitIndex = 1;
  }

  // A tool result is only valid when the corresponding assistant tool call is
  // present in the same request. If the token boundary lands between the two,
  // keep the owner in the recent suffix even when that exceeds the nominal
  // recent budget slightly.
  let pairAdjusted = true;
  while (pairAdjusted) {
    pairAdjusted = false;
    for (let i = splitIndex; i < nonSystemMessages.length; i += 1) {
      const message = nonSystemMessages[i];
      if (message.role !== "tool" || !message.tool_call_id) {
        continue;
      }
      const ownerIndex = findToolCallOwnerIndex(nonSystemMessages, message.tool_call_id);
      if (ownerIndex >= 0 && ownerIndex < splitIndex) {
        splitIndex = ownerIndex;
        pairAdjusted = true;
        break;
      }
    }
  }

  return {
    oldMessages: nonSystemMessages.slice(0, splitIndex),
    recentMessages: [...systemMessages, ...nonSystemMessages.slice(splitIndex)],
  };
}

export interface CompactConversationOptions {
  maxRecentTokens: number;
  apiKey: string;
  userAgent: string;
  signal?: AbortSignal;
  summarizationModel?: string;
  extraTokenCount?: number;
  fetchAttemptBudget?: FetchAttemptBudget;
  maxHttpRetries?: number;
}

/**
 * Replace older turns with a summary message while keeping recent turns and
 * system prompts verbatim. Shared by preflight compaction and overflow retry.
 */
export async function compactConversationHistory(
  messages: NimChatMessage[],
  options: CompactConversationOptions,
): Promise<{ messages: NimChatMessage[]; tokenCount: number; compacted: boolean }> {
  const extraTokenCount = options.extraTokenCount ?? 0;
  const { oldMessages, recentMessages } = splitMessagesForSummarization(
    messages,
    options.maxRecentTokens,
  );
  if (oldMessages.length === 0) {
    return {
      messages,
      tokenCount: estimateNimMessagesTokens(messages) + extraTokenCount,
      compacted: false,
    };
  }

  const summaryMessage = await summarizeOldMessages(
    oldMessages,
    options.apiKey,
    options.userAgent,
    options.signal,
    options.summarizationModel,
    options.fetchAttemptBudget,
    options.maxHttpRetries,
  );
  const recentSystemMessages = recentMessages.filter((message) => message.role === "system");
  const recentConversationMessages = recentMessages.filter((message) => message.role !== "system");
  const compacted = [...recentSystemMessages, summaryMessage, ...recentConversationMessages];
  return {
    messages: compacted,
    tokenCount: estimateNimMessagesTokens(compacted) + extraTokenCount,
    compacted: true,
  };
}

export interface CompactAndFitOptions {
  messages: NimChatMessage[];
  effectiveMaxInputTokens: number;
  toolDefinitionTokens?: number;
  allowTruncation?: boolean;
  /** Truncate to the recent-token budget when summarization did not shrink the payload. */
  forceShrink?: boolean;
  summarizationOptions: {
    apiKey: string;
    userAgent: string;
    signal?: AbortSignal;
    summarizationModel?: string;
    fetchAttemptBudget?: FetchAttemptBudget;
    maxHttpRetries?: number;
  };
}

export interface CompactAndFitResult {
  messages: NimChatMessage[];
  tokenCount: number;
  compacted: boolean;
  truncated: boolean;
  fits: boolean;
}

/** Shared compaction for preflight, hard-limit, and overflow retry. Recent-token budget subtracts tool tokens. */
export async function compactAndFit(options: CompactAndFitOptions): Promise<CompactAndFitResult> {
  const toolDefinitionTokens = options.toolDefinitionTokens ?? 0;
  const messageTokenBudget = Math.max(1, options.effectiveMaxInputTokens - toolDefinitionTokens);
  const recentTokenBudget = Math.floor(messageTokenBudget * COMPACTION_RECENT_FRACTION);

  const compactedResult = await compactConversationHistory(options.messages, {
    maxRecentTokens: recentTokenBudget,
    apiKey: options.summarizationOptions.apiKey,
    userAgent: options.summarizationOptions.userAgent,
    signal: options.summarizationOptions.signal,
    summarizationModel: options.summarizationOptions.summarizationModel,
    extraTokenCount: toolDefinitionTokens,
    fetchAttemptBudget: options.summarizationOptions.fetchAttemptBudget,
    maxHttpRetries: options.summarizationOptions.maxHttpRetries,
  });

  let currentMessages = compactedResult.messages;
  let currentTokenCount = compactedResult.tokenCount;
  let truncated = false;

  if (currentTokenCount > options.effectiveMaxInputTokens && options.allowTruncation) {
    currentMessages = truncateMessagesForContext(currentMessages, messageTokenBudget);
    currentTokenCount = estimateNimMessagesTokens(currentMessages) + toolDefinitionTokens;
    truncated = true;
  }

  if (options.forceShrink && !compactedResult.compacted && !truncated) {
    currentMessages = truncateMessagesForContext(currentMessages, Math.max(1, recentTokenBudget));
    currentTokenCount = estimateNimMessagesTokens(currentMessages) + toolDefinitionTokens;
    truncated = true;
  }

  const fits = currentTokenCount <= options.effectiveMaxInputTokens;

  return {
    messages: currentMessages,
    tokenCount: currentTokenCount,
    compacted: compactedResult.compacted,
    truncated,
    fits,
  };
}
