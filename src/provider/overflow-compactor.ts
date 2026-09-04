import { LanguageModelChatMessage } from "vscode";
import { estimateToolsTokens } from "../messages/converter";
import { getModelAdapter } from "../models/adapters";
import { compactAndFit } from "../models/summarizer";
import { calculateSafetyMargin } from "../shared/config";
import { COMPACTION_MIN_OUTPUT_TOKENS, COMPACTION_OUTPUT_FRACTION } from "../shared/constants";
import { FetchAttemptBudget } from "../shared/fetch-attempt-budget";
import { debugLog } from "../shared/logging";
import { NimChatRequest } from "../types";
import { NimRequestBuilder } from "./request-builder";

export interface OverflowCompactionInput {
  messages?: readonly LanguageModelChatMessage[];
  activeRequestBody: NimChatRequest;
  supportsVision?: boolean;
  retryContextWindow: number;
  apiKey: string;
  userAgent: string;
  signal?: AbortSignal;
  fetchAttemptBudget?: FetchAttemptBudget;
  summarizationModel?: string;
  maxHttpRetries?: number;
  safetyMarginPercent: number;
}

export interface OverflowCompactionResult {
  requestBody: NimChatRequest;
  compactedMaxOutput: number;
}

/** Compact the failing request body after a server-side context overflow. */
export async function buildOverflowRetryRequest(
  input: OverflowCompactionInput,
): Promise<OverflowCompactionResult | undefined> {
  const safetyMargin = calculateSafetyMargin(input.retryContextWindow, input.safetyMarginPercent);
  const compactedMaxOutput = Math.max(
    COMPACTION_MIN_OUTPUT_TOKENS,
    Math.floor(input.retryContextWindow * COMPACTION_OUTPUT_FRACTION),
  );
  const compactedMaxInput = Math.max(
    1,
    input.retryContextWindow - safetyMargin - compactedMaxOutput,
  );

  let candidateMessages = input.activeRequestBody?.messages;
  if (!candidateMessages || candidateMessages.length === 0) {
    if (input.messages) {
      const adapter = getModelAdapter(input.activeRequestBody.model);
      const toolsEnabled = Boolean(input.activeRequestBody.tools?.length);
      candidateMessages = NimRequestBuilder.convertMessagesWithProfile({
        messages: input.messages,
        adapter,
        contextWindow: input.retryContextWindow,
        supportsVision: Boolean(input.supportsVision),
        toolsEnabled,
      });
    } else {
      return undefined;
    }
  }

  const toolDefinitionTokens = input.activeRequestBody.tools
    ? estimateToolsTokens(input.activeRequestBody.tools)
    : 0;

  const result = await compactAndFit({
    messages: candidateMessages,
    toolDefinitionTokens,
    effectiveMaxInputTokens: compactedMaxInput,
    allowTruncation: true,
    forceShrink: true,
    summarizationOptions: {
      apiKey: input.apiKey,
      userAgent: input.userAgent,
      signal: input.signal,
      summarizationModel: input.summarizationModel,
      fetchAttemptBudget: input.fetchAttemptBudget,
      maxHttpRetries: input.maxHttpRetries,
    },
  });

  if (!result.fits) {
    return undefined;
  }

  debugLog("contextOverflow", {
    action: "retryAfterCompaction",
    compactedTokens: result.tokenCount,
    compactedMaxInput,
    compactedMaxOutput,
    truncated: result.truncated,
  });

  return {
    compactedMaxOutput,
    requestBody: {
      ...input.activeRequestBody,
      messages: result.messages,
      max_tokens: compactedMaxOutput,
    },
  };
}
