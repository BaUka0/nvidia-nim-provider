import * as vscode from "vscode";
import { NimConfig } from "../shared/config";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { calculateSafetyMargin } from "../shared/config";
import { FetchAttemptBudget } from "../shared/fetch-attempt-budget";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateNimMessagesTokens,
  estimateToolsTokens,
  LegacyPart,
} from "../messages/converter";
import { getModelAdapter, ModelAdapter, isReasoningIsolationExpected } from "../models/adapters";
import { compactAndFit } from "../models/summarizer";
import { createStructuredError } from "../api/errors";
import { debugLog } from "../shared/logging";
import { NimChatRequest, NimChatMessage, NimTool } from "../types";

export interface PreparedRequest {
  requestBody: NimChatRequest;
  reasoningIsolationExpected: boolean;
  inputTokenCount: number;
  requestedMaxTokens: number;
  temperatureVal: number;
  toolsEnabled: boolean;
  tools?: NimTool[];
}

/**
 * When the prepared payload exceeds this fraction of the effective input budget,
 * proactively compact older turns before the hard limit is reached.  This
 * avoids the server rejecting the request outright and gives the user a
 * smoother experience in long conversations.
 */
const PREFLIGHT_COMPACT_THRESHOLD = 0.85;

/** Clamp a sampling parameter into the API-allowed inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

  /**
   * Shared VS Code → NIM message conversion: adapter workarounds plus the
   * profile's extra system messages. Used by request preparation and by
   * overflow compaction so both paths build identical payloads.
   */
  public static convertMessagesWithProfile(input: {
    messages: readonly vscode.LanguageModelChatMessage[];
    adapter: ModelAdapter;
    contextWindow: number;
    supportsVision: boolean;
    toolsEnabled: boolean;
  }): NimChatMessage[] {
    const extraSystemMessages = input.adapter.getProfile({
      toolsEnabled: input.toolsEnabled,
    }).extraSystemMessages;
    let apiMessages = convertMessages(Array.from(input.messages), {
      maxToolResultChars: this.calculateMaxToolResultChars(input.contextWindow),
      supportsVision: input.supportsVision,
    });
    apiMessages = input.adapter.applyMessagesWorkaround
      ? input.adapter.applyMessagesWorkaround(apiMessages)
      : apiMessages;
    if (extraSystemMessages.length > 0) {
      apiMessages = [
        ...extraSystemMessages.map((content): NimChatMessage => ({ role: "system", content })),
        ...apiMessages,
      ];
    }
    return apiMessages;
  }

  public static calculateRequestedMaxTokens(options: {
    requestedMaxTokens: number;
    modelMaxOutputTokens: number;
    contextWindow: number;
    inputTokenCount: number;
    safetyMarginPercent: number;
  }): number {
    const safetyMargin = calculateSafetyMargin(options.contextWindow, options.safetyMarginPercent);
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
      safetyMarginPercent: number;
    },
  ): NimChatRequest {
    const sentTools = body.tools ?? options.tools;
    const payloadInputTokenCount =
      estimateNimMessagesTokens(body.messages) + (sentTools ? estimateToolsTokens(sentTools) : 0);
    const maximumInputTokens = Math.max(
      1,
      options.effectiveContextWindow -
        calculateSafetyMargin(options.effectiveContextWindow, options.safetyMarginPercent),
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
        safetyMarginPercent: options.safetyMarginPercent,
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
    config: NimConfig;
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
    const config = options.config;

    const rawInputTokenCount = estimateMessagesTokens(
      messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
    );
    const advertisedMaxInput = model.maxInputTokens;
    const windowBudget =
      contextWindow - calculateSafetyMargin(contextWindow, config.context.safetyMarginPercent);
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

    let apiMessages = this.convertMessagesWithProfile({
      messages,
      adapter,
      contextWindow,
      supportsVision,
      toolsEnabled,
    });

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
      safetyMarginPercent: config.context.safetyMarginPercent,
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
      reasoningMode = "none";
    }

    if (adapter.applyReasoningMode) {
      adapter.applyReasoningMode(requestBody, reasoningMode);
    }

    const reasoningIsolationExpected = isReasoningIsolationExpected(adapter, reasoningMode);

    const modelOpts = responseOptions.modelOptions as Record<string, unknown>;
    const profileTopP = requestProfile.defaultTopP;
    if (typeof modelOpts?.top_p === "number") {
      requestBody.top_p = clamp(modelOpts.top_p, 0, 1);
    } else if (typeof generationConfig.topP === "number") {
      requestBody.top_p = clamp(generationConfig.topP, 0, 1);
    } else if (typeof profileTopP === "number") {
      requestBody.top_p = clamp(profileTopP, 0, 1);
    }
    const profileFrequencyPenalty = requestProfile.defaultFrequencyPenalty;
    const profilePresencePenalty = requestProfile.defaultPresencePenalty;
    const supportsFrequencyPenalty = adapter.supportsFrequencyPenalty !== false;
    const supportsPresencePenalty = adapter.supportsPresencePenalty !== false;
    const supportsRepetitionPenalty = adapter.supportsRepetitionPenalty !== false;

    if (supportsFrequencyPenalty) {
      if (typeof modelOpts?.frequency_penalty === "number") {
        requestBody.frequency_penalty = clamp(modelOpts.frequency_penalty, -2, 2);
      } else if (typeof generationConfig.frequencyPenalty === "number") {
        requestBody.frequency_penalty = clamp(generationConfig.frequencyPenalty, -2, 2);
      } else if (typeof profileFrequencyPenalty === "number") {
        requestBody.frequency_penalty = clamp(profileFrequencyPenalty, -2, 2);
      }
    }
    if (supportsPresencePenalty) {
      if (typeof modelOpts?.presence_penalty === "number") {
        requestBody.presence_penalty = clamp(modelOpts.presence_penalty, -2, 2);
      } else if (typeof generationConfig.presencePenalty === "number") {
        requestBody.presence_penalty = clamp(generationConfig.presencePenalty, -2, 2);
      } else if (typeof profilePresencePenalty === "number") {
        requestBody.presence_penalty = clamp(profilePresencePenalty, -2, 2);
      }
    }
    if (supportsRepetitionPenalty) {
      if (typeof modelOpts?.repetition_penalty === "number") {
        requestBody.repetition_penalty = clamp(modelOpts.repetition_penalty, 0.5, 2);
      } else if (typeof generationConfig.repetitionPenalty === "number") {
        requestBody.repetition_penalty = clamp(generationConfig.repetitionPenalty, 0.5, 2);
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

    const safetyMargin = calculateSafetyMargin(contextWindow, config.context.safetyMarginPercent);
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
      temperatureVal,
      toolsEnabled,
      tools: toolConfig.tools,
    };
  }
}
