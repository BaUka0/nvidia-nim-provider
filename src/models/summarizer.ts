import { chatCompletion } from "../api/client";
import { debugLog } from "../shared/logging";
import { NimChatMessage } from "../types";
import { FALLBACK_MODEL_ID } from "./catalog";
import {
  estimateNimMessagesTokens,
  truncateMessagesForContext,
  truncatePreservingSurrogates,
} from "../messages/converter";
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
const SUMMARIZATION_TRUNCATION_NOTICE = "\n[Earlier content clipped before summarization.]";

function messagesToText(messages: NimChatMessage[]): string {
  const lines: string[] = [];
  let remainingChars = MAX_SUMMARIZATION_INPUT_CHARS;
  let wasClipped = false;
  for (const [index, msg] of messages.entries()) {
    if (remainingChars <= 0) {
      wasClipped = index < messages.length;
      break;
    }
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
    if (summaryContent.trim()) {
      const prefix = `[${role}]: `;
      const availableContentChars = Math.max(0, remainingChars - prefix.length);
      if (summaryContent.length > availableContentChars) {
        wasClipped = true;
      }
      const clippedContent = truncatePreservingSurrogates(summaryContent, availableContentChars);
      lines.push(`${prefix}${clippedContent}`);
      remainingChars -= prefix.length + clippedContent.length;
    }
  }
  const result = lines.join("\n\n");
  if (!wasClipped) {
    return result;
  }
  const bodyLimit = Math.max(
    0,
    MAX_SUMMARIZATION_INPUT_CHARS - SUMMARIZATION_TRUNCATION_NOTICE.length,
  );
  return `${truncatePreservingSurrogates(result, bodyLimit)}${SUMMARIZATION_TRUNCATION_NOTICE}`;
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
      {
        model: targetModel,
        messages: [
          { role: "system", content: SUMMARIZATION_PROMPT },
          { role: "user", content: conversationText },
        ],
        max_tokens: 4096,
        temperature: 0,
      },
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
    if (recentTokenCount + messageTokens > recentBudget) {
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
      const ownerIndex = nonSystemMessages.findIndex(
        (candidate) =>
          candidate.role === "assistant" &&
          candidate.tool_calls?.some((call) => call.id === message.tool_call_id),
      );
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
