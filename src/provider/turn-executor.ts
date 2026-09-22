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
import { isCancellation, waitForBackoff } from "../shared/cancellation";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";
import { FetchAttemptBudget, httpAttemptsFromConfig } from "../shared/fetch-attempt-budget";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { StatusBarManager, TokenBreakdown } from "../shared/status-bar";
import { recordTurnReport, TurnReportOutcome } from "../shared/turn-report";
import { NimChatRequest, NimTool } from "../types";
import {
  AttemptRetryEvaluation,
  evaluateAttemptRetry,
  isLoopRetryReason,
  isSuppressedDuplicateStall,
} from "./attempt-retry";
import {
  AttemptDispatch,
  AttemptLoopState,
  buildEmptyStreamError,
  createAttemptLoopState,
  logAttemptTiming,
  logLoopAutoContinue,
  logStreamFinished,
  StreamFailureOutcome,
} from "./attempt-loop";
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
        requestBody: activeRequestBody,
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
      const MAX_INVALID_TOOL_RETRIES = Math.min(2, MAX_EMPTY_STREAM_RETRIES);
      const MAX_LOOP_CONTINUES = generationConfig.maxLoopContinues;
      const streamHttpAttempts = MAX_NETWORK_RETRIES;
      const attemptSafetyCap =
        1 +
        MAX_EMPTY_STREAM_RETRIES +
        MAX_NETWORK_RETRIES +
        MAX_INVALID_TOOL_RETRIES +
        MAX_LOOP_CONTINUES;

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
      let repetitionClosedTurn = false;
      let repetitionLoopContinues = 0;
      let duplicateStall = false;
      let duplicateStallTool = "";
      while (restartFromOverflow) {
        restartFromOverflow = false;
        const state = createAttemptLoopState();

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
          if (state.retryNudge) {
            attemptBody = appendChatMessage(attemptBody, state.retryNudge);
            try {
              attemptBody = applyBudget(attemptBody);
            } catch {
              debugLog("streamRetry", "retry nudge dropped: context budget exceeded");
              if (state.lastRetryReason === "invalid_tool_call") {
                reportState.failingAttemptHasVisibleContent = false;
                throw createInvalidToolExhaustionError(
                  model.name ?? model.id,
                  state.invalidToolRetryCount,
                  state.lastInvalidToolSkipNames,
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
              maxLoopContinues: MAX_LOOP_CONTINUES,
              idleTimeoutMs: networkConfig.streamIdleTimeout * 1000,
              toolsConfig: toolsConfig,
              hasRetriedRepetitionLoop: state.loopContinueCount >= MAX_LOOP_CONTINUES,
              parseEmbeddedToolText,
              onContentReported: () => {
                thisAttemptReportedContent = true;
              },
              onVisibleContentReported: () => {
                thisAttemptReportedVisibleContent = true;
              },
            });
          } catch (streamErr) {
            const outcome = await this.handleStreamFailure({
              err: streamErr,
              token,
              abortController,
              reportState,
              attemptReportedContent: thisAttemptReportedContent,
              attemptReportedVisibleContent: thisAttemptReportedVisibleContent,
              attemptBody,
              attemptStartedAtMs,
              retryReasonHistory,
              model,
              streamModel,
              messages,
              supportsVision,
              contextWindow,
              keyFingerprint,
              apiKey,
              fetchBudget,
              nimConfig,
              maxNetworkRetries: MAX_NETWORK_RETRIES,
              hasRetriedContextOverflow,
              onOverflowCompaction: input.onOverflowCompaction,
              state,
            });
            if (outcome.action === "retry") {
              continue;
            }
            hasRetriedContextOverflow = true;
            baselineRequestBody = outcome.requestBody;
            activeRequestBody = outcome.requestBody;
            streamMaxOutputTokens = outcome.compactedMaxOutput;
            streamModel = {
              ...streamModel,
              maxOutputTokens: outcome.compactedMaxOutput,
            };
            if (outcome.retryContextWindow > 0) {
              effectiveContextWindow = Math.min(contextWindow, outcome.retryContextWindow);
            }
            restartFromOverflow = true;
            break;
          }

          markReported(result);
          if (result.toolCallLoopTripped && result.emittedToolCall) {
            // Extra identical calls were already dropped in the aggregator.
            // Finish this attempt so Copilot can run the ones that went out.
            debugLog("repetitionGuard", {
              action: "toolCallLoopStop",
              key: result.toolCallLoopKey,
              emittedToolCall: result.emittedToolCall,
            });
            outputLog(
              "repetitionGuard",
              `Stopped repeating tool call on ${model.id}; keeping already-emitted calls so the turn can continue.`,
            );
          }
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
            loopContinueCount: state.loopContinueCount,
            maxLoopContinues: MAX_LOOP_CONTINUES,
            timeoutRetryCount: state.timeoutContinueCount,
            maxTimeoutRetries: MAX_LOOP_CONTINUES,
            invalidToolRetryCount: state.invalidToolRetryCount,
            emptyStreamRetryCount: state.emptyStreamRetryCount,
            maxEmptyStreamRetries: MAX_EMPTY_STREAM_RETRIES,
            maxInvalidToolRetries: MAX_INVALID_TOOL_RETRIES,
            fetchBudgetExhausted: fetchBudget.exhausted,
            knownToolNames: collectKnownToolNames(),
          });

          const dispatch = this.dispatchAttemptOutcome({
            result,
            evaluation,
            attemptBody,
            model,
            state,
            baselineRequestBody,
            reportState,
            applyBudget,
            attempt,
            totalAttempts,
            attemptStartedAtMs,
            requestPreparationDurationMs,
            toolParsingStateInitDurationMs,
            inputTokenCount,
            requestedMaxTokens,
            temperatureVal,
            toolsEnabled,
            runtimeMetadataSource,
            retryReasonHistory,
            maxEmptyStreamRetries: MAX_EMPTY_STREAM_RETRIES,
          });
          baselineRequestBody = dispatch.baselineRequestBody;
          if (dispatch.action === "continue") {
            continue;
          }
          break;
        }

        if (restartFromOverflow) {
          continue;
        }
        if (!state.attemptCompleted && state.lastTransientError) {
          throw state.lastTransientError;
        }
        repetitionClosedTurn = state.repetitionClosedTurn;
        repetitionLoopContinues = state.loopContinueCount;
        duplicateStall = state.duplicateStall;
        duplicateStallTool = state.duplicateStallTool;
        break;
      }

      if (duplicateStall && !hasReportedVisibleContent) {
        const toolName = duplicateStallTool || "tool";
        progress.report(
          new vscode.LanguageModelTextPart(
            `The ${toolName} call was not run again because that same call already completed earlier in this chat. Use the existing result from earlier in the chat and proceed with the necessary changes or next steps.`,
          ),
        );
        hasReportedVisibleContent = true;
        reportState.hasReportedVisibleContent = true;
        debugLog("duplicateTool", {
          action: "visibleContinuation",
          model: model.id,
          tool: toolName,
        });
      }

      if (!hasReportedVisibleContent && !sawToolCallOverall) {
        if (repetitionClosedTurn) {
          debugLog("repetitionGuard", {
            action: "closeWithoutFallback",
            model: model.id,
            loopContinueCount: repetitionLoopContinues,
          });
          outputLog(
            "repetitionGuard",
            `Repetition loop on ${model.id} used its continue budget with no answer. Staying on this model.`,
          );
          emitUsageAndStatus(finalUsage, activeRequestBody!);
          return;
        }
        const emptyError = buildEmptyStreamError({
          modelLabel: model.name ?? model.id,
          totalAttempts,
          everSawReasoning,
          lastFinishReasonOverall,
        });
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

  /**
   * Recovery policy for a thrown stream attempt: in-turn transient retry with
   * backoff, or server-side context-overflow compaction. Anything else is
   * rethrown so the provider's failover loop can decide.
   */
  private async handleStreamFailure(input: {
    err: unknown;
    token: CancellationToken;
    abortController: AbortController;
    reportState: ModelTurnReportState;
    attemptReportedContent: boolean;
    attemptReportedVisibleContent: boolean;
    attemptBody: NimChatRequest;
    attemptStartedAtMs: number;
    retryReasonHistory: string[];
    model: LanguageModelChatInformation;
    streamModel: LanguageModelChatInformation;
    messages: readonly LanguageModelChatMessage[];
    supportsVision: boolean;
    contextWindow: number;
    keyFingerprint: string | undefined;
    apiKey: string;
    fetchBudget: FetchAttemptBudget;
    nimConfig: NimConfig;
    maxNetworkRetries: number;
    hasRetriedContextOverflow: boolean;
    onOverflowCompaction?: (modelLabel: string) => void;
    state: AttemptLoopState;
  }): Promise<StreamFailureOutcome> {
    const { err: streamErr, token, abortController, reportState, state } = input;

    const cancelled = isCancellation(streamErr, token);
    const isNetworkError =
      (streamErr instanceof NvidiaApiError && streamErr.kind === "network_error") ||
      (streamErr instanceof Error && streamErr.name === "TypeError");
    const isServerError = streamErr instanceof NvidiaApiError && streamErr.kind === "server_error";
    const willTransientRetry =
      !cancelled &&
      !abortController.signal.aborted &&
      isTransientStreamError(streamErr) &&
      !input.attemptReportedContent &&
      state.transientRetryCount < input.maxNetworkRetries;

    reportState.failingAttemptHasVisibleContent = input.attemptReportedVisibleContent;

    recordAttemptTurn({
      outcome: cancelled ? "cancelled" : willTransientRetry ? "retry" : "error",
      modelId: input.model.id,
      body: input.attemptBody,
      durationMs: Date.now() - input.attemptStartedAtMs,
      retryReasonHistory: input.retryReasonHistory,
      error: streamErr,
    });

    if (willTransientRetry) {
      state.lastTransientError = streamErr;
      state.transientRetryCount += 1;
      debugLog(
        "streamRetry",
        `${isServerError ? "Server" : "Network"} error during stream (retry ${state.transientRetryCount}/${input.maxNetworkRetries}): ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
      );
      if (isNetworkError) {
        state.retryNudge = {
          role: "user",
          content:
            "Your previous response was interrupted by a network error. Please start over and provide a complete response.",
        };
      }
      const retryDelayMs = Math.min(1000 * Math.pow(2, state.transientRetryCount - 1), 5000);
      try {
        await waitForBackoff(retryDelayMs, abortController.signal);
      } catch (backoffErr) {
        if (isCancellation(backoffErr, token) || abortController.signal.aborted) {
          throw new vscode.CancellationError();
        }
        throw backoffErr;
      }
      return { action: "retry" };
    }

    if (
      !input.attemptReportedContent &&
      !input.hasRetriedContextOverflow &&
      streamErr instanceof NvidiaApiError &&
      (streamErr.kind === "context_overflow" || streamErr.kind === "token_limit") &&
      Boolean(input.apiKey) &&
      Boolean(input.attemptBody)
    ) {
      const overflowApplied = await this.applyOverflowCompaction({
        err: streamErr,
        model: input.streamModel,
        messages: input.messages,
        activeRequestBody: input.attemptBody,
        supportsVision: input.supportsVision,
        contextWindow: input.contextWindow,
        keyFingerprint: input.keyFingerprint,
        apiKey: input.apiKey,
        abortController: input.abortController,
        fetchBudget: input.fetchBudget,
        summarizationModel: input.nimConfig.context.summarizationModel,
        maxHttpRetries: input.nimConfig.network.maxHttpRetries,
        safetyMarginPercent: input.nimConfig.context.safetyMarginPercent,
      });
      if (overflowApplied) {
        input.retryReasonHistory.push("context_overflow_compaction");
        input.onOverflowCompaction?.(input.model.name ?? input.model.id);
        return {
          action: "restart",
          requestBody: overflowApplied.requestBody,
          compactedMaxOutput: overflowApplied.compactedMaxOutput,
          retryContextWindow: overflowApplied.retryContextWindow,
        };
      }

      throw createStructuredError(
        streamErr.kind === "token_limit" ? "token_limit" : "context_overflow",
        [
          `Model: ${input.model.name ?? input.model.id}`,
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

  /**
   * Decision table for a completed stream attempt: auto-continue, replay with a
   * nudge, fail the turn, or finish. Owns the attempt counters and the history
   * the next attempt is cloned from.
   */
  private dispatchAttemptOutcome(input: {
    result: StreamAttemptResult;
    evaluation: AttemptRetryEvaluation;
    attemptBody: NimChatRequest;
    model: LanguageModelChatInformation;
    state: AttemptLoopState;
    baselineRequestBody: NimChatRequest;
    reportState: ModelTurnReportState;
    applyBudget: (body: NimChatRequest) => NimChatRequest;
    attempt: number;
    totalAttempts: number;
    attemptStartedAtMs: number;
    requestPreparationDurationMs?: number;
    toolParsingStateInitDurationMs?: number;
    inputTokenCount: number;
    requestedMaxTokens: number;
    temperatureVal: number | undefined;
    toolsEnabled: boolean;
    runtimeMetadataSource: ChatRuntimeMetadataSource;
    retryReasonHistory: string[];
    maxEmptyStreamRetries: number;
  }): AttemptDispatch {
    const { result, evaluation, model, state, reportState, applyBudget, retryReasonHistory } =
      input;
    const { retryReason, retryMessage, skippedToolCallNames } = evaluation;
    let baselineRequestBody = input.baselineRequestBody;

    if (result.reportedVisibleContent || result.emittedToolCall) {
      state.emptyStreamRetryCount = 0;
    }

    logAttemptTiming({
      attempt: input.attempt,
      totalAttempts: input.totalAttempts,
      modelId: model.id,
      attemptStartedAtMs: input.attemptStartedAtMs,
      requestPreparationDurationMs: input.requestPreparationDurationMs,
      toolParsingStateInitDurationMs: input.toolParsingStateInitDurationMs,
      retryReasonHistory,
      inputTokenCount: input.inputTokenCount,
      requestedMaxTokens: input.requestedMaxTokens,
      temperatureVal: input.temperatureVal,
      toolsEnabled: input.toolsEnabled,
      runtimeMetadataSource: input.runtimeMetadataSource,
      skippedToolCallNames,
      lastRetryReason: state.lastRetryReason,
      retryReason,
      evaluation,
      result,
      loopContinueCount: state.loopContinueCount,
      emptyStreamRetryCount: state.emptyStreamRetryCount,
    });

    if (result.lastUsage) {
      debugLog("stream usage", result.lastUsage);
    }

    recordAttemptTurn({
      outcome: retryReason !== undefined ? "retry" : "ok",
      modelId: model.id,
      body: input.attemptBody,
      result,
      durationMs: Date.now() - input.attemptStartedAtMs,
      autoContinueFired: isLoopRetryReason(retryReason),
      retryReasonHistory,
    });

    if (isLoopRetryReason(retryReason)) {
      if (retryReason === "stream_timeout") {
        state.timeoutContinueCount += 1;
      } else {
        state.loopContinueCount += 1;
      }
      retryReasonHistory.push(retryReason);
      const reasoningOnlyLoop =
        retryReason === "repetition_loop" && result.sawReasoning && !result.reportedVisibleContent;
      state.retryNudge = reasoningOnlyLoop
        ? buildLoopBreakerNudge(retryReason, { reasoningOnly: true })
        : buildLoopBreakerNudge(retryReason);
      logLoopAutoContinue({
        modelId: model.id,
        retryReason,
        result,
        loopContinueCount:
          retryReason === "stream_timeout" ? state.timeoutContinueCount : state.loopContinueCount,
      });

      const shouldDiscardPartial = retryReason === "repetition_loop";
      if (!shouldDiscardPartial && result.lastVisibleText.trim().length > 0) {
        baselineRequestBody = appendChatMessage(baselineRequestBody, {
          role: "assistant",
          content: result.lastVisibleText,
        });
        try {
          baselineRequestBody = applyBudget(baselineRequestBody);
        } catch {
          debugLog("streamRetry", "history continuation dropped: context budget exceeded");
          return { action: "abort", baselineRequestBody };
        }
      }
      return { action: "continue", baselineRequestBody };
    }

    if (retryReason === "invalid_tool_call" && retryMessage) {
      state.invalidToolRetryCount += 1;
      state.lastRetryReason = "invalid_tool_call";
      state.lastInvalidToolSkipNames = skippedToolCallNames;
      retryReasonHistory.push("invalid_tool_call");
      state.retryNudge = { role: "user", content: retryMessage };
      return { action: "continue", baselineRequestBody };
    }

    if (result.sawToolCall && !result.emittedToolCall && retryMessage) {
      reportState.failingAttemptHasVisibleContent = false;
      throw createInvalidToolExhaustionError(
        model.name ?? model.id,
        state.invalidToolRetryCount,
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
      state.attemptCompleted = true;
      return { action: "complete", baselineRequestBody };
    }

    logStreamFinished({
      attempt: input.attempt,
      totalAttempts: input.totalAttempts,
      modelId: model.id,
      result,
      retryReason,
      evaluation,
      emptyStreamRetryCount: state.emptyStreamRetryCount,
    });

    if (retryReason === "empty_stream") {
      state.emptyStreamRetryCount += 1;
      retryReasonHistory.push("empty_stream");
      state.retryNudge = undefined;
      debugLog(
        "emptyStreamRetry",
        `Empty stream (no text/tool/reasoning surfaced); retry ${state.emptyStreamRetryCount}/${input.maxEmptyStreamRetries}. lastFinishReason=${String(result.lastFinishReason)}, chunks=${result.streamChunkCount}`,
      );
      return { action: "continue", baselineRequestBody };
    }

    state.attemptCompleted = true;
    state.repetitionClosedTurn = evaluation.isRepetitionLoop;
    state.duplicateStall = isSuppressedDuplicateStall(result);
    state.duplicateStallTool = state.duplicateStall
      ? (result.skippedToolCalls.find((call) => call.reason === "duplicate")?.name ?? "")
      : "";
    return { action: "complete", baselineRequestBody };
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
