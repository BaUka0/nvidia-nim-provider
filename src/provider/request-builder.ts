import * as vscode from "vscode";
import {
  CONTEXT_WINDOW_SAFETY_MARGIN,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../shared/constants";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateNimMessagesTokens,
  truncateMessagesForContext,
  LegacyPart,
} from "../messages/converter";
import { splitMessagesForSummarization, summarizeOldMessages } from "../models/summarizer";
import { getModelAdapter } from "../models/adapters";
import { formatStructuredError } from "../api/errors";
import { debugLog } from "../shared/logging";
import { NimChatRequest, NimChatMessage } from "../types";

export interface PreparedRequest {
  requestBody: NimChatRequest;
  reasoningIsolationExpected: boolean;
  inputTokenCount: number;
  requestedMaxTokens: number;
  temperatureVal: number;
  toolsEnabled: boolean;
  extraSystemMessages: string[];
  tools?: any[];
}

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
    const availableCompletionTokens = Math.max(
      1,
      options.contextWindow - options.inputTokenCount - CONTEXT_WINDOW_SAFETY_MARGIN,
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
    const { model, messages, options: responseOptions, contextWindow, supportsTools, supportsVision, apiKey, userAgent, signal } = options;

    const inputTokenCount = estimateMessagesTokens(
      messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
    );
    const maxInputTokens = model.maxInputTokens;
    const effectiveMaxInputTokens = Math.max(1, maxInputTokens - CONTEXT_WINDOW_SAFETY_MARGIN);

    if (inputTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Input tokens ${inputTokenCount} exceed max ${effectiveMaxInputTokens}. Will attempt context compression.`,
      );
    }

    const maxTokensVal = (responseOptions.modelOptions as Record<string, unknown>)?.max_tokens;
    const requestedMaxTokens = this.calculateRequestedMaxTokens({
      requestedMaxTokens:
        typeof maxTokensVal === "number" && maxTokensVal > 0 ? maxTokensVal : DEFAULT_MAX_OUTPUT_TOKENS,
      modelMaxOutputTokens: model.maxOutputTokens,
      contextWindow,
      inputTokenCount,
    });

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

    const apiTokenCount = estimateNimMessagesTokens(apiMessages);
    if (apiTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Converted messages ${apiTokenCount} tokens > ${effectiveMaxInputTokens} max. Compressing...`,
      );
      const { oldMessages, recentMessages } = splitMessagesForSummarization(
        apiMessages,
        Math.floor(effectiveMaxInputTokens * 0.4),
      );
      if (oldMessages.length > 0) {
        const summaryMessage = await summarizeOldMessages(
          oldMessages,
          apiKey,
          userAgent,
          signal,
        );
        apiMessages = [summaryMessage, ...recentMessages];
        const compressedTokenCount = estimateNimMessagesTokens(apiMessages);
        debugLog(
          "contextCompression",
          `After compression: ${compressedTokenCount} tokens (was ${apiTokenCount}).`,
        );
        if (compressedTokenCount > effectiveMaxInputTokens) {
          apiMessages = truncateMessagesForContext(apiMessages, effectiveMaxInputTokens);
          const finalTokenCount = estimateNimMessagesTokens(apiMessages);
          debugLog("contextCompression", `After truncation fallback: ${finalTokenCount} tokens.`);
          if (finalTokenCount > effectiveMaxInputTokens) {
            throw new Error(
              formatStructuredError(
                "token_limit",
                `Even after compression and truncation: ${finalTokenCount} tokens, max: ${effectiveMaxInputTokens}`,
              ),
            );
          }
        }
      }
    }

    const requestBody: NimChatRequest = {
      model: model.id,
      messages: apiMessages,
      stream: true,
      max_tokens: requestedMaxTokens,
      temperature: temperatureVal,
      stream_options: { include_usage: true },
    };

    let reasoningMode =
      (responseOptions as { modelConfiguration?: { reasoningMode?: string } }).modelConfiguration
        ?.reasoningMode ?? "none";
    if (reasoningMode === "none") {
      const modes = adapter.supportedReasoningModes;
      if (modes && modes.length > 0) {
        reasoningMode = vscode.workspace
          .getConfiguration("nvidia-nim")
          .get<string>("reasoningMode", "none");

        if (!modes.includes(reasoningMode)) {
          reasoningMode = modes.includes("none") ? "none" : modes[0];
        }
      }
    }

    if (adapter.applyReasoningMode) {
      adapter.applyReasoningMode(requestBody, reasoningMode);
    }

    const reasoningContentExpected =
      Boolean(adapter.applyReasoningMode) && reasoningMode !== "none";
    const reasoningIsolationExpected = reasoningContentExpected || Boolean(adapter.alwaysReasons);

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

    return {
      requestBody,
      reasoningIsolationExpected,
      inputTokenCount,
      requestedMaxTokens,
      temperatureVal,
      toolsEnabled,
      extraSystemMessages: requestProfile.extraSystemMessages,
      tools: toolConfig.tools,
    };
  }
}
