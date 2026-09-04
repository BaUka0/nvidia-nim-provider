import * as vscode from "vscode";
import { LanguageModelChatInformation } from "vscode";
import { NvidiaApiError } from "../api/errors";
import { calculateSafetyMargin, FallbackConfig } from "../shared/config";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { NormalizedNvidiaModel } from "../models/catalog";

export function isFallbackEligibleError(
  err: unknown,
  fallbackConfig: FallbackConfig,
  priorDepth: number,
  failingAttemptHasVisibleContent: boolean,
): err is NvidiaApiError {
  const maxChainLength = Math.max(1, fallbackConfig.priorityList.length + 1);
  if (!fallbackConfig.enabled || priorDepth >= maxChainLength || failingAttemptHasVisibleContent) {
    return false;
  }
  return (
    err instanceof NvidiaApiError &&
    ((err.kind === "rate_limited" && fallbackConfig.onRateLimit) ||
      (err.kind === "model_unavailable" && fallbackConfig.onModelUnavailable) ||
      (err.kind === "empty_stream" && fallbackConfig.onEmptyStream) ||
      (err.kind === "timeout" && fallbackConfig.onTimeout) ||
      err.kind === "server_error" ||
      err.kind === "network_error" ||
      err.kind === "token_limit" ||
      err.kind === "context_overflow")
  );
}

export function fallbackCapacityLabel(err: NvidiaApiError): string {
  if (err.kind === "model_unavailable") {
    return "Model unavailable";
  }
  if (err.kind === "empty_stream") {
    return err.operation === "invalid_tool_call" ? "Invalid tool call" : "Empty response";
  }
  if (err.kind === "timeout") {
    return "Timeout";
  }
  if (err.kind === "network_error") {
    return "Network error";
  }
  if (err.kind === "server_error") {
    return "Server error";
  }
  if (err.kind === "context_overflow" || err.kind === "token_limit") {
    return "Context overflow";
  }
  if (err.status === 529) {
    return "Overloaded";
  }
  return "Rate limited";
}

export function buildFallbackModelInfo(
  source: LanguageModelChatInformation,
  fallbackModel: NormalizedNvidiaModel,
): LanguageModelChatInformation {
  const fallbackCapabilities: vscode.LanguageModelChatCapabilities = {
    toolCalling: fallbackModel.supportsTools ? 128 : false,
    imageInput: fallbackModel.supportsVision,
  };
  return {
    ...source,
    id: fallbackModel.id,
    name: fallbackModel.displayName,
    maxInputTokens: Math.max(
      1,
      fallbackModel.contextWindow -
        Math.min(fallbackModel.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS) -
        calculateSafetyMargin(fallbackModel.contextWindow),
    ),
    maxOutputTokens: fallbackModel.maxOutputTokens,
    capabilities: fallbackCapabilities,
  };
}
