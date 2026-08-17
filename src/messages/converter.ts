import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { debugLog } from "../shared/logging";
import { JsonObject, NimChatMessage, NimContentPart, NimTool } from "../types";

export interface LegacyPart {
  type?: string;
  mimeType?: string;
  bytes?: Uint8Array | number[] | string;
  data?: Uint8Array | number[] | string;
  buffer?: ArrayBuffer;
  value?: string;
  [key: string]: unknown;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
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

export function getTextPartValue(
  part: vscode.LanguageModelInputPart | LegacyPart,
): string | undefined {
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

  if (typeof p.data === "string" && p.data.trim().length > 0) {
    const raw = p.data.trim();
    const payload = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (/^[A-Za-z0-9+/\s]+={0,2}$/.test(payload)) {
      const decoded = Buffer.from(payload.replace(/\s/g, ""), "base64");
      if (decoded.length > 0) {
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

const AUXILIARY_REQUIRED_FIELDS = new Set([
  "goal",
  "explanation",
  "mode",
  "summary",
  "description",
  "isRegexp",
]);

function payloadRequiredFields(schema: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(schema?.required)) {
    return [];
  }
  return schema.required.filter(
    (item): item is string => typeof item === "string" && !AUXILIARY_REQUIRED_FIELDS.has(item),
  );
}

function toModelFacingSchema(inputSchema: unknown): JsonObject | undefined {
  const schema = asObjectRecord(inputSchema);
  if (!schema) {
    return inputSchema as JsonObject | undefined;
  }

  const required = payloadRequiredFields(schema);
  return {
    ...schema,
    ...(Array.isArray(schema.required) ? { required } : {}),
  };
}

function buildToolDescription(
  description: string | undefined,
  inputSchema: unknown,
): string | undefined {
  const schema = asObjectRecord(inputSchema);
  const required = payloadRequiredFields(schema);
  const properties = asObjectRecord(schema?.properties);
  const requiredHints = required.map((name) => {
    const propertySchema = asObjectRecord(properties?.[name]);
    const enumValues = Array.isArray(propertySchema?.enum)
      ? propertySchema.enum.filter((item): item is string => typeof item === "string")
      : [];
    return enumValues.length > 0 ? `${name} (${enumValues.join(", ")})` : name;
  });

  const parts = [
    typeof description === "string" ? description.trim() : "",
    requiredHints.length > 0 ? `Required: ${requiredHints.join(", ")}.` : "",
  ].filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number; supportsVision?: boolean },
): NimChatMessage[] {
  const result: NimChatMessage[] = [];

  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : msg.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "system";

    const textParts: string[] = [];
    const imageParts: NimContentPart[] = [];
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
          id: tc.id ?? `call_${randomUUID()}`,
          type: "function",
          function: {
            name: tc.name ?? "unknown",
            arguments: JSON.stringify(tc.args ?? {}),
          },
        })),
        // A single space of reasoning_content prevents incomplete responses on
        // models that require the field (Kimi K2.5/2.6) without polluting the
        // actual output. Applied globally so the converted assistant turn stays
        // uniform across the adapter-specific messages workarounds.
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
        const contentParts: NimContentPart[] = [];
        const text = textParts.join("");
        if (text) contentParts.push({ type: "text", text });
        contentParts.push(...imageParts);
        const newMsg: NimChatMessage = { role, content: contentParts };
        result.push(newMsg);
      } else {
        const newMsg: NimChatMessage = { role, content: textParts.join("") || "(empty message)" };
        result.push(newMsg);
      }
    } else if (!isAssistantWithToolCalls && toolResults.length === 0 && !hasTextOrImage) {
      result.push({ role, content: "(empty message)" });
    }
  }

  return result;
}

/**
 * Convert VS Code language model tools to the NVIDIA NIM tool-call format.
 * Honors the Required tool mode by emitting an explicit tool_choice.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: NimTool[];
  tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    return {};
  }

  const tools: NimTool[] = toolsInput.map((tool) => {
    const parameters = toModelFacingSchema(tool.inputSchema);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: buildToolDescription(tool.description, parameters ?? tool.inputSchema),
        ...(parameters ? { parameters } : {}),
      },
    };
  });

  if (
    options.toolMode ===
    (vscode as unknown as { LanguageModelChatToolMode?: { Required?: number } })
      .LanguageModelChatToolMode?.Required
  ) {
    return { tools, tool_choice: "required" };
  }

  return { tools, tool_choice: "auto" };
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

export interface TokenCategoryBreakdown {
  system: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  images: number;
}

function classifyPartTokens(
  part: vscode.LanguageModelInputPart | LegacyPart,
  breakdown: TokenCategoryBreakdown,
): void {
  const toolCallInfo = getToolCallInfo(part);
  if (toolCallInfo) {
    const nameTokens = toolCallInfo.name ? estimateTokens(toolCallInfo.name) : 0;
    const argsTokens = toolCallInfo.args ? estimateTokens(JSON.stringify(toolCallInfo.args)) : 0;
    breakdown.toolCalls += nameTokens + argsTokens;
    return;
  }

  const toolResultPart = part as { callId?: unknown; content?: unknown[] };
  if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
    const texts = getToolResultTexts(part);
    const joined = texts.join("\n").trim();
    breakdown.toolResults += joined ? estimateTokens(joined) : 2;
    return;
  }

  const img = extractImageData(part);
  if (img) {
    breakdown.images += Math.max(4, Math.ceil(img.data.length / 750));
    return;
  }
}

export function estimateMessagesTokensByCategory(
  messages: readonly {
    role: number;
    content: (vscode.LanguageModelInputPart | LegacyPart)[];
  }[],
): TokenCategoryBreakdown {
  const breakdown: TokenCategoryBreakdown = {
    system: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    images: 0,
  };

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
    const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant;

    for (const part of msg.content) {
      const toolCallInfo = getToolCallInfo(part);
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      const isToolCall = Boolean(toolCallInfo);
      const isToolResult =
        typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content);
      const img = extractImageData(part);

      if (isToolCall) {
        classifyPartTokens(part, breakdown);
      } else if (isToolResult) {
        classifyPartTokens(part, breakdown);
      } else if (img) {
        classifyPartTokens(part, breakdown);
      } else {
        const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
        // Unknown parts still contribute a placeholder so the category
        // breakdown stays consistent with estimatePartTokens().
        const tokens = tv !== undefined ? estimateTokens(tv) : 2;
        if (isUser) {
          breakdown.user += tokens;
        } else if (isAssistant) {
          breakdown.assistant += tokens;
        } else {
          breakdown.system += tokens;
        }
      }
    }
  }

  return breakdown;
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

/**
 * Truncate converted messages to fit within a token budget.
 * Preserves all system messages + the most recent non-system messages.
 * Drops older messages from the middle.
 */
export function truncateMessagesForContext(
  messages: NimChatMessage[],
  maxTokens: number,
): NimChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  let systemTokens = 0;
  for (const m of systemMessages) {
    systemTokens += estimateNimMessagesTokens([m]);
  }

  const budgetForNonSystem = Math.max(0, maxTokens - systemTokens);
  let kept: NimChatMessage[] = [];
  let usedTokens = 0;

  for (let i = nonSystemMessages.length - 1; i >= 0; i -= 1) {
    const msg = nonSystemMessages[i];
    const msgTokens = estimateNimMessagesTokens([msg]);
    if (usedTokens + msgTokens > budgetForNonSystem) {
      break;
    }
    kept.unshift(msg);
    usedTokens += msgTokens;
  }

  // Keep assistant tool-call messages paired with their tool results (and
  // vice versa). Sending an orphan `tool_call_id` is rejected by many
  // OpenAI-compatible endpoints even when the text budget itself fits.
  const selected = new Set(kept);
  let pairChanged = true;
  while (pairChanged) {
    pairChanged = false;
    for (const message of nonSystemMessages) {
      if (message.role === "tool" && selected.has(message) && message.tool_call_id) {
        const owner = nonSystemMessages.find(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.tool_calls?.some((call) => call.id === message.tool_call_id),
        );
        if (owner && !selected.has(owner)) {
          selected.add(owner);
          pairChanged = true;
        }
      }
      if (message.role === "assistant" && selected.has(message) && message.tool_calls?.length) {
        for (const result of nonSystemMessages) {
          if (
            result.role === "tool" &&
            result.tool_call_id &&
            message.tool_calls.some((call) => call.id === result.tool_call_id) &&
            !selected.has(result)
          ) {
            selected.add(result);
            pairChanged = true;
          }
        }
      }
    }
  }
  kept = nonSystemMessages.filter((message) => selected.has(message));

  if (kept.length === 0 && nonSystemMessages.length > 0) {
    kept.push(nonSystemMessages[nonSystemMessages.length - 1]);
  }

  const result: NimChatMessage[] = [
    {
      role: "system",
      content:
        "[Note: Earlier conversation context was truncated to fit the model's context window.]",
    },
    ...systemMessages,
    ...kept,
  ];

  return result;
}
