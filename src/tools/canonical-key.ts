import * as vscode from "vscode";
import { LanguageModelChatMessage } from "vscode";
import { ConfigManager, ToolsConfig } from "../shared/config";
import { repairToolArguments } from "./argument-repair";
import { ChatRequestContext } from "./request-context";
import { isEditTool, isReadTool } from "./tool-kinds";
import { ToolSchema } from "./tool-schema";

/**
 * Maximum times the exact same read tool call (same file and line range) is
 * permitted within the current turn before being suppressed as an infinite loop.
 * Set to 2 so a model can legitimately read a file once, and re-read it once
 * (e.g. to verify), but stops infinite runaway read loops on the 3rd attempt.
 */
export const DEFAULT_MAX_DUPLICATE_READS = 2;

export function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(sortObjectKeys(args))}`;
}

export function isDuplicateSuppressionEnabled(
  toolName: string,
  _toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): boolean {
  return isReadTool(toolName);
}

export function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

export function getCompletedToolCallCounts(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): Map<string, number> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    const hasNonToolResultContent = message.content.some((part) => {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      return !(typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content));
    });
    if (hasNonToolResultContent) {
      startIndex = i + 1;
      break;
    }
  }

  const completedCallIds = new Set<string>();

  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
        completedCallIds.add(toolResultPart.callId);
      }
    }
  }

  const counts = new Map<string, number>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolCallPart = part as { callId?: unknown; name?: unknown; input?: unknown };
      if (
        typeof toolCallPart.callId !== "string" ||
        !completedCallIds.has(toolCallPart.callId) ||
        typeof toolCallPart.name !== "string"
      ) {
        continue;
      }

      if (isEditTool(toolCallPart.name)) {
        // Any intervening edit modifies workspace state, so read tool counts reset.
        for (const key of Array.from(counts.keys())) {
          const colonIndex = key.indexOf(":");
          const tool = colonIndex !== -1 ? key.slice(0, colonIndex) : key;
          if (isReadTool(tool)) {
            counts.delete(key);
          }
        }
      }

      const repairedArgs = repairToolArguments(
        toolCallPart.name,
        toolCallPart.input ?? {},
        requestContext,
        toolSchemas.get(toolCallPart.name),
        toolsConfig,
      );
      const key = buildToolCallCanonicalKey(toolCallPart.name, repairedArgs);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

export function getCompletedToolCallKeys(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): Set<string> {
  const counts = getCompletedToolCallCounts(messages, requestContext, toolSchemas, toolsConfig);
  return new Set(counts.keys());
}
