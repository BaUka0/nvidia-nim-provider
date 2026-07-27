import * as vscode from "vscode";
import { calculateSafetyMargin, DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateNimMessagesTokens,
  estimateToolsTokens,
  truncateMessagesForContext,
  LegacyPart,
} from "../messages/converter";
import { splitMessagesForSummarization, summarizeOldMessages } from "../models/summarizer";
import { getModelAdapter } from "../models/adapters";
import { formatStructuredError } from "../api/errors";
import { debugLog } from "../shared/logging";
import { NimChatRequest, NimChatMessage, NimTool } from "../types";

export interface PreparedRequest {
  requestBody: NimChatRequest;
  reasoningIsolationExpected: boolean;
  inputTokenCount: number;
  requestedMaxTokens: number;
  safetyMargin: number;
  temperatureVal: number;
  toolsEnabled: boolean;
  extraSystemMessages: string[];
  tools?: NimTool[];
}

/**
 * When the prepared payload exceeds this fraction of the effective input budget,
 * proactively compact older turns before the hard limit is reached.  This
 * avoids the server rejecting the request outright and gives the user a
 * smoother experience in long conversations.
 */
const PREFLIGHT_COMPACT_THRESHOLD = 0.85;

export class NimRequestBuilder {
  public static calculateMaxToolResultChars(contextWindow: number): number {
    if (contextWindow >= 500000) {
      return 50000;
    }
    if (contextWindow >= 200000) {
      return 30000;
    }
    if (contextWindow >= 100000) {
      return 20000;
    }
    return 10000;
  }

  public static calculateRequestedMaxTokens(options: {
    requestedMaxTokens: number;
    modelMaxOutputTokens: number;
    contextWindow: number;
    inputTokenCount: number;
  }): number {
    const safetyMargin = calculateSafetyMargin(options.contextWindow);
    const availableCompletionTokens = Math.max(
      1,
      options.contextWindow - options.inputTokenCount - safetyMargin,
    );

    return Math.min(
      options.requestedMaxTokens,
      options.modelMaxOutputTokens,
      availableCompletionTokens,
    );
  }

  public static hasImageInput(messages: readonly vscode.LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        const p = part as { mimeType?: unknown; data?: unknown };
        if (typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) {
          return true;
        }
      }
    }
    return false;
  }

  public static async prepareRequest(options: {
    model: vscode.LanguageModelChatInformation;
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.ProvideLanguageModelChatResponseOptions;
    contextWindow: number;
    supportsTools: boolean;
    supportsVision: boolean;
    apiKey: string;
    userAgent: string;
    signal?: AbortSignal;
  }): Promise<PreparedRequest> {
    const {
      model,
      messages,
      options: responseOptions,
      contextWindow,
      supportsTools,
      supportsVision,
      apiKey,
      userAgent,
      signal,
    } = options;

    const rawInputTokenCount = estimateMessagesTokens(
      messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
    );
    const maxInputTokens = model.maxInputTokens;
    const effectiveMaxInputTokens = Math.max(1, maxInputTokens - calculateSafetyMargin(contextWindow));

    if (rawInputTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Input tokens ${rawInputTokenCount} exceed max ${effectiveMaxInputTokens}. Will attempt context compression.`,
      );
    }

    const maxTokensVal = (responseOptions.modelOptions as Record<string, unknown>)?.max_tokens;
    const requestedMaxTokensLimit =
      typeof maxTokensVal === "number" && maxTokensVal > 0
        ? maxTokensVal
        : DEFAULT_MAX_OUTPUT_TOKENS;

    const maxToolResultChars = this.calculateMaxToolResultChars(contextWindow);
    const toolConfig = supportsTools ? convertTools(responseOptions) : {};
    const toolsEnabled = Boolean(toolConfig.tools?.length);
    const adapter = getModelAdapter(model.id);
    const requestProfile = adapter.getProfile({
      toolsEnabled,
    });

    const userTemperature = (responseOptions.modelOptions as Record<string, unknown>)?.temperature;
    const profileTemperature =
      toolsEnabled && requestProfile.toolTemperature !== undefined
        ? requestProfile.toolTemperature
        : requestProfile.defaultTemperature;
    const temperatureVal =
      typeof userTemperature === "number" ? userTemperature : profileTemperature;

    let apiMessages = convertMessages(messages, {
      maxToolResultChars,
      supportsVision,
    });
    apiMessages = adapter.applyMessagesWorkaround
      ? adapter.applyMessagesWorkaround(apiMessages)
      : apiMessages;

    if (requestProfile.extraSystemMessages.length > 0) {
      apiMessages = [
        ...requestProfile.extraSystemMessages.map(
          (content): NimChatMessage => ({ role: "system", content }),
        ),
        ...apiMessages,
      ];
    }

    const toolDefinitionTokens = toolConfig.tools ? estimateToolsTokens(toolConfig.tools) : 0;
    let apiTokenCount = estimateNimMessagesTokens(apiMessages);
    let payloadInputTokenCount = apiTokenCount + toolDefinitionTokens;
    const messageTokenBudget = Math.max(1, effectiveMaxInputTokens - toolDefinitionTokens);
    const recentTokenBudget = Math.floor(messageTokenBudget * 0.4);

    /**
     * Summarise older turns and replace them with a compact summary message.
     * Returns the new messages array and updated payloadInputTokenCount.
     */
    const compactMessages = async (
      currentMessages: NimChatMessage[],
      label: string,
    ): Promise<{ messages: NimChatMessage[]; tokenCount: number }> => {
      const { oldMessages, recentMessages } = splitMessagesForSummarization(
        currentMessages,
        recentTokenBudget,
      );
      if (oldMessages.length === 0) {
        return { messages: currentMessages, tokenCount: payloadInputTokenCount };
      }
      const summaryMessage = await summarizeOldMessages(oldMessages, apiKey, userAgent, signal);
      const recentSystemMessages = recentMessages.filter((m) => m.role === "system");
      const recentConversationMessages = recentMessages.filter((m) => m.role !== "system");
      const compacted = [...recentSystemMessages, summaryMessage, ...recentConversationMessages];
      const tokenCount = estimateNimMessagesTokens(compacted) + toolDefinitionTokens;
      debugLog(
        "contextCompression",
        `${label}: ${tokenCount} tokens (was ${payloadInputTokenCount}).`,
      );
      return { messages: compacted, tokenCount };
    };

    // --- Preflight compaction: proactive compression before hard limit ---
    // When the payload exceeds the threshold (default 85%), compact older
    // turns preemptively to avoid a server-side 400 rejection.
    const compactThreshold = Math.floor(effectiveMaxInputTokens * PREFLIGHT_COMPACT_THRESHOLD);
    if (payloadInputTokenCount > compactThreshold && payloadInputTokenCount <= effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Preflight: ${payloadInputTokenCount} tokens >= ${compactThreshold} threshold (${(PREFLIGHT_COMPACT_THRESHOLD * 100).toFixed(0)}%). Compacting proactively...`,
      );
      const result = await compactMessages(apiMessages, "Preflight compaction");
      apiMessages = result.messages;
      payloadInputTokenCount = result.tokenCount;
    }

    // --- Hard limit: reactive compression when over budget ---
    if (payloadInputTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Prepared payload ${payloadInputTokenCount} tokens > ${effectiveMaxInputTokens} max. Compressing...`,
      );
      const result = await compactMessages(apiMessages, "Hard-limit compaction");
      apiMessages = result.messages;
      payloadInputTokenCount = result.tokenCount;

      if (payloadInputTokenCount > effectiveMaxInputTokens) {
        apiMessages = truncateMessagesForContext(apiMessages, messageTokenBudget);
        const finalMessageTokenCount = estimateNimMessagesTokens(apiMessages);
        payloadInputTokenCount = finalMessageTokenCount + toolDefinitionTokens;
        debugLog(
          "contextCompression",
          `After truncation fallback: ${payloadInputTokenCount} tokens.`,
        );
        if (payloadInputTokenCount > effectiveMaxInputTokens) {
          throw new Error(
            formatStructuredError(
              "token_limit",
              `Even after compression and truncation: ${payloadInputTokenCount} tokens, max: ${effectiveMaxInputTokens}`,
            ),
          );
        }
      }
    }

    apiTokenCount = estimateNimMessagesTokens(apiMessages);
    payloadInputTokenCount = apiTokenCount + toolDefinitionTokens;
    if (payloadInputTokenCount > effectiveMaxInputTokens) {
      throw new Error(
        formatStructuredError(
          "token_limit",
          `Prepared payload exceeds context after compression: ${payloadInputTokenCount} tokens, max: ${effectiveMaxInputTokens}`,
        ),
      );
    }

    const requestedMaxTokens = this.calculateRequestedMaxTokens({
      requestedMaxTokens: requestedMaxTokensLimit,
      modelMaxOutputTokens: model.maxOutputTokens,
      contextWindow,
      inputTokenCount: payloadInputTokenCount,
    });

    const requestBody: NimChatRequest = {
      model: model.id,
      messages: apiMessages,
      stream: true,
      max_tokens: requestedMaxTokens,
      temperature: temperatureVal,
      stream_options: { include_usage: true },
    };

    const configuredReasoningMode = (
      responseOptions as { modelConfiguration?: { reasoningMode?: string } }
    ).modelConfiguration?.reasoningMode;
    const modes = adapter.supportedReasoningModes;
    let reasoningMode = configuredReasoningMode;
    if (reasoningMode === undefined && modes && modes.length > 0) {
      reasoningMode = vscode.workspace
        .getConfiguration("nvidia-nim")
        .get<string>("reasoningMode", "none");
    }
    reasoningMode ??= "none";

    if (modes && modes.length > 0 && !modes.includes(reasoningMode)) {
      reasoningMode = modes.includes("none") ? "none" : modes[0];
    }

    if (adapter.applyReasoningMode) {
      adapter.applyReasoningMode(requestBody, reasoningMode);
    }

    const reasoningContentExpected =
      Boolean(adapter.applyReasoningMode) && reasoningMode !== "none";
    const reasoningIsolationExpected =
      (reasoningContentExpected && adapter.isolateUntaggedReasoning !== false) ||
      Boolean(adapter.alwaysReasons);

    const modelOpts = responseOptions.modelOptions as Record<string, unknown>;
    if (typeof modelOpts?.top_p === "number") {
      requestBody.top_p = Math.min(1, Math.max(0, modelOpts.top_p));
    }
    if (typeof modelOpts?.frequency_penalty === "number") {
      requestBody.frequency_penalty = Math.min(2, Math.max(-2, modelOpts.frequency_penalty));
    }
    if (typeof modelOpts?.presence_penalty === "number") {
      requestBody.presence_penalty = Math.min(2, Math.max(-2, modelOpts.presence_penalty));
    }
    const stopVal = modelOpts?.stop;
    if (typeof stopVal === "string" || (Array.isArray(stopVal) && stopVal.length > 0)) {
      requestBody.stop = stopVal as string | string[];
    }

    if (toolConfig.tools) {
      requestBody.tools = toolConfig.tools;
    }
    if (toolConfig.tool_choice) {
      requestBody.tool_choice = toolConfig.tool_choice;
    }

    debugLog("Outgoing request messages", requestBody.messages);

    const safetyMargin = calculateSafetyMargin(contextWindow);
    const remainingBudget = Math.max(0, contextWindow - payloadInputTokenCount - requestedMaxTokens - safetyMargin);
    const utilizationPercent = contextWindow > 0 ? ((payloadInputTokenCount / contextWindow) * 100).toFixed(1) : "0";
    debugLog("budget", {
      contextWindow,
      safetyMargin,
      estimatedInputTokens: payloadInputTokenCount,
      reservedOutputTokens: requestedMaxTokens,
      remainingBudget,
      utilizationPercent: `${utilizationPercent}%`,
      toolDefinitionTokens,
    });

    return {
      requestBody,
      reasoningIsolationExpected,
      inputTokenCount: payloadInputTokenCount,
      requestedMaxTokens,
      safetyMargin,
      temperatureVal,
      toolsEnabled,
      extraSystemMessages: requestProfile.extraSystemMessages,
      tools: toolConfig.tools,
    };
  }
}
