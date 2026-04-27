import * as vscode from "vscode";
import { debugLog } from "./output-channel";
import { Json, JsonObject, OcGoChatMessage, OcGoContentPart, OcGoTool } from "./types";

export interface LegacyPart {
  type?: string;
  mimeType?: string;
  bytes?: Uint8Array | number[];
  data?: Uint8Array | number[];
  buffer?: ArrayBuffer;
  value?: string;
  [key: string]: unknown;
}

export interface ThinkTagFilterState {
  insideThinkBlock: boolean;
  pendingText: string;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function findTrailingCaseInsensitivePrefixStart(text: string, token: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedToken = token.toLowerCase();
  const maxPrefixLength = Math.min(normalizedText.length, normalizedToken.length - 1);

  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (normalizedText.endsWith(normalizedToken.slice(0, prefixLength))) {
      return normalizedText.length - prefixLength;
    }
  }

  return -1;
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

function getTextPartValue(part: vscode.LanguageModelInputPart | LegacyPart): string | undefined {
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

function getDataPartTextValue(
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

function extractImageData(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { mimeType: string; data: Uint8Array } | undefined {
  if (typeof part !== "object" || part === null) return undefined;

  const p = part as LegacyPart;
  const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
  if (!mimeType || !mimeType.startsWith("image/")) {
    return undefined;
  }

  if (p.data instanceof Uint8Array && p.data.length > 0) {
    return { mimeType, data: p.data };
  }
  if (p.bytes instanceof Uint8Array && p.bytes.length > 0) {
    return { mimeType, data: p.bytes };
  }
  if (p.buffer instanceof ArrayBuffer && p.buffer.byteLength > 0) {
    return { mimeType, data: new Uint8Array(p.buffer) };
  }
  if (Array.isArray(p.bytes) && p.bytes.length > 0) {
    return { mimeType, data: new Uint8Array(p.bytes) };
  }
  if (Array.isArray(p.data) && p.data.length > 0) {
    return { mimeType, data: new Uint8Array(p.data) };
  }

  return undefined;
}

function getToolCallInfo(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { id?: string; name?: string; args?: Record<string, unknown> } | undefined {
  const p = part as { callId?: string; name?: string; input?: Record<string, unknown> };
  if (typeof p.callId === "string" && typeof p.name === "string") {
    return { id: p.callId, name: p.name, args: p.input };
  }
  return undefined;
}

function getToolResultTexts(part: vscode.LanguageModelInputPart | LegacyPart): string[] {
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

function buildToolDescription(
  description: string | undefined,
  inputSchema: unknown,
): string | undefined {
  const schema = asObjectRecord(inputSchema);
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];

  const guidance: string[] = [];
  if (schema?.type === "object") {
    guidance.push("Return a valid JSON object that matches this schema.");
    if (required.length > 0) {
      guidance.push(`Required arguments: ${required.join(", ")}.`);
      guidance.push("Do not call this tool with an empty object.");
    }

    const properties = asObjectRecord(schema.properties);
    const propertyNames = properties ? Object.keys(properties) : [];
    const highlightedNames = propertyNames
      .filter((name) => required.includes(name) || propertyNames.length <= 5)
      .slice(0, 5);
    if (highlightedNames.length > 0) {
      const propertyLines = highlightedNames.map((name) => {
        const propertySchema = asObjectRecord(properties?.[name]);
        const propertyType = typeof propertySchema?.type === "string" ? propertySchema.type : "any";
        const propertyDescription =
          typeof propertySchema?.description === "string" ? propertySchema.description.trim() : "";
        const enumValues = Array.isArray(propertySchema?.enum)
          ? propertySchema.enum.filter(
              (item): item is string => typeof item === "string" && item.length > 0,
            )
          : [];
        const enumGuidance =
          enumValues.length > 0 ? ` Allowed values: ${enumValues.join(", ")}.` : "";
        return propertyDescription
          ? `- ${name} (${propertyType}): ${propertyDescription}${enumGuidance}`
          : `- ${name} (${propertyType})${enumGuidance}`;
      });
      guidance.push(`Arguments:\n${propertyLines.join("\n")}`);
    }
  }

  const baseDescription = typeof description === "string" ? description.trim() : "";
  const guidanceText = guidance.join("\n");
  if (baseDescription && guidanceText) {
    return `${baseDescription}\n\n${guidanceText}`;
  }
  return baseDescription || guidanceText || undefined;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number; supportsVision?: boolean },
): OcGoChatMessage[] {
  const result: OcGoChatMessage[] = [];

  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : msg.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "system";

    const textParts: string[] = [];
    const imageParts: OcGoContentPart[] = [];
    const toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of msg.content) {
      const toolCallInfo = getToolCallInfo(part);
      if (toolCallInfo) {
        toolCalls.push(toolCallInfo);
        continue;
      }

      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
        toolResults.push({
          callId: toolResultPart.callId,
          content: getToolResultTexts(part).join("\n").trim(),
        });
        continue;
      }

      const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (tv !== undefined) {
        textParts.push(tv);
        continue;
      }
      const img = extractImageData(part);
      if (img && options?.supportsVision) {
        const base64 = Buffer.from(img.data).toString("base64");
        imageParts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${base64}` },
        });
        continue;
      }
      if (img) {
        continue;
      }
      debugLog("convertMessages", `Unrecognized message part: ${JSON.stringify(part)}`);
    }

    if (toolCalls.length > 0) {
      const assistantContent = textParts.join("");
      result.push({
        role: "assistant",
        content: assistantContent || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: tc.name ?? "unknown",
            arguments: JSON.stringify(tc.args ?? {}),
          },
        })),
        reasoning_content: " ",
      });
    }

    for (const tr of toolResults) {
      let content = tr.content || "";
      if (options?.maxToolResultChars && content.length > options.maxToolResultChars) {
        content = content.slice(0, options.maxToolResultChars) + "…";
      }
      result.push({
        role: "tool",
        tool_call_id: tr.callId,
        content,
      });
    }

    const hasTextOrImage = textParts.length > 0 || imageParts.length > 0;
    const isAssistantWithToolCalls = role === "assistant" && toolCalls.length > 0;

    if (hasTextOrImage && !isAssistantWithToolCalls) {
      if (imageParts.length > 0) {
        const contentParts: OcGoContentPart[] = [];
        const text = textParts.join("");
        if (text) contentParts.push({ type: "text", text });
        contentParts.push(...imageParts);
        const newMsg: OcGoChatMessage = { role, content: contentParts };
        result.push(newMsg);
      } else {
        const newMsg: OcGoChatMessage = { role, content: textParts.join("") || "(empty message)" };
        result.push(newMsg);
      }
    } else if (!isAssistantWithToolCalls && toolResults.length === 0 && !hasTextOrImage) {
      result.push({ role, content: "(empty message)" });
    }
  }

  return result;
}

/**
 * Strip `<think>...</think>` blocks from streamed text.
 * Some reasoning models emit chain-of-thought wrapped in these tags
 * even when a separate reasoning_content field is present.
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

export function filterThinkTagsFromChunk(text: string, state: ThinkTagFilterState): string {
  const openTag = "<think>";
  const closeTag = "</think>";
  let remaining = state.pendingText + text;
  let visibleText = "";

  state.pendingText = "";

  while (remaining.length > 0) {
    if (state.insideThinkBlock) {
      const closeIndex = remaining.toLowerCase().indexOf(closeTag);
      if (closeIndex === -1) {
        const partialCloseIndex = findTrailingCaseInsensitivePrefixStart(remaining, closeTag);
        state.pendingText = partialCloseIndex === -1 ? "" : remaining.slice(partialCloseIndex);
        return visibleText;
      }

      remaining = remaining.slice(closeIndex + closeTag.length);
      state.insideThinkBlock = false;
      continue;
    }

    const openIndex = remaining.toLowerCase().indexOf(openTag);
    if (openIndex === -1) {
      const partialOpenIndex = findTrailingCaseInsensitivePrefixStart(remaining, openTag);
      if (partialOpenIndex === -1) {
        visibleText += remaining;
      } else {
        visibleText += remaining.slice(0, partialOpenIndex);
        state.pendingText = remaining.slice(partialOpenIndex);
      }
      return visibleText;
    }

    visibleText += remaining.slice(0, openIndex);
    remaining = remaining.slice(openIndex + openTag.length);
    state.insideThinkBlock = true;
  }

  return visibleText;
}

export function flushThinkTagFilter(state: ThinkTagFilterState): string {
  const flushedText = state.insideThinkBlock ? "" : state.pendingText;
  state.pendingText = "";
  return flushedText;
}

/**
 * Apply reasoning_content workaround for models that need it (e.g. Kimi K2.5/2.6).
 * These models may return incomplete responses when reasoning_content is absent.
 * A single space prevents this without polluting the actual output.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: OcGoTool[];
  tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    return {};
  }

  const tools: OcGoTool[] = toolsInput.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: buildToolDescription(tool.description, tool.inputSchema),
      parameters: tool.inputSchema as JsonObject,
    },
  }));

  if (
    options.toolMode ===
    (vscode as unknown as { LanguageModelChatToolMode?: { Required?: number } })
      .LanguageModelChatToolMode?.Required
  ) {
    return { tools, tool_choice: "required" };
  }

  return { tools };
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

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.content) {
      const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (tv !== undefined) {
        total += estimateTokens(tv);
      }
    }
  }
  return total;
}

// ============================================================================
// Anthropic Messages API conversion helpers
// ============================================================================

/**
 * Parse a JSON string, returning a typed result object.
 */
export function tryParseJSONObject<T extends Json = Json>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (!text || !text.trim()) {
    return { ok: false, error: "Empty string" };
  }
  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validate that a message array is non-empty and each message has content.
 */
export function validateRequest(
  messages:
    | readonly vscode.LanguageModelChatMessage[]
    | readonly { role: string; content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): void {
  if (!messages || messages.length === 0) {
    throw new Error("Messages array is empty");
  }
  for (const msg of messages) {
    if (!msg.content || msg.content.length === 0) {
      throw new Error("Message has no content");
    }
  }
}
