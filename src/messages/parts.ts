import * as vscode from "vscode";
import { createStructuredError } from "../api/errors";
import { debugLog } from "../shared/logging";
import { MAX_CHAT_IMAGE_BYTES } from "../shared/constants";

export interface LegacyPart {
  type?: string;
  mimeType?: string;
  bytes?: Uint8Array | number[] | string;
  data?: Uint8Array | number[] | string;
  buffer?: ArrayBuffer;
  value?: string;
  [key: string]: unknown;
}

export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Truncate a string to at most `maxChars` UTF-16 code units without splitting
 * a surrogate pair (which would produce an invalid lone surrogate). If the cut
 * would land between a high and low surrogate, back up one unit.
 */
export function truncatePreservingSurrogates(text: string, maxChars: number): string {
  if (text.length <= maxChars || maxChars <= 0) {
    return text.slice(0, Math.max(0, maxChars));
  }
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  // If the last kept unit is a high surrogate, its low surrogate would be cut
  // off; drop the high surrogate too.
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function toUint8Array(
  data: Uint8Array | number[] | ArrayBuffer | string | undefined,
  options?: { allowBase64String?: boolean },
): Uint8Array | undefined {
  if (data instanceof Uint8Array && data.length > 0) {
    return data;
  }
  if (Array.isArray(data) && data.length > 0) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer && data.byteLength > 0) {
    return new Uint8Array(data);
  }
  if (typeof data === "string" && data.length > 0) {
    const trimmed = data.trim();
    if (
      options?.allowBase64String &&
      trimmed.length > 0 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length > 0) {
        try {
          const text = new TextDecoder().decode(decoded);
          if (!text.includes("\uFFFD") && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
            return decoded;
          }
        } catch {
          // Fall back to treating the value as plain text.
        }
      }
    }
    return Buffer.from(data, "utf8");
  }
  return undefined;
}

function isIgnorableToolResultPart(part: vscode.LanguageModelInputPart | LegacyPart): boolean {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const mimeType = (part as { mimeType?: unknown }).mimeType;
  return typeof mimeType === "string" && mimeType.includes("cache_control");
}

export function getThinkingPartValue(
  part: vscode.LanguageModelInputPart | LegacyPart,
): string | undefined {
  if (typeof part !== "object" || part === null) {
    return undefined;
  }
  const constructorName = (part as { constructor?: { name?: string } }).constructor?.name;
  if (
    constructorName === "LanguageModelThinkingPart" ||
    (part as { type?: unknown }).type === "thinking"
  ) {
    const value = (part as { value?: unknown }).value;
    if (typeof value === "string") {
      return value;
    }
  }
  if ("thinking" in part && typeof (part as { thinking?: unknown }).thinking === "string") {
    return (part as { thinking: string }).thinking;
  }
  return undefined;
}

export function getTextPartValue(
  part: vscode.LanguageModelInputPart | LegacyPart,
): string | undefined {
  if (getThinkingPartValue(part) !== undefined) {
    return undefined;
  }
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (typeof part === "object" && part !== null) {
    const p = part as { value?: string };
    if (typeof p.value === "string") {
      return p.value;
    }
  }
  return undefined;
}

export function getDataPartTextValue(
  part: vscode.LanguageModelInputPart | LegacyPart,
): string | undefined {
  if (typeof part !== "object" || part === null) {
    return undefined;
  }
  const p = part as {
    mimeType?: unknown;
    data?: Uint8Array | number[] | string;
    bytes?: Uint8Array | number[] | string;
    buffer?: ArrayBuffer;
  };
  if (typeof p.mimeType !== "string") {
    return undefined;
  }
  const isTextMime =
    p.mimeType.startsWith("text/") ||
    p.mimeType === "application/json" ||
    p.mimeType.endsWith("+json");
  if (!isTextMime) {
    return undefined;
  }
  const allowBase64String = p.mimeType === "application/json" || p.mimeType.endsWith("+json");
  const bytes =
    toUint8Array(p.data, { allowBase64String }) ??
    toUint8Array(p.bytes, { allowBase64String }) ??
    toUint8Array(p.buffer);
  if (!bytes) {
    return undefined;
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function rejectOversizedChatImage(byteLength: number, mimeType: string): void {
  if (byteLength > MAX_CHAT_IMAGE_BYTES) {
    throw createStructuredError(
      "invalid_request",
      `Image (${mimeType}) exceeds the ${MAX_CHAT_IMAGE_BYTES}-byte chat image limit.`,
    );
  }
}

export function extractImageData(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { mimeType: string; data: Uint8Array } | undefined {
  if (typeof part !== "object" || part === null) return undefined;

  const p = part as LegacyPart;
  const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
  if (!mimeType || !mimeType.startsWith("image/")) {
    return undefined;
  }

  if (p.data instanceof Uint8Array && p.data.length > 0) {
    rejectOversizedChatImage(p.data.length, mimeType);
    return { mimeType, data: p.data };
  }
  if (p.bytes instanceof Uint8Array && p.bytes.length > 0) {
    rejectOversizedChatImage(p.bytes.length, mimeType);
    return { mimeType, data: p.bytes };
  }
  if (p.buffer instanceof ArrayBuffer && p.buffer.byteLength > 0) {
    rejectOversizedChatImage(p.buffer.byteLength, mimeType);
    return { mimeType, data: new Uint8Array(p.buffer) };
  }
  if (Array.isArray(p.bytes) && p.bytes.length > 0) {
    const data = new Uint8Array(p.bytes);
    rejectOversizedChatImage(data.length, mimeType);
    return { mimeType, data };
  }
  if (Array.isArray(p.data) && p.data.length > 0) {
    const data = new Uint8Array(p.data);
    rejectOversizedChatImage(data.length, mimeType);
    return { mimeType, data };
  }

  if (typeof p.data === "string" && p.data.trim().length > 0) {
    const raw = p.data.trim();
    const payload = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (/^[A-Za-z0-9+/\s]+={0,2}$/.test(payload)) {
      const decoded = Buffer.from(payload.replace(/\s/g, ""), "base64");
      if (decoded.length > 0) {
        rejectOversizedChatImage(decoded.length, mimeType);
        return { mimeType, data: new Uint8Array(decoded) };
      }
    }
  }

  return undefined;
}

export function getToolCallInfo(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { id?: string; name?: string; args?: Record<string, unknown> } | undefined {
  const p = part as { callId?: string; name?: string; input?: Record<string, unknown> };
  if (typeof p.callId === "string" && typeof p.name === "string") {
    return { id: p.callId, name: p.name, args: p.input };
  }
  return undefined;
}

export function getToolResultTexts(part: vscode.LanguageModelInputPart | LegacyPart): string[] {
  const results: string[] = [];
  const p = part as { callId?: string; content?: unknown[] };
  if (typeof p.callId === "string" && Array.isArray(p.content)) {
    for (const inner of p.content) {
      if (isIgnorableToolResultPart(inner as vscode.LanguageModelInputPart | LegacyPart)) {
        continue;
      }
      if (typeof inner === "object" && inner !== null && "value" in inner) {
        const value = (inner as { value?: unknown }).value;
        if (typeof value === "string") {
          results.push(value);
          continue;
        }
        if (value !== undefined) {
          try {
            results.push(JSON.stringify(value));
          } catch {
            results.push(String(value));
          }
          continue;
        }
      }
      const tv =
        getTextPartValue(inner as vscode.LanguageModelInputPart | LegacyPart) ??
        getDataPartTextValue(inner as vscode.LanguageModelInputPart | LegacyPart);
      if (tv !== undefined) {
        results.push(tv);
        continue;
      }
      debugLog("Unhandled tool result part", inner);
      try {
        results.push(JSON.stringify(inner));
      } catch {
        results.push(String(inner));
      }
    }
    return results;
  }
  return results;
}
