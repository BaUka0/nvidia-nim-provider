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
import { outputLog } from "../shared/logging";
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

function firstFiniteNumber(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function assignClamped(
  body: NimChatRequest,
  key: "top_p" | "frequency_penalty" | "presence_penalty" | "repetition_penalty",
  sources: readonly unknown[],
  min: number,
  max: number,
): void {
  const value = firstFiniteNumber(sources);
  if (value !== undefined) {
    body[key] = clamp(value, min, max);
  }
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
    const temperatureVal = clamp(
      firstFiniteNumber([userTemperature, generationConfig.temperature, profileTemperature]) ??
        profileTemperature,
      0,
      2,
    );

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

    const compactThreshold = Math.floor(effectiveMaxInputTokens * PREFLIGHT_COMPACT_THRESHOLD);
    if (payloadInputTokenCount > compactThreshold) {
      const overHardLimit = payloadInputTokenCount > effectiveMaxInputTokens;
      debugLog(
        "contextCompression",
        overHardLimit
          ? `Prepared payload ${payloadInputTokenCount} tokens > ${effectiveMaxInputTokens} max. Compressing...`
          : `Preflight: ${payloadInputTokenCount} tokens >= ${compactThreshold} threshold (${(PREFLIGHT_COMPACT_THRESHOLD * 100).toFixed(0)}%). Compacting proactively...`,
      );
      const result = await compactAndFit({
        messages: apiMessages,
        effectiveMaxInputTokens,
        toolDefinitionTokens,
        allowTruncation: overHardLimit,
        summarizationOptions: summarizerOptions,
      });
      apiMessages = result.messages;
      payloadInputTokenCount = result.tokenCount;
      debugLog(
        "contextCompression",
        `${overHardLimit ? "Hard-limit" : "Preflight"} compaction: ${result.tokenCount} tokens. Truncated: ${result.truncated}`,
      );
      if (overHardLimit && !result.fits) {
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
      outputLog(
        "reasoning",
        `Requested reasoning mode "${reasoningMode}" is not supported by ${model.id} (supported: ${modes.join(", ")}). Sending none.`,
      );
      reasoningMode = "none";
    }

    if (adapter.applyReasoningMode) {
      adapter.applyReasoningMode(requestBody, reasoningMode);
    }

    const reasoningIsolationExpected = isReasoningIsolationExpected(adapter, reasoningMode);

    const modelOpts = responseOptions.modelOptions as Record<string, unknown>;
    assignClamped(
      requestBody,
      "top_p",
      [modelOpts?.top_p, generationConfig.topP, requestProfile.defaultTopP],
      0,
      1,
    );
    if (adapter.supportsFrequencyPenalty !== false) {
      assignClamped(
        requestBody,
        "frequency_penalty",
        [
          modelOpts?.frequency_penalty,
          generationConfig.frequencyPenalty,
          requestProfile.defaultFrequencyPenalty,
        ],
        -2,
        2,
      );
    }
    if (adapter.supportsPresencePenalty !== false) {
      assignClamped(
        requestBody,
        "presence_penalty",
        [
          modelOpts?.presence_penalty,
          generationConfig.presencePenalty,
          requestProfile.defaultPresencePenalty,
        ],
        -2,
        2,
      );
    }
    if (adapter.supportsRepetitionPenalty !== false) {
      assignClamped(
        requestBody,
        "repetition_penalty",
        [modelOpts?.repetition_penalty, generationConfig.repetitionPenalty],
        0.5,
        2,
      );
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
