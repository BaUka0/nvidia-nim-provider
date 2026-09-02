import * as vscode from "vscode";
import { LanguageModelChatMessage } from "vscode";
import { ConfigManager, ToolsConfig } from "../shared/config";
import { repairToolArguments } from "./argument-repair";
import { ChatRequestContext } from "./request-context";
import { isDirTool, isEditTool, isTerminalTool } from "./tool-kinds";
import { ToolSchema } from "./tool-schema";

export function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(sortObjectKeys(args))}`;
}

export function isDuplicateSuppressionEnabled(
  toolName: string,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): boolean {
  if (!toolsConfig.suppressDuplicateReads) {
    return false;
  }
  if (isTerminalTool(toolName) || isEditTool(toolName) || isDirTool(toolName)) {
    return false;
  }
  return true;
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

export function getCompletedToolCallKeys(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): Set<string> {
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

  const keys = new Set<string>();
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

      const repairedArgs = repairToolArguments(
        toolCallPart.name,
        toolCallPart.input ?? {},
        requestContext,
        toolSchemas.get(toolCallPart.name),
        toolsConfig,
      );
      keys.add(buildToolCallCanonicalKey(toolCallPart.name, repairedArgs));
    }
  }

  return keys;
}
