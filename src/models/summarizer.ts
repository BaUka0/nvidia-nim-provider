import { chatCompletion } from "../api/client";
import { debugLog } from "../shared/logging";
import { NimChatMessage } from "../types";
import { FALLBACK_MODEL_ID } from "./catalog";
import { truncateMessagesForContext } from "../messages/converter";

const SUMMARIZATION_PROMPT = `Summarize the following conversation concisely, preserving:
- Key decisions and their rationale
- File paths, function names, and code references mentioned
- Important context about the user's intent and requirements
- Any unresolved questions or open tasks

Do not include greetings, pleasantries, or filler. Focus on technical substance.
Return only the summary, no meta-commentary.`;

function messagesToText(messages: NimChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role =
      msg.role === "user"
        ? "User"
        : msg.role === "assistant"
          ? "Assistant"
          : msg.role === "tool"
            ? "Tool Result"
            : "System";
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (content.trim()) {
      lines.push(`[${role}]: ${content}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * Summarize old conversation messages via a lightweight API call.
 * Falls back to simple truncation if the API call fails.
 */
export async function summarizeOldMessages(
  oldMessages: NimChatMessage[],
  apiKey: string,
  userAgent: string,
  signal?: AbortSignal,
): Promise<NimChatMessage> {
  const conversationText = messagesToText(oldMessages);
  try {
    debugLog(
      "summarizer",
      `Summarizing ${oldMessages.length} messages (${conversationText.length} chars) via ${FALLBACK_MODEL_ID}.`,
    );
    const summary = await chatCompletion(
      apiKey,
      {
        model: FALLBACK_MODEL_ID,
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
    return {
      role: "system",
      content: `[Previous conversation summary]: ${summary.trim()}`,
    };
  } catch (error) {
    debugLog(
      "summarizer",
      `API summarization failed, using simple truncation: ${error instanceof Error ? error.message : String(error)}`,
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
  const estimatedTokensPerChar = 0.3;
  const maxRecentChars = maxRecentTokens / estimatedTokensPerChar;

  let recentCharCount = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const msgChars = content.length;

    if (msg.role === "system") {
      continue;
    }

    if (recentCharCount + msgChars > maxRecentChars) {
      splitIndex = i + 1;
      break;
    }
    recentCharCount += msgChars;
    splitIndex = i;
  }

  if (splitIndex <= 0) {
    splitIndex = 1;
  }

  return {
    oldMessages: messages.slice(0, splitIndex),
    recentMessages: messages.slice(splitIndex),
  };
}
