import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { debugLog } from "../shared/logging";
import { getLanguageModelChatToolModeRequired } from "../shared/proposed-apis";
import { AUXILIARY_REQUIRED_FIELDS } from "../shared/tool-fields";
import { JsonObject, NimChatMessage, NimContentPart, NimTool } from "../types";
import {
  asObjectRecord,
  extractImageData,
  getDataPartTextValue,
  getTextPartValue,
  getThinkingPartValue,
  getToolCallInfo,
  getToolResultTexts,
  truncatePreservingSurrogates,
} from "./parts";
import { estimateNimMessagesTokens } from "./token-estimate";
import { pairToolCallsAndResults } from "./tool-call-pairing";

export type { LegacyPart } from "./parts";
export {
  getDataPartTextValue,
  getTextPartValue,
  getThinkingPartValue,
  getToolCallInfo,
  getToolResultTexts,
  truncatePreservingSurrogates,
} from "./parts";
export {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateNimMessagesTokens,
  estimateNimMessagesTokensByCategory,
  estimatePartTokens,
  estimateTokens,
  estimateToolsTokens,
} from "./token-estimate";
export type { NimTokenCategoryBreakdown } from "./token-estimate";

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
    const thinkingParts: string[] = [];
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

      const thinkingText = getThinkingPartValue(part);
      if (thinkingText !== undefined) {
        thinkingParts.push(thinkingText);
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
      const reasoning_content = thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;
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
        ...(reasoning_content !== undefined ? { reasoning_content } : {}),
      });
    }

    for (const tr of toolResults) {
      let content = tr.content || "";
      if (options?.maxToolResultChars && content.length > options.maxToolResultChars) {
        content = truncatePreservingSurrogates(content, options.maxToolResultChars) + "…";
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
      const reasoning_content =
        role === "assistant" && thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;
      if (imageParts.length > 0) {
        const contentParts: NimContentPart[] = [];
        const text = textParts.join("");
        if (text) contentParts.push({ type: "text", text });
        contentParts.push(...imageParts);
        const newMsg: NimChatMessage = {
          role,
          content: contentParts,
          ...(reasoning_content !== undefined ? { reasoning_content } : {}),
        };
        result.push(newMsg);
      } else {
        const newMsg: NimChatMessage = {
          role,
          content: textParts.join("") || "(empty message)",
          ...(reasoning_content !== undefined ? { reasoning_content } : {}),
        };
        result.push(newMsg);
      }
    } else if (!isAssistantWithToolCalls && toolResults.length === 0 && !hasTextOrImage) {
      const reasoning_content =
        role === "assistant" && thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;
      result.push({
        role,
        content: "(empty message)",
        ...(reasoning_content !== undefined ? { reasoning_content } : {}),
      });
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

  if (options.toolMode === getLanguageModelChatToolModeRequired()) {
    return { tools, tool_choice: "required" };
  }

  return { tools, tool_choice: "auto" };
}

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
  pairToolCallsAndResults(nonSystemMessages, selected);
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
