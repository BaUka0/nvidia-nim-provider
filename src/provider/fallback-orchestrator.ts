import * as vscode from "vscode";
import { LanguageModelChatInformation } from "vscode";
import { isFirstTokenTimeout, NvidiaApiError } from "../api/errors";
import { calculateSafetyMargin, FallbackConfig } from "../shared/config";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { NormalizedNvidiaModel } from "../models/catalog";

/**
 * Failover policy helpers. The hop loop stays in `chat-provider.ts` because
 * it owns API-key resolution and VS Code UI; this module stays UI-free.
 */
export function shouldRestartTimeoutChain(options: {
  err: unknown;
  fallbackConfig: FallbackConfig;
  failingAttemptHasVisibleContent: boolean;
  chainRestarts: number;
}): boolean {
  if (!(options.err instanceof NvidiaApiError) || options.err.kind !== "timeout") {
    return false;
  }
  if (options.failingAttemptHasVisibleContent) {
    return false;
  }
  if (!options.fallbackConfig.onTimeout) {
    return false;
  }
  if (isFirstTokenTimeout(options.err) && !options.fallbackConfig.onFirstTokenTimeout) {
    return false;
  }
  const maxRestarts = options.fallbackConfig.maxChainRestarts;
  return maxRestarts > 0 && options.chainRestarts < maxRestarts;
}

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
  if (
    err instanceof NvidiaApiError &&
    (err.operation === "history_loop" || err.operation === "tool_call_loop")
  ) {
    // A loop is a stuck transcript, not a dead model. Hopping would abort the
    // Copilot agent turn; the loop breaker / in-stream cap should keep working.
    return false;
  }
  return (
    err instanceof NvidiaApiError &&
    (err.kind === "rate_limited" ||
      err.kind === "model_unavailable" ||
      err.kind === "empty_stream" ||
      (err.kind === "timeout" &&
        fallbackConfig.onTimeout &&
        (!isFirstTokenTimeout(err) || fallbackConfig.onFirstTokenTimeout)) ||
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
    if (err.operation === "invalid_tool_call") {
      return "Invalid tool call";
    }
    if (err.operation === "tool_call_loop" || err.operation === "history_loop") {
      return "Loop detected";
    }
    return "Empty response";
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
  safetyMarginPercent?: number,
): LanguageModelChatInformation {
  const fallbackCapabilities: vscode.LanguageModelChatCapabilities = {
    toolCalling: fallbackModel.supportsTools ? 128 : false,
    imageInput: fallbackModel.supportsVision,
  };
  const info: LanguageModelChatInformation = {
    ...source,
    id: fallbackModel.id,
    name: fallbackModel.displayName,
    maxInputTokens: Math.max(
      1,
      fallbackModel.contextWindow -
        Math.min(fallbackModel.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS) -
        calculateSafetyMargin(fallbackModel.contextWindow, safetyMarginPercent),
    ),
    maxOutputTokens: fallbackModel.maxOutputTokens,
    capabilities: fallbackCapabilities,
  };
  const bindingId = (source as unknown as Record<string, unknown>)["__nvidiaNimRuntimeKeyBinding"];
  if (typeof bindingId === "string" && bindingId.length > 0) {
    try {
      Object.defineProperty(info, "__nvidiaNimRuntimeKeyBinding", {
        value: bindingId,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch {
      // Ignore if cannot define property
    }
  }
  return info;
}
