import { NimChatMessage, NimTool } from "../types";
import {
  asObjectRecord,
  extractImageData,
  getDataPartTextValue,
  getTextPartValue,
  getToolCallInfo,
  getToolResultImages,
  getToolResultTexts,
} from "./parts";

/**
 * Image cost follows pixel dimensions, not file size: NIM vision models bill one
 * token per 28×28 patch (GLM 5.3 Flash and Muse Glimmer match
 * `ceil(w/28) * ceil(h/28) + 2` exactly), Nemotron 3.5 Super VL charges at least
 * 259 per image and Step 5 Preview at least 171, and no model was seen above ~8,000 for one image (measured
 * 2026-10-15). A 40 KB screenshot costs ~440 tokens, so byte-based counting
 * undercounted image-heavy chats about 8x.
 */
export const IMAGE_PATCH_PIXELS = 28;
export const IMAGE_TOKEN_FLOOR = 260;
export const IMAGE_TOKEN_CAP = 8192;
/** Chat template tokens around each message (role header, separators): 3–7 measured. */
export const MESSAGE_OVERHEAD_TOKENS = 7;
/** Template tokens wrapping each tool schema: up to ~31 measured on Nemotron. */
export const TOOL_OVERHEAD_TOKENS = 32;

/** JPEG frame headers sit after EXIF/ICC/XMP segments, which can exceed 64 KB together. */
const IMAGE_HEADER_SCAN_BYTES = 256 * 1024;

function imageTokensForSize(width: number, height: number): number {
  const patches = Math.ceil(width / IMAGE_PATCH_PIXELS) * Math.ceil(height / IMAGE_PATCH_PIXELS);
  return Math.min(IMAGE_TOKEN_CAP, Math.max(IMAGE_TOKEN_FLOOR, patches + 2));
}

/** Images whose header cannot be read are charged as a 1920×1080 screenshot. */
export const IMAGE_UNKNOWN_SIZE_TOKENS = imageTokensForSize(1920, 1080);

/** Width and height from a PNG, GIF, WebP, or JPEG header; undefined for anything else. */
export function readImageSize(data: Uint8Array): { width: number; height: number } | undefined {
  const u16be = (i: number) => (data[i] << 8) | data[i + 1];
  const u16le = (i: number) => data[i] | (data[i + 1] << 8);
  const u24le = (i: number) => data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
  const ascii = (i: number, s: string) => [...s].every((ch, k) => data[i + k] === ch.charCodeAt(0));
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;

  if (data.length >= 24 && data[0] === 0x89 && ascii(1, "PNG")) {
    return size(
      ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0,
      ((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0,
    );
  }
  if (data.length >= 10 && ascii(0, "GIF8")) {
    return size(u16le(6), u16le(8));
  }
  if (data.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X")) return size(1 + u24le(24), 1 + u24le(27));
    if (ascii(12, "VP8L")) {
      const b1 = data[22];
      return size(
        1 + (((b1 & 0x3f) << 8) | data[21]),
        1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((b1 & 0xc0) >> 6)),
      );
    }
    if (ascii(12, "VP8 ")) return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return size(u16be(i + 7), u16be(i + 5));
      }
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/** Single dimension-based heuristic for every image payload shape (parts and data URLs). */
function imageTokensForData(data: Uint8Array): number {
  const dimensions = readImageSize(data);
  return dimensions
    ? imageTokensForSize(dimensions.width, dimensions.height)
    : IMAGE_UNKNOWN_SIZE_TOKENS;
}

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
 * `LanguageModelTextPart`, text-mime `LanguageModelDataPart`,
 * `LanguageModelToolResultPart` (including structured/JSON/binary inner
 * content), and `LanguageModelToolCallPart`. Non-textable parts (images,
 * raw binary) use a size-aware heuristic. This is what VS Code calls to render the
 * context-window token breakdown, so under-counting any part type makes the breakdown
 * disappear for tool-heavy conversations.
 */
export function estimatePartTokens(part: unknown): number {
  // Tool call: assistant requesting a tool invocation.
  const toolCallInfo = getToolCallInfo(part);
  if (toolCallInfo) {
    const nameTokens = toolCallInfo.name ? estimateTokens(toolCallInfo.name) : 0;
    const argsTokens = toolCallInfo.args ? estimateTokens(JSON.stringify(toolCallInfo.args)) : 0;
    return nameTokens + argsTokens;
  }

  // Tool result: the outcome of a previous tool call. Its inner content array may hold
  // text parts, structured objects, JSON data parts, etc. Extract every textable piece.
  const toolResultPart = asObjectRecord(part);
  if (
    toolResultPart &&
    typeof toolResultPart.callId === "string" &&
    Array.isArray(toolResultPart.content)
  ) {
    const texts = getToolResultTexts(part);
    const joined = texts.join("\n").trim();
    const imageTokens = getToolResultImages(part).reduce(
      (sum, img) => sum + imageTokensForData(img.data),
      0,
    );
    return (joined ? estimateTokens(joined) : 2) + imageTokens;
  }

  // Text part or text-decodable data part.
  const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
  if (tv !== undefined) {
    return estimateTokens(tv);
  }

  const img = extractImageData(part);
  if (img) {
    return imageTokensForData(img.data);
  }

  // Unknown part: rough placeholder so it still contributes to the breakdown.
  return 2;
}

/**
 * Estimate the token cost of a single chat message: its content parts plus the
 * chat template tokens every message carries.
 */
export function estimateMessageTokens(msg: { content: readonly unknown[] }): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const part of msg.content) {
    total += estimatePartTokens(part);
  }
  return total;
}

export function estimateMessagesTokens(
  messages: readonly { content: readonly unknown[] }[],
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
    total +=
      TOOL_OVERHEAD_TOKENS +
      estimateTokens(name) +
      estimateTokens(description) +
      estimateTokens(params);
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
      const isBase64 = url.slice(0, separatorIndex).toLowerCase().includes(";base64");
      if (!isBase64) {
        return IMAGE_UNKNOWN_SIZE_TOKENS;
      }
      // Only the header is needed; base64 decodes in 4-char groups, so trim to a multiple of 4.
      const prefix = url
        .slice(separatorIndex + 1, separatorIndex + 1 + Math.ceil(IMAGE_HEADER_SCAN_BYTES / 3) * 4)
        .replace(/\s/g, "");
      const aligned = prefix.slice(0, prefix.length - (prefix.length % 4));
      return imageTokensForData(Buffer.from(aligned, "base64"));
    }
  }
  return IMAGE_UNKNOWN_SIZE_TOKENS;
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

    breakdown[category] += MESSAGE_OVERHEAD_TOKENS;
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
