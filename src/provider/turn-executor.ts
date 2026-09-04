import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelResponsePart,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { createStructuredError, NvidiaApiError, parseContextOverflowDetail } from "../api/errors";
import { getApiKeyFingerprint } from "../api/key-resolver";
import { estimateNimMessagesTokensByCategory, estimateToolsTokens } from "../messages/converter";
import { getModelAdapter } from "../models/adapters";
import { NimConfig } from "../shared/config";
import { isCancellation } from "../shared/cancellation";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { FetchAttemptBudget, httpAttemptsFromConfig } from "../shared/fetch-attempt-budget";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { StatusBarManager, TokenBreakdown } from "../shared/status-bar";
import { recordTurnReport, TurnReportOutcome } from "../shared/turn-report";
import { NimChatMessage, NimChatRequest, NimTool } from "../types";
import { evaluateAttemptRetry, isLoopRetryReason } from "./attempt-retry";
import { ContextLimitStore } from "./context-limit-store";
import { buildLoopBreakerNudge, injectHistoryLoopBreaker } from "./loop-breaker";
import { buildOverflowRetryRequest } from "./overflow-compactor";
import { NimRequestBuilder } from "./request-builder";
import { appendChatMessage, cloneNimChatRequest } from "./request-snapshot";
import { NimStreamUsage, runStreamAttempt, StreamAttemptResult } from "./stream-pump";

export interface ModelTurnReportState {
  hasReportedContent: boolean;
  hasReportedVisibleContent: boolean;
  failingAttemptHasVisibleContent: boolean;
}

export type ChatRuntimeMetadataSource = "cache" | "selected-model" | "fetched-model";

export interface ChatRuntimeInfo {
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  runtimeMetadataSource: ChatRuntimeMetadataSource;
}

export interface ModelTurnInput {
  model: LanguageModelChatInformation;
  messages: readonly LanguageModelChatMessage[];
  options: ProvideLanguageModelChatResponseOptions;
  progress: Progress<LanguageModelResponsePart>;
  token: CancellationToken;
  abortController: AbortController;
  fetchBudget: FetchAttemptBudget;
  reportState: ModelTurnReportState;
  apiKey: string;
  runtimeInfo: ChatRuntimeInfo;
  nimConfig: NimConfig;
  onOverflowCompaction?: (modelLabel: string) => void;
}

function isTransientStreamError(err: unknown): boolean {
  if (err instanceof NvidiaApiError) {
    return err.kind === "network_error" || err.kind === "server_error";
  }
  return err instanceof Error && err.name === "TypeError";
}

const INVALID_TOOL_EXHAUSTION_OPERATION = "invalid_tool_call";

function createInvalidToolExhaustionError(
  modelLabel: string,
  retryCount: number,
  skippedNames: readonly string[],
): NvidiaApiError {
  return createStructuredError(
    "empty_stream",
    [
      `Model: ${modelLabel}`,
      `The model kept emitting a tool call that could not be executed after ${retryCount} retry(ies).`,
      skippedNames.length > 0 ? `Skipped: ${skippedNames.join(", ")}` : null,
      "The request will be retried on a fallback model if failover is enabled.",
    ]
      .filter(Boolean)
      .join("\n"),
    { operation: INVALID_TOOL_EXHAUSTION_OPERATION },
  );
}

function errorFields(error: unknown): { errorKind?: string; errorMessage?: string } {
  if (error instanceof NvidiaApiError) {
    return { errorKind: error.kind, errorMessage: error.message };
  }
  if (error instanceof Error) {
    return { errorKind: error.name, errorMessage: error.message };
  }
  if (error === undefined) {
    return {};
  }
  return { errorKind: "unknown", errorMessage: String(error) };
}

function recordAttemptTurn(options: {
  outcome: TurnReportOutcome;
  modelId: string;
  body?: NimChatRequest;
  result?: StreamAttemptResult;
  durationMs?: number;
  autoContinueFired?: boolean;
  retryReasonHistory?: readonly string[];
  error?: unknown;
}): void {
  const { errorKind, errorMessage } = errorFields(options.error);
  recordTurnReport({
    outcome: options.outcome,
    modelId: options.modelId,
    requestBody: options.body,
    sawToolCall: options.result?.sawToolCall,
    emittedToolCall: options.result?.emittedToolCall,
    skippedToolCalls: options.result?.skippedToolCalls,
    finishReason: options.result?.lastFinishReason,
    streamChunkCount: options.result?.streamChunkCount,
    lastVisibleText: options.result?.lastVisibleText,
    durationMs: options.durationMs,
    repetitionTripped: options.result?.repetitionTripped,
    autoContinueFired: options.autoContinueFired,
    retryReasonHistory: options.retryReasonHistory,
    errorKind,
    errorMessage,
  });
}

function createUsageDataPart(
  usage: NimStreamUsage | undefined,
): vscode.LanguageModelDataPart | undefined {
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  if (
    typeof promptTokens !== "number" &&
    typeof completionTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  if (typeof vscode.LanguageModelDataPart?.json !== "function") {
    return undefined;
  }
  const payload = {
    ...(typeof promptTokens === "number" ? { prompt_tokens: promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { completion_tokens: completionTokens } : {}),
    ...(typeof totalTokens === "number" ? { total_tokens: totalTokens } : {}),
  };
  try {
    return vscode.LanguageModelDataPart.json(payload, "usage");
  } catch {
    return undefined;
  }
}

export class ModelTurnExecutor {
  constructor(
    private readonly userAgent: string,
    private readonly contextLimitStore: ContextLimitStore,
    private readonly statusBar?: StatusBarManager,
  ) {}

  public async executeTurn(input: ModelTurnInput): Promise<void> {
    const {
      model,
      messages,
      options,
      progress,
      token,
      abortController,
      fetchBudget,
      reportState,
      apiKey,
      runtimeInfo,
      nimConfig,
    } = input;

    let hasReportedVisibleContent = false;
    let sawToolCallOverall = false;
    const contextWindow = runtimeInfo.contextWindow;
    const supportsVision = runtimeInfo.supportsVision;
    const supportsTools = runtimeInfo.supportsTools;
    const runtimeMetadataSource = runtimeInfo.runtimeMetadataSource;

    const keyFingerprint = getApiKeyFingerprint(apiKey);
    const runtimeLimit = this.contextLimitStore.get(model.id, keyFingerprint);
    let effectiveContextWindow =
      runtimeLimit !== undefined ? Math.min(contextWindow, runtimeLimit) : contextWindow;
    let streamModel = model;
    let streamMaxOutputTokens = model.maxOutputTokens;

    if (NimRequestBuilder.hasImageInput(messages) && !supportsVision) {
      throw createStructuredError(
        "model_unavailable",
        "The selected NVIDIA NIM model does not support image input.",
      );
    }

    const requestPreparationStartedAtMs = debugEnabled() ? Date.now() : undefined;
    let activeRequestBody: NimChatRequest | undefined;
    let tools: NimTool[] | undefined;
    let hasRetriedContextOverflow = false;
    let reasoningIsolationExpected = false;
    let totalAttempts = 0;
    const generationConfig = nimConfig.generation;
    const parseEmbeddedToolText = getModelAdapter(model.id).toolCallProtocol !== "native-only";

    const markReported = (result: StreamAttemptResult): void => {
      if (result.reportedContent) {
        reportState.hasReportedContent = true;
      }
      if (result.reportedVisibleContent) {
        hasReportedVisibleContent = true;
        reportState.hasReportedVisibleContent = true;
      }
      if (result.sawToolCall) {
        sawToolCallOverall = true;
      }
    };

    try {
      const prepared = await NimRequestBuilder.prepareRequest({
        model,
        messages,
        options,
        contextWindow: effectiveContextWindow,
        supportsTools,
        supportsVision,
        apiKey,
        userAgent: this.userAgent,
        signal: abortController.signal,
        fetchAttemptBudget: fetchBudget,
        config: nimConfig,
      });

      activeRequestBody = prepared.requestBody;
      reasoningIsolationExpected = prepared.reasoningIsolationExpected;
      tools = prepared.tools;
      const inputTokenCount = prepared.inputTokenCount;
      const requestedMaxTokens = prepared.requestedMaxTokens;
      const temperatureVal = prepared.temperatureVal;
      const toolsEnabled = prepared.toolsEnabled;

      const applyBudget = (body: NimChatRequest): NimChatRequest =>
        NimRequestBuilder.applyRequestBudget(body, {
          tools,
          effectiveContextWindow,
          modelMaxOutputTokens:
            typeof streamMaxOutputTokens === "number" && streamMaxOutputTokens > 0
              ? streamMaxOutputTokens
              : typeof streamModel.maxOutputTokens === "number" && streamModel.maxOutputTokens > 0
                ? streamModel.maxOutputTokens
                : DEFAULT_MAX_OUTPUT_TOKENS,
          requestedMaxTokens,
          safetyMarginPercent: nimConfig.context.safetyMarginPercent,
        });

      let baselineRequestBody = injectHistoryLoopBreaker({
        requestBody: cloneNimChatRequest(activeRequestBody),
        historyMessages: messages,
        modelId: model.id,
        applyBudget,
      });
      const retryReasonHistory: string[] = [];
      let requestPreparationDurationMs: number | undefined;
      let toolParsingStateInitDurationMs: number | undefined;
      let finalUsage: NimStreamUsage | undefined;
      let everSawReasoning = false;
      let lastFinishReasonOverall: string | null | undefined = undefined;
      const networkConfig = nimConfig.network;
      const fallbackConfig = nimConfig.fallback;
      const toolsConfig = nimConfig.tools;
      const MAX_NETWORK_RETRIES = httpAttemptsFromConfig(networkConfig.maxHttpRetries);
      const MAX_EMPTY_STREAM_RETRIES = networkConfig.maxEmptyStreamRetries;
      const MAX_INVALID_TOOL_RETRIES = MAX_EMPTY_STREAM_RETRIES;
      const streamHttpAttempts = MAX_NETWORK_RETRIES;
      const attemptSafetyCap =
        1 + MAX_EMPTY_STREAM_RETRIES + MAX_NETWORK_RETRIES + MAX_INVALID_TOOL_RETRIES + 2;

      const firstTokenTimeoutMs =
        typeof fallbackConfig.firstTokenTimeoutSeconds === "number" &&
        fallbackConfig.firstTokenTimeoutSeconds > 0
          ? fallbackConfig.firstTokenTimeoutSeconds * 1000
          : undefined;

      const emitUsageAndStatus = (
        usage: NimStreamUsage | undefined,
        body: NimChatRequest,
      ): void => {
        const usagePart = createUsageDataPart(usage);
        if (usagePart) {
          progress.report(usagePart);
        }
        if (this.statusBar) {
          const shortName = model.name ?? model.id.split("/").at(-1) ?? model.id;
          const sentTools = body.tools ?? tools;
          const categoryBreakdown = estimateNimMessagesTokensByCategory(body.messages);
          const toolsTokens = sentTools ? estimateToolsTokens(sentTools) : 0;
          const breakdown: TokenBreakdown = {
            modelName: shortName,
            systemPrompt: categoryBreakdown.system,
            tools: toolsTokens,
            userMessages: categoryBreakdown.user,
            assistantMessages: categoryBreakdown.assistant,
            toolCalls: categoryBreakdown.toolCalls,
            toolResults: categoryBreakdown.toolResults,
            images: categoryBreakdown.images,
            actualPromptTokens: usage?.prompt_tokens,
            actualCompletionTokens: usage?.completion_tokens,
            output: usage?.completion_tokens,
            contextWindow,
          };
          this.statusBar.showTokenBreakdown(breakdown);
        }
      };

      const collectKnownToolNames = (): Set<string> => {
        const knownToolNames = new Set<string>();
        for (const tool of tools ?? []) {
          if (tool.function.name) {
            knownToolNames.add(tool.function.name);
          }
        }
        for (const tool of options.tools ?? []) {
          if (typeof tool.name === "string" && tool.name.length > 0) {
            knownToolNames.add(tool.name);
          }
        }
        return knownToolNames;
      };

      let restartFromOverflow = true;
      while (restartFromOverflow) {
        restartFromOverflow = false;
        let retryNudge: NimChatMessage | undefined;
        let lastRetryReason: "invalid_tool_call" | undefined;
        let lastInvalidToolSkipNames: string[] = [];
        let transientRetryCount = 0;
        let lastTransientError: unknown;
        let emptyStreamRetryCount = 0;
        let hasRetriedRepetitionLoop = false;
        let invalidToolRetryCount = 0;
        let attemptCompleted = false;

        for (let attempt = 0; attempt < attemptSafetyCap; attempt += 1) {
          totalAttempts += 1;
          finalUsage = undefined;
          const attemptStartedAtMs = Date.now();
          if (
            requestPreparationDurationMs === undefined &&
            requestPreparationStartedAtMs !== undefined
          ) {
            requestPreparationDurationMs = attemptStartedAtMs - requestPreparationStartedAtMs;
          }

          const allocated = fetchBudget.consume(streamHttpAttempts);
          if (allocated <= 0) {
            break;
          }

          let attemptBody = cloneNimChatRequest(baselineRequestBody);
          if (retryNudge) {
            attemptBody = appendChatMessage(attemptBody, retryNudge);
            try {
              attemptBody = applyBudget(attemptBody);
            } catch {
              debugLog("streamRetry", "retry nudge dropped: context budget exceeded");
              if (lastRetryReason === "invalid_tool_call") {
                reportState.failingAttemptHasVisibleContent = false;
                throw createInvalidToolExhaustionError(
                  model.name ?? model.id,
                  invalidToolRetryCount,
                  lastInvalidToolSkipNames,
                );
              }
              break;
            }
          }
          activeRequestBody = attemptBody;

          let result: StreamAttemptResult;
          let thisAttemptReportedContent = false;
          let thisAttemptReportedVisibleContent = false;
          try {
            result = await runStreamAttempt({
              apiKey,
              requestBody: attemptBody,
              signal: abortController.signal,
              userAgent: this.userAgent,
              token,
              progress,
              model: streamModel,
              options,
              messages,
              reasoningIsolationExpected,
              maxFetchAttempts: allocated,
              firstTokenTimeoutMs,
              maxRepeatedLines: generationConfig.maxRepeatedLines,
              autoContinueOnLoop: generationConfig.autoContinueOnLoop,
              idleTimeoutMs: networkConfig.streamIdleTimeout * 1000,
              toolsConfig: toolsConfig,
              showReasoningInChat: nimConfig.reasoning.showInChat,
              hasRetriedRepetitionLoop,
              parseEmbeddedToolText,
              onContentReported: () => {
                thisAttemptReportedContent = true;
              },
              onVisibleContentReported: () => {
                thisAttemptReportedVisibleContent = true;
              },
            });
          } catch (streamErr) {
            const cancelled = isCancellation(streamErr, token);
            const isNetworkError =
              (streamErr instanceof NvidiaApiError && streamErr.kind === "network_error") ||
              (streamErr instanceof Error && streamErr.name === "TypeError");
            const isServerError =
              streamErr instanceof NvidiaApiError && streamErr.kind === "server_error";
            const willTransientRetry =
              !cancelled &&
              !abortController.signal.aborted &&
              isTransientStreamError(streamErr) &&
              !thisAttemptReportedContent &&
              transientRetryCount < MAX_NETWORK_RETRIES;

            reportState.failingAttemptHasVisibleContent = thisAttemptReportedVisibleContent;

            recordAttemptTurn({
              outcome: cancelled ? "cancelled" : willTransientRetry ? "retry" : "error",
              modelId: model.id,
              body: attemptBody,
              durationMs: Date.now() - attemptStartedAtMs,
              retryReasonHistory,
              error: streamErr,
            });

            if (willTransientRetry) {
              lastTransientError = streamErr;
              transientRetryCount += 1;
              debugLog(
                "streamRetry",
                `${isServerError ? "Server" : "Network"} error during stream (retry ${transientRetryCount}/${MAX_NETWORK_RETRIES}): ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
              );
              if (isNetworkError) {
                retryNudge = {
                  role: "user",
                  content:
                    "Your previous response was interrupted by a network error. Please start over and provide a complete response.",
                };
              }
              continue;
            }

            if (
              !thisAttemptReportedContent &&
              !hasRetriedContextOverflow &&
              streamErr instanceof NvidiaApiError &&
              (streamErr.kind === "context_overflow" || streamErr.kind === "token_limit") &&
              Boolean(apiKey) &&
              Boolean(attemptBody) &&
              nimConfig.context.autoCompactOnOverflow
            ) {
              const overflowApplied = await this.applyOverflowCompaction({
                err: streamErr,
                model: streamModel,
                messages,
                activeRequestBody: attemptBody,
                supportsVision,
                contextWindow,
                keyFingerprint,
                apiKey,
                abortController,
                fetchBudget,
                summarizationModel: nimConfig.context.summarizationModel,
                maxHttpRetries: nimConfig.network.maxHttpRetries,
                safetyMarginPercent: nimConfig.context.safetyMarginPercent,
              });
              hasRetriedContextOverflow = true;
              if (overflowApplied) {
                baselineRequestBody = overflowApplied.requestBody;
                activeRequestBody = overflowApplied.requestBody;
                streamMaxOutputTokens = overflowApplied.compactedMaxOutput;
                streamModel = {
                  ...streamModel,
                  maxOutputTokens: overflowApplied.compactedMaxOutput,
                };
                if (overflowApplied.retryContextWindow > 0) {
                  effectiveContextWindow = Math.min(
                    contextWindow,
                    overflowApplied.retryContextWindow,
                  );
                }
                retryReasonHistory.push("context_overflow_compaction");
                input.onOverflowCompaction?.(model.name ?? model.id);
                restartFromOverflow = true;
                break;
              }

              throw createStructuredError(
                streamErr.kind === "token_limit" ? "token_limit" : "context_overflow",
                [
                  `Model: ${model.name ?? model.id}`,
                  "History compaction did not produce a smaller request.",
                  "Start a new chat or reduce attachments, then try again.",
                ].join("\n"),
                {
                  status: streamErr.status,
                  contextOverflow: streamErr.contextOverflow,
                },
              );
            }

            throw streamErr;
          }

          markReported(result);
          finalUsage = result.lastUsage;
          if (result.sawReasoning) {
            everSawReasoning = true;
          }
          if (result.lastFinishReason !== undefined) {
            lastFinishReasonOverall = result.lastFinishReason;
          }
          if (
            toolParsingStateInitDurationMs === undefined &&
            result.toolParsingStateInitDurationMs !== undefined
          ) {
            toolParsingStateInitDurationMs = result.toolParsingStateInitDurationMs;
          }

          const evaluation = evaluateAttemptRetry({
            result,
            toolsEnabled,
            generationAutoContinueOnLoop: generationConfig.autoContinueOnLoop,
            autoRetryInvalidCalls: toolsConfig.autoRetryInvalidCalls,
            hasRetriedRepetitionLoop,
            attemptIndex: attempt,
            invalidToolRetryCount,
            emptyStreamRetryCount,
            maxEmptyStreamRetries: MAX_EMPTY_STREAM_RETRIES,
            maxInvalidToolRetries: MAX_INVALID_TOOL_RETRIES,
            fetchBudgetExhausted: fetchBudget.exhausted,
            knownToolNames: collectKnownToolNames(),
          });
          const { retryReason, retryMessage, skippedToolCallNames } = evaluation;

          if (result.firstResponseAtMs !== undefined) {
            const totalDurationMs = Date.now() - attemptStartedAtMs;
            const generationDurationMs = Math.max(
              0,
              totalDurationMs - (result.firstResponseAtMs - attemptStartedAtMs),
            );
            const promptTokens = result.lastUsage?.prompt_tokens;
            const completionTokens = result.lastUsage?.completion_tokens;
            const totalTokens = result.lastUsage?.total_tokens;
            debugLog("stream timing", {
              attempt: attempt + 1,
              totalAttempts,
              ...(requestPreparationDurationMs !== undefined
                ? { requestPreparationDurationMs }
                : {}),
              ...(toolParsingStateInitDurationMs !== undefined
                ? { toolParsingStateInitDurationMs }
                : {}),
              ...(retryReasonHistory.length > 0
                ? { retryReasonHistory: [...retryReasonHistory] }
                : {}),
              model: model.id,
              inputTokenCount,
              requestedMaxTokens,
              temperature: temperatureVal,
              toolsEnabled,
              runtimeMetadataSource,
              isRetryAttempt: attempt > 0,
              willRetryAfterInvalidToolCall: retryReason === "invalid_tool_call",
              skippedToolCallCount: result.skippedToolCalls.length,
              ...(skippedToolCallNames.length > 0 ? { skippedToolCallNames } : {}),
              ...(lastRetryReason || retryReason
                ? { retryReason: lastRetryReason ?? retryReason }
                : {}),
              firstTokenLatencyMs: result.firstResponseAtMs - attemptStartedAtMs,
              ...(result.firstToolCallAtMs !== undefined
                ? { firstToolCallLatencyMs: result.firstToolCallAtMs - attemptStartedAtMs }
                : {}),
              totalDurationMs,
              generationDurationMs,
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...(completionTokens !== undefined && generationDurationMs > 0
                ? {
                    completionTokensPerSecond: Number(
                      (completionTokens / (generationDurationMs / 1000)).toFixed(2),
                    ),
                  }
                : {}),
              reportedContent: result.reportedContent,
              reportedVisibleContent: result.reportedVisibleContent,
              emittedToolCall: result.emittedToolCall,
              sawReasoning: result.sawReasoning,
              lastFinishReason: result.lastFinishReason,
              streamChunkCount: result.streamChunkCount,
              willRetryEmptyStream: retryReason === "empty_stream",
              willRetryOnLoop: isLoopRetryReason(retryReason),
              willRetryContentFilter: retryReason === "content_filter",
              skippedUnknownTool: evaluation.skippedUnknownTool,
              isRepetitionLoop: evaluation.isRepetitionLoop,
              isHangingColon: evaluation.isHangingColon,
              hasRetriedRepetitionLoop,
              emptyStreamRetryCount,
            });
          }

          if (result.lastUsage) {
            debugLog("stream usage", result.lastUsage);
          }

          recordAttemptTurn({
            outcome: retryReason !== undefined ? "retry" : "ok",
            modelId: model.id,
            body: attemptBody,
            result,
            durationMs: Date.now() - attemptStartedAtMs,
            autoContinueFired: isLoopRetryReason(retryReason),
            retryReasonHistory,
          });

          if (isLoopRetryReason(retryReason)) {
            hasRetriedRepetitionLoop = true;
            retryReasonHistory.push(retryReason);
            retryNudge = buildLoopBreakerNudge(retryReason);
            debugLog("repetitionGuard", {
              action: "autoContinue",
              trippedLine: result.trippedLine,
              lastVisibleText: result.lastVisibleText,
              reason: retryReason,
            });
            outputLog(
              "repetitionGuard",
              `Auto-continue after ${retryReason === "repetition_loop" ? "repetition loop" : retryReason === "hanging_colon" ? "hanging ':'" : retryReason === "content_filter" ? "content filter" : "truncated output"} on ${model.id}: "${(result.trippedLine ?? result.lastVisibleText).slice(0, 80)}"`,
            );
            baselineRequestBody = appendChatMessage(baselineRequestBody, {
              role: "assistant",
              content: result.lastVisibleText,
            });
            try {
              baselineRequestBody = applyBudget(baselineRequestBody);
            } catch {
              debugLog("streamRetry", "history continuation dropped: context budget exceeded");
              break;
            }
            continue;
          }

          if (retryReason === "invalid_tool_call" && retryMessage) {
            invalidToolRetryCount += 1;
            lastRetryReason = "invalid_tool_call";
            lastInvalidToolSkipNames = skippedToolCallNames;
            retryReasonHistory.push("invalid_tool_call");
            retryNudge = { role: "user", content: retryMessage };
            continue;
          }

          if (
            result.sawToolCall &&
            !result.emittedToolCall &&
            toolsConfig.autoRetryInvalidCalls &&
            retryMessage
          ) {
            reportState.failingAttemptHasVisibleContent = false;
            throw createInvalidToolExhaustionError(
              model.name ?? model.id,
              invalidToolRetryCount,
              skippedToolCallNames,
            );
          }

          if (result.lastFinishReason === "content_filter") {
            if (!result.reportedVisibleContent && !result.sawToolCall && !result.emittedToolCall) {
              throw createStructuredError(
                "invalid_request",
                `NVIDIA NIM filtered the response from ${model.name ?? model.id} before any answer or tool call was produced.`,
              );
            }
            attemptCompleted = true;
            break;
          }

          debugLog("stream finished", {
            attempt: attempt + 1,
            totalAttempts,
            model: model.id,
            reportedContent: result.reportedContent,
            reportedVisibleContent: result.reportedVisibleContent,
            emittedToolCall: result.emittedToolCall,
            sawToolCall: result.sawToolCall,
            sawReasoning: result.sawReasoning,
            lastFinishReason: result.lastFinishReason,
            streamChunkCount: result.streamChunkCount,
            willRetryAfterInvalidToolCall: retryReason === "invalid_tool_call",
            willRetryEmptyStream: retryReason === "empty_stream",
            willRetryOnLoop: isLoopRetryReason(retryReason),
            isRepetitionLoop: evaluation.isRepetitionLoop,
            isHangingColon: evaluation.isHangingColon,
            isTruncatedLength: evaluation.isTruncatedLength,
            emptyStreamRetryCount,
          });

          if (retryReason === "empty_stream") {
            emptyStreamRetryCount += 1;
            retryReasonHistory.push("empty_stream");
            retryNudge = undefined;
            debugLog(
              "emptyStreamRetry",
              `Empty stream (no text/tool/reasoning surfaced); retry ${emptyStreamRetryCount}/${MAX_EMPTY_STREAM_RETRIES}. lastFinishReason=${String(result.lastFinishReason)}, chunks=${result.streamChunkCount}`,
            );
            continue;
          }
          attemptCompleted = true;
          break;
        }

        if (restartFromOverflow) {
          continue;
        }
        if (!attemptCompleted && lastTransientError) {
          throw lastTransientError;
        }
        break;
      }

      if (!hasReportedVisibleContent && !sawToolCallOverall) {
        const emptyError = createStructuredError(
          "empty_stream",
          [
            `Model: ${model.name ?? model.id}`,
            `Attempts: ${totalAttempts}`,
            everSawReasoning
              ? "The model emitted reasoning but no visible answer or tool call."
              : "The model returned no text, tool call, or reasoning.",
            lastFinishReasonOverall !== undefined
              ? `Last finish_reason: ${String(lastFinishReasonOverall)}`
              : null,
            "Try again, reduce reasoning effort, or switch to a different model.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        recordAttemptTurn({
          outcome: "error",
          modelId: model.id,
          body: activeRequestBody,
          error: emptyError,
        });
        throw emptyError;
      }

      emitUsageAndStatus(finalUsage, activeRequestBody!);
    } catch (err) {
      const cancelled = isCancellation(err, token);
      if (totalAttempts === 0) {
        recordAttemptTurn({
          outcome: cancelled ? "cancelled" : "error",
          modelId: model.id,
          body: activeRequestBody,
          error: err,
        });
      }
      if (cancelled) {
        throw new vscode.CancellationError();
      }

      throw err;
    }
  }

  private async applyOverflowCompaction(input: {
    err: NvidiaApiError;
    model: LanguageModelChatInformation;
    messages: readonly LanguageModelChatMessage[];
    activeRequestBody: NimChatRequest;
    supportsVision: boolean;
    contextWindow: number;
    keyFingerprint: string | undefined;
    apiKey: string;
    abortController: AbortController;
    fetchBudget: FetchAttemptBudget;
    summarizationModel: string;
    maxHttpRetries: number;
    safetyMarginPercent: number;
  }): Promise<
    | {
        requestBody: NimChatRequest;
        compactedMaxOutput: number;
        retryContextWindow: number;
      }
    | undefined
  > {
    const overflowInfo =
      input.err.contextOverflow ??
      (input.err.status === 400 ? parseContextOverflowDetail(input.err.message) : {});
    const reportedMax = overflowInfo.reportedMaximum;
    debugLog("contextOverflow", {
      model: input.model.id,
      reportedMax,
      actualUsage: overflowInfo.actualUsage,
      catalogContextWindow: input.contextWindow,
    });

    if (
      typeof reportedMax === "number" &&
      reportedMax > 0 &&
      reportedMax < input.contextWindow &&
      input.keyFingerprint
    ) {
      this.contextLimitStore.set(
        input.model.id,
        reportedMax,
        input.keyFingerprint,
        input.contextWindow,
      );
    }

    const retryContextWindow =
      typeof reportedMax === "number" && reportedMax > 0 && reportedMax < input.contextWindow
        ? reportedMax
        : input.contextWindow;

    try {
      const compacted = await buildOverflowRetryRequest({
        messages: input.messages,
        activeRequestBody: input.activeRequestBody,
        supportsVision: input.supportsVision,
        retryContextWindow,
        apiKey: input.apiKey,
        userAgent: this.userAgent,
        signal: input.abortController.signal,
        fetchAttemptBudget: input.fetchBudget,
        summarizationModel: input.summarizationModel,
        maxHttpRetries: input.maxHttpRetries,
        safetyMarginPercent: input.safetyMarginPercent,
      });
      if (!compacted) {
        return undefined;
      }
      return {
        requestBody: compacted.requestBody,
        compactedMaxOutput: compacted.compactedMaxOutput,
        retryContextWindow,
      };
    } catch (compactErr) {
      if (compactErr instanceof Error && compactErr.name === "AbortError") {
        throw new vscode.CancellationError();
      }
      if (
        compactErr instanceof NvidiaApiError &&
        compactErr.kind !== "context_overflow" &&
        compactErr.kind !== "token_limit"
      ) {
        throw compactErr;
      }
      debugLog("contextOverflow", {
        action: "compactionFailed",
        error: compactErr instanceof Error ? compactErr.message : String(compactErr),
      });
      return undefined;
    }
  }
}
