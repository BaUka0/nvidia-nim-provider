import * as vscode from "vscode";
import { NimChatMessage, NimTool } from "../types";
import {
  LegacyPart,
  extractImageData,
  getDataPartTextValue,
  getTextPartValue,
  getToolCallInfo,
  getToolResultTexts,
} from "./parts";

export function estimateTokens(text: string): number {
  const cjkPattern =
    /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/g;
  const cjkMatches = text.match(cjkPattern);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  // CJK: ~1.5 chars/token → use 1.2 for conservative overestimate
  // Latin/digits/symbols: ~4 chars/token → use 3 for conservative overestimate
  // This improves context utilization while still keeping a safety margin.
  return Math.ceil(cjkCount / 1.2 + otherCount / 3);
}

/**
 * Estimate the token cost of a single message content part.
 *
 * Handles all part types VS Code passes in a heterogeneous `content` array:
 * {@link vscode.LanguageModelTextPart}, text-mime {@link vscode.LanguageModelDataPart},
 * {@link vscode.LanguageModelToolResultPart} (including structured/JSON/binary inner
 * content), and {@link vscode.LanguageModelToolCallPart}. Non-textable parts (images,
 * raw binary) use a size-aware heuristic. This is what VS Code calls to render the
 * context-window token breakdown, so under-counting any part type makes the breakdown
 * disappear for tool-heavy conversations.
 */
export function estimatePartTokens(part: vscode.LanguageModelInputPart | LegacyPart): number {
  // Tool call: assistant requesting a tool invocation.
  const toolCallInfo = getToolCallInfo(part);
  if (toolCallInfo) {
    const nameTokens = toolCallInfo.name ? estimateTokens(toolCallInfo.name) : 0;
    const argsTokens = toolCallInfo.args ? estimateTokens(JSON.stringify(toolCallInfo.args)) : 0;
    return nameTokens + argsTokens;
  }

  // Tool result: the outcome of a previous tool call. Its inner content array may hold
  // text parts, structured objects, JSON data parts, etc. Extract every textable piece.
  const toolResultPart = part as { callId?: unknown; content?: unknown[] };
  if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
    const texts = getToolResultTexts(part);
    const joined = texts.join("\n").trim();
    return joined ? estimateTokens(joined) : 2;
  }

  // Text part or text-decodable data part.
  const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
  if (tv !== undefined) {
    return estimateTokens(tv);
  }

  // Image / binary data part: size-aware heuristic (~750 bytes per token).
  const img = extractImageData(part);
  if (img) {
    return Math.max(4, Math.ceil(img.data.length / 750));
  }

  // Unknown part: rough placeholder so it still contributes to the breakdown.
  return 2;
}

/**
 * Estimate the token cost of a single chat message by summing its content parts.
 */
export function estimateMessageTokens(msg: {
  content: (vscode.LanguageModelInputPart | LegacyPart)[];
}): number {
  let total = 0;
  for (const part of msg.content) {
    total += estimatePartTokens(part);
  }
  return total;
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m);
  }
  return total;
}

export function estimateToolsTokens(tools: readonly NimTool[]): number {
  let total = 0;
  for (const tool of tools) {
    const name = tool.function.name;
    const description = tool.function.description ?? "";
    const params = JSON.stringify(tool.function.parameters ?? {});
    total += estimateTokens(name) + estimateTokens(description) + estimateTokens(params);
  }
  return total;
}

/**
 * Estimate token count for converted NimChatMessage[] (post-conversion).
 */
export function estimateNimMessagesTokens(messages: NimChatMessage[]): number {
  const breakdown = estimateNimMessagesTokensByCategory(messages);
  return (
    breakdown.system +
    breakdown.user +
    breakdown.assistant +
    breakdown.toolCalls +
    breakdown.toolResults +
    breakdown.images
  );
}

export interface NimTokenCategoryBreakdown {
  system: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  images: number;
}

function estimateImageUrlTokens(url: string): number {
  if (url.startsWith("data:")) {
    const separatorIndex = url.indexOf(",");
    if (separatorIndex !== -1) {
      const payload = url.slice(separatorIndex + 1).replace(/\s/g, "");
      const isBase64 = url.slice(0, separatorIndex).toLowerCase().includes(";base64");
      const byteEstimate = isBase64 ? Math.ceil((payload.length * 3) / 4) : payload.length;
      return Math.max(4, Math.ceil(byteEstimate / 750));
    }
  }
  return Math.max(4, estimateTokens(url));
}

/**
 * Estimate categories from the exact converted payload sent to NIM. These
 * values remain estimates because the tokenizer is model-specific, but they
 * include tool calls, tool results, reasoning content, and image payloads.
 */
export function estimateNimMessagesTokensByCategory(
  messages: readonly NimChatMessage[],
): NimTokenCategoryBreakdown {
  const breakdown: NimTokenCategoryBreakdown = {
    system: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    images: 0,
  };

  for (const message of messages) {
    const category =
      message.role === "system"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : message.role === "tool"
            ? "toolResults"
            : "user";

    if (typeof message.content === "string") {
      breakdown[category] += estimateTokens(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === "image_url") {
          breakdown.images += estimateImageUrlTokens(part.image_url?.url ?? "image");
        } else if (typeof part.text === "string") {
          breakdown[category] += estimateTokens(part.text);
        } else {
          breakdown[category] += estimateTokens(JSON.stringify(part));
        }
      }
    }

    if (message.reasoning_content) {
      breakdown.assistant += estimateTokens(message.reasoning_content);
    }

    for (const toolCall of message.tool_calls ?? []) {
      breakdown.toolCalls +=
        estimateTokens(toolCall.function.name) + estimateTokens(toolCall.function.arguments);
    }
  }

  return breakdown;
}
