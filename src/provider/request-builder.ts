import * as vscode from "vscode";
import { ConfigManager, NimConfig } from "../shared/config";
import { calculateSafetyMargin, DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { FetchAttemptBudget } from "../shared/fetch-attempt-budget";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateNimMessagesTokens,
  estimateToolsTokens,
  LegacyPart,
} from "../messages/converter";
import { compactAndFit } from "../models/summarizer";
import { getModelAdapter } from "../models/adapters";
import { createStructuredError } from "../api/errors";
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

  /** Recalculate `max_tokens` after a retry turn is appended; throws if over budget. */
  public static applyRequestBudget(
    body: NimChatRequest,
    options: {
      tools?: NimTool[];
      effectiveContextWindow: number;
      modelMaxOutputTokens: number;
      requestedMaxTokens: number;
    },
  ): NimChatRequest {
    const sentTools = body.tools ?? options.tools;
    const payloadInputTokenCount =
      estimateNimMessagesTokens(body.messages) + (sentTools ? estimateToolsTokens(sentTools) : 0);
    const maximumInputTokens = Math.max(
      1,
      options.effectiveContextWindow - calculateSafetyMargin(options.effectiveContextWindow),
    );
    if (payloadInputTokenCount > maximumInputTokens) {
      throw createStructuredError(
        "token_limit",
        `Retry payload exceeds context: ${payloadInputTokenCount} tokens, max: ${maximumInputTokens}`,
      );
    }

    const currentMaxTokens =
      typeof body.max_tokens === "number" && body.max_tokens > 0
        ? body.max_tokens
        : options.requestedMaxTokens;
    return {
      ...body,
      max_tokens: this.calculateRequestedMaxTokens({
        requestedMaxTokens: currentMaxTokens,
        modelMaxOutputTokens: options.modelMaxOutputTokens,
        contextWindow: options.effectiveContextWindow,
        inputTokenCount: payloadInputTokenCount,
      }),
    };
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
    fetchAttemptBudget?: FetchAttemptBudget;
    config?: NimConfig;
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
      fetchAttemptBudget,
    } = options;
    const config = options.config ?? ConfigManager.getNimConfig();

    const rawInputTokenCount = estimateMessagesTokens(
      messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
    );
    const advertisedMaxInput = model.maxInputTokens;
    const windowBudget = contextWindow - calculateSafetyMargin(contextWindow);
    const effectiveMaxInputTokens = Math.max(1, Math.min(advertisedMaxInput, windowBudget));

    if (rawInputTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Input tokens ${rawInputTokenCount} exceed max ${effectiveMaxInputTokens}. Will attempt context compression.`,
      );
    }

    const generationConfig = config.generation;
    const reasoningConfig = config.reasoning;

    const maxTokensVal = model.maxOutputTokens;
    const modelMaxLimit =
      typeof maxTokensVal === "number" && maxTokensVal > 0
        ? maxTokensVal
        : DEFAULT_MAX_OUTPUT_TOKENS;
    const requestedMaxTokensLimit =
      typeof generationConfig.maxOutputTokens === "number" && generationConfig.maxOutputTokens > 0
        ? Math.min(modelMaxLimit, generationConfig.maxOutputTokens)
        : modelMaxLimit;

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
    const configTemperature = generationConfig.temperature;
    const clampTemperature = (value: number): number => Math.min(2, Math.max(0, value));
    const temperatureVal =
      typeof userTemperature === "number" && Number.isFinite(userTemperature)
        ? clampTemperature(userTemperature)
        : typeof configTemperature === "number"
          ? configTemperature
          : profileTemperature;

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

    const summarizerOptions = {
      apiKey,
      userAgent,
      signal,
      summarizationModel: config.context.summarizationModel,
      fetchAttemptBudget,
      maxHttpRetries: config.network.maxHttpRetries,
    };

    // --- Preflight compaction: proactive compression before hard limit ---
    // When the payload exceeds the threshold (default 85%), compact older
    // turns preemptively to avoid a server-side 400 rejection.
    const compactThreshold = Math.floor(effectiveMaxInputTokens * PREFLIGHT_COMPACT_THRESHOLD);
    if (
      payloadInputTokenCount > compactThreshold &&
      payloadInputTokenCount <= effectiveMaxInputTokens
    ) {
      debugLog(
        "contextCompression",
        `Preflight: ${payloadInputTokenCount} tokens >= ${compactThreshold} threshold (${(PREFLIGHT_COMPACT_THRESHOLD * 100).toFixed(0)}%). Compacting proactively...`,
      );
      const result = await compactAndFit({
        messages: apiMessages,
        effectiveMaxInputTokens,
        toolDefinitionTokens,
        allowTruncation: false,
        summarizationOptions: summarizerOptions,
      });
      apiMessages = result.messages;
      payloadInputTokenCount = result.tokenCount;
      debugLog(
        "contextCompression",
        `Preflight compaction: ${result.tokenCount} tokens (was ${apiTokenCount + toolDefinitionTokens}).`,
      );
    }

    // --- Hard limit: reactive compression when over budget ---
    if (payloadInputTokenCount > effectiveMaxInputTokens) {
      debugLog(
        "contextCompression",
        `Prepared payload ${payloadInputTokenCount} tokens > ${effectiveMaxInputTokens} max. Compressing...`,
      );
      const result = await compactAndFit({
        messages: apiMessages,
        effectiveMaxInputTokens,
        toolDefinitionTokens,
        allowTruncation: true,
        summarizationOptions: summarizerOptions,
      });
      apiMessages = result.messages;
      payloadInputTokenCount = result.tokenCount;
      debugLog(
        "contextCompression",
        `Hard-limit compaction: ${result.tokenCount} tokens. Truncated: ${result.truncated}`,
      );

      if (!result.fits) {
        throw createStructuredError(
          "token_limit",
          `Even after compression and truncation: ${payloadInputTokenCount} tokens, max: ${effectiveMaxInputTokens}`,
        );
      }
    }

    apiTokenCount = estimateNimMessagesTokens(apiMessages);
    payloadInputTokenCount = apiTokenCount + toolDefinitionTokens;
    if (payloadInputTokenCount > effectiveMaxInputTokens) {
      throw createStructuredError(
        "token_limit",
        `Prepared payload exceeds context after compression: ${payloadInputTokenCount} tokens, max: ${effectiveMaxInputTokens}`,
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
      reasoningMode = reasoningConfig.mode;
    }
    reasoningMode ??= "none";

    if (modes && modes.length > 0 && !modes.includes(reasoningMode)) {
      const effortModes = modes.filter((mode) => mode !== "none");
      reasoningMode = effortModes[0] ?? modes[0];
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
    const profileTopP = requestProfile.defaultTopP;
    if (typeof modelOpts?.top_p === "number") {
      requestBody.top_p = Math.min(1, Math.max(0, modelOpts.top_p));
    } else if (typeof generationConfig.topP === "number") {
      requestBody.top_p = Math.min(1, Math.max(0, generationConfig.topP));
    } else if (typeof profileTopP === "number") {
      requestBody.top_p = Math.min(1, Math.max(0, profileTopP));
    }
    const profileFrequencyPenalty = requestProfile.defaultFrequencyPenalty;
    const profilePresencePenalty = requestProfile.defaultPresencePenalty;
    const supportsFrequencyPenalty = adapter.supportsFrequencyPenalty !== false;
    const supportsPresencePenalty = adapter.supportsPresencePenalty !== false;
    const supportsRepetitionPenalty = adapter.supportsRepetitionPenalty !== false;

    if (supportsFrequencyPenalty) {
      if (typeof modelOpts?.frequency_penalty === "number") {
        requestBody.frequency_penalty = Math.min(2, Math.max(-2, modelOpts.frequency_penalty));
      } else if (typeof generationConfig.frequencyPenalty === "number") {
        requestBody.frequency_penalty = Math.min(
          2,
          Math.max(-2, generationConfig.frequencyPenalty),
        );
      } else if (typeof profileFrequencyPenalty === "number") {
        requestBody.frequency_penalty = Math.min(2, Math.max(-2, profileFrequencyPenalty));
      }
    }
    if (supportsPresencePenalty) {
      if (typeof modelOpts?.presence_penalty === "number") {
        requestBody.presence_penalty = Math.min(2, Math.max(-2, modelOpts.presence_penalty));
      } else if (typeof generationConfig.presencePenalty === "number") {
        requestBody.presence_penalty = Math.min(2, Math.max(-2, generationConfig.presencePenalty));
      } else if (typeof profilePresencePenalty === "number") {
        requestBody.presence_penalty = Math.min(2, Math.max(-2, profilePresencePenalty));
      }
    }
    if (supportsRepetitionPenalty) {
      if (typeof modelOpts?.repetition_penalty === "number") {
        requestBody.repetition_penalty = Math.min(2, Math.max(0.5, modelOpts.repetition_penalty));
      } else if (typeof generationConfig.repetitionPenalty === "number") {
        requestBody.repetition_penalty = Math.min(
          2,
          Math.max(0.5, generationConfig.repetitionPenalty),
        );
      }
    }
    const stopVal = modelOpts?.stop;
    if (typeof stopVal === "string" && stopVal.length > 0 && stopVal.length <= 256) {
      requestBody.stop = stopVal;
    } else if (Array.isArray(stopVal) && stopVal.length > 0) {
      const stops = stopVal
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .slice(0, 8)
        .map((item) => item.slice(0, 256));
      if (stops.length > 0) {
        requestBody.stop = stops;
      }
    }

    if (toolConfig.tools) {
      requestBody.tools = toolConfig.tools;
    }
    if (toolConfig.tool_choice) {
      requestBody.tool_choice = toolConfig.tool_choice;
    }

    debugLog("Outgoing request messages", requestBody.messages, "messages");

    const safetyMargin = calculateSafetyMargin(contextWindow);
    const remainingBudget = Math.max(
      0,
      contextWindow - payloadInputTokenCount - requestedMaxTokens - safetyMargin,
    );
    const utilizationPercent =
      contextWindow > 0 ? ((payloadInputTokenCount / contextWindow) * 100).toFixed(1) : "0";
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
