import * as vscode from "vscode";
import { LanguageModelChatMessage } from "vscode";
import { convertMessages, estimateToolsTokens } from "../messages/converter";
import { getModelAdapter, ModelAdapter } from "../models/adapters";
import { compactConversationHistory } from "../models/summarizer";
import {
  calculateSafetyMargin,
  COMPACTION_MIN_OUTPUT_TOKENS,
  COMPACTION_OUTPUT_FRACTION,
  COMPACTION_RECENT_FRACTION,
} from "../shared/constants";
import { FetchAttemptBudget } from "../shared/fetch-attempt-budget";
import { debugLog } from "../shared/logging";
import { NimChatRequest } from "../types";
import { NimRequestBuilder } from "./request-builder";

export interface OverflowCompactionInput {
  messages: readonly LanguageModelChatMessage[];
  activeRequestBody: NimChatRequest;
  adapter?: ModelAdapter;
  supportsVision: boolean;
  retryContextWindow: number;
  apiKey: string;
  userAgent: string;
  signal?: AbortSignal;
  fetchAttemptBudget?: FetchAttemptBudget;
  summarizationModel?: string;
  maxHttpRetries?: number;
}

export interface OverflowCompactionResult {
  requestBody: NimChatRequest;
  compactedMaxOutput: number;
}

/**
 * Compact conversation history after a server-side context overflow and build
 * a smaller retry request. Returns `undefined` when compaction cannot fit.
 */
export async function buildOverflowRetryRequest(
  input: OverflowCompactionInput,
): Promise<OverflowCompactionResult | undefined> {
  const safetyMargin = calculateSafetyMargin(input.retryContextWindow);
  const compactedMaxOutput = Math.max(
    COMPACTION_MIN_OUTPUT_TOKENS,
    Math.floor(input.retryContextWindow * COMPACTION_OUTPUT_FRACTION),
  );
  const adapter = input.adapter ?? getModelAdapter(input.activeRequestBody.model);
  const toolsEnabled = Boolean(input.activeRequestBody.tools?.length);
  const extraSystemMessages = adapter.getProfile({ toolsEnabled }).extraSystemMessages;

  let apiMessages = convertMessages(Array.from(input.messages), {
    maxToolResultChars: NimRequestBuilder.calculateMaxToolResultChars(input.retryContextWindow),
    supportsVision: input.supportsVision,
  });
  if (adapter.applyMessagesWorkaround) {
    apiMessages = adapter.applyMessagesWorkaround(apiMessages);
  }
  if (extraSystemMessages.length > 0) {
    apiMessages = [
      ...extraSystemMessages.map((content) => ({ role: "system" as const, content })),
      ...apiMessages,
    ];
  }

  const toolDefinitionTokens = input.activeRequestBody.tools
    ? estimateToolsTokens(input.activeRequestBody.tools)
    : 0;
  const compacted = await compactConversationHistory(apiMessages, {
    maxRecentTokens: Math.floor(input.retryContextWindow * COMPACTION_RECENT_FRACTION),
    apiKey: input.apiKey,
    userAgent: input.userAgent,
    signal: input.signal,
    summarizationModel: input.summarizationModel,
    extraTokenCount: toolDefinitionTokens,
    fetchAttemptBudget: input.fetchAttemptBudget,
    maxHttpRetries: input.maxHttpRetries,
  });

  if (!compacted.compacted) {
    return undefined;
  }

  const compactedMaxInput = Math.max(
    1,
    input.retryContextWindow - safetyMargin - compactedMaxOutput,
  );

  debugLog("contextOverflow", {
    action: "retryAfterCompaction",
    compactedTokens: compacted.tokenCount,
    compactedMaxInput,
    compactedMaxOutput,
  });

  if (compacted.tokenCount > compactedMaxInput) {
    return undefined;
  }

  return {
    compactedMaxOutput,
    requestBody: {
      ...input.activeRequestBody,
      messages: compacted.messages,
      max_tokens: compactedMaxOutput,
    },
  };
}

export function notifyOverflowRetry(model: { name?: string; id: string }): void {
  vscode.window.showInformationMessage(
    `Context overflow on ${model.name ?? model.id}. Retrying with compacted history…`,
  );
}
