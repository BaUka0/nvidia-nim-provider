import { chatCompletion } from "../api/client";
import { debugLog } from "../shared/logging";
import { NimChatMessage } from "../types";
import { FALLBACK_MODEL_ID } from "./catalog";
import {
  estimateNimMessagesTokens,
  truncateMessagesForContext,
  truncatePreservingSurrogates,
} from "../messages/converter";
import { ConfigManager } from "../shared/config";

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
): Promise<NimChatMessage> {
  const targetModel =
    summarizationModel?.trim() ||
    ConfigManager.getContextConfig().summarizationModel ||
    FALLBACK_MODEL_ID;
  const conversationText = messagesToText(oldMessages);
  try {
    debugLog(
      "summarizer",
      `Summarizing ${oldMessages.length} messages (${conversationText.length} chars) via ${targetModel}.`,
    );
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
    );
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      throw new Error("Summarization returned an empty response");
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
