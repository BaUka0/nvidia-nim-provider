import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelResponsePart,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { streamChatCompletion } from "../api/client";
import { ReasoningStreamRouter } from "../messages/reasoning-router";
import { emitThinkingPart } from "../shared/proposed-apis";
import { isCancellation } from "../shared/cancellation";
import { ToolsConfig } from "../shared/config";
import { MAX_EMBEDDED_TOOL_TEXT_CHARS } from "../shared/constants";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { NimChatRequest } from "../types";
import {
  getIncompleteTextToolCallName,
  parseTextEmbeddedToolCalls,
  SkippedToolCall,
} from "../tools/parser";
import { collectChoiceToolCalls } from "../tools/stream-tool-calls";
import { RepetitionGuard } from "./repetition-guard";
import { ToolCallStreamAggregator } from "./tool-call-aggregator";

const MAX_TRACKED_VISIBLE_CHARS = 8192;

export type NimStreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export interface StreamAttemptInput {
  apiKey: string;
  requestBody: NimChatRequest;
  signal: AbortSignal;
  userAgent: string;
  token: CancellationToken;
  progress: Progress<LanguageModelResponsePart>;
  model: LanguageModelChatInformation;
  options: ProvideLanguageModelChatResponseOptions;
  messages: readonly LanguageModelChatMessage[];
  reasoningIsolationExpected: boolean;
  maxFetchAttempts: number;
  firstTokenTimeoutMs?: number;
  toolsConfig: ToolsConfig;
  showReasoningInChat: boolean;
  hasRetriedRepetitionLoop: boolean;
  maxRepeatedLines: number;
  autoContinueOnLoop: boolean;
  idleTimeoutMs?: number;
  onContentReported?: () => void;
  onVisibleContentReported?: () => void;
}

export interface StreamAttemptResult {
  reportedContent: boolean;
  reportedVisibleContent: boolean;
  sawToolCall: boolean;
  emittedToolCall: boolean;
  sawReasoning: boolean;
  lastFinishReason: string | null | undefined;
  lastUsage: NimStreamUsage | undefined;
  lastVisibleText: string;
  skippedToolCalls: SkippedToolCall[];
  repetitionTripped: boolean;
  trippedLine?: string;
  streamChunkCount: number;
  firstResponseAtMs?: number;
  firstToolCallAtMs?: number;
  toolParsingStateInitDurationMs?: number;
}

/**
 * Consume one NIM SSE stream, reporting parts to VS Code as they arrive.
 * Retry / fallback policy lives in the caller so this pump stays testable.
 */
export async function runStreamAttempt(input: StreamAttemptInput): Promise<StreamAttemptResult> {
  const skippedToolCalls: SkippedToolCall[] = [];
  let pendingTextEmbeddedContent = "";
  let pendingText = "";
  let sawToolCall = false;
  let emittedToolCall = false;
  let reportedContent = false;
  let reportedVisibleContent = false;
  let sawReasoning = false;
  let lastFinishReason: string | null | undefined = undefined;
  let streamChunkCount = 0;
  let firstResponseAtMs: number | undefined;
  let firstToolCallAtMs: number | undefined;
  let lastUsage: NimStreamUsage | undefined;
  let lastVisibleText = "";
  let toolParsingStateInitDurationMs: number | undefined;

  const repetitionGuard = new RepetitionGuard({
    maxRepeatedLines: input.maxRepeatedLines,
  });

  const markFirstResponse = (): void => {
    if (firstResponseAtMs === undefined) {
      firstResponseAtMs = Date.now();
    }
  };

  const pendingThinking: string[] = [];
  const flushBufferedThinking = (): void => {
    if (pendingThinking.length === 0) {
      return;
    }
    for (const fragment of pendingThinking) {
      const thinkingResult = emitThinkingPart(input.progress, fragment, input.showReasoningInChat);
      if (thinkingResult.didReport) {
        reportedContent = true;
        input.onContentReported?.();
        if (thinkingResult.emittedVisible) {
          reportedVisibleContent = true;
          input.onVisibleContentReported?.();
        }
      }
    }
    pendingThinking.length = 0;
  };

  const reportPart = (part: LanguageModelResponsePart): void => {
    if (
      part instanceof vscode.LanguageModelTextPart ||
      part instanceof vscode.LanguageModelToolCallPart
    ) {
      flushBufferedThinking();
    }
    if (part instanceof vscode.LanguageModelTextPart && repetitionGuard.tripped) {
      return;
    }
    let crossedThreshold = false;
    if (part instanceof vscode.LanguageModelTextPart) {
      crossedThreshold = repetitionGuard.add(part.value);
    }
    if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
      lastVisibleText += part.value;
      if (lastVisibleText.length > MAX_TRACKED_VISIBLE_CHARS) {
        lastVisibleText = lastVisibleText.slice(-MAX_TRACKED_VISIBLE_CHARS);
      }
    }
    input.progress.report(part);
    reportedContent = true;
    input.onContentReported?.();
    if (
      part instanceof vscode.LanguageModelTextPart ||
      part instanceof vscode.LanguageModelToolCallPart
    ) {
      reportedVisibleContent = true;
      input.onVisibleContentReported?.();
    }
    if (crossedThreshold) {
      const willAutoContinue = input.autoContinueOnLoop && !input.hasRetriedRepetitionLoop;
      debugLog("repetitionGuard", {
        model: input.model.id,
        trippedLine: repetitionGuard.trippedLine,
        action: willAutoContinue ? "autoContinue" : "stopWithoutChatNotice",
      });
      if (!willAutoContinue) {
        outputLog(
          "repetitionGuard",
          `Stopped degenerate repeat loop on ${input.model.id}: "${repetitionGuard.trippedLine}"`,
        );
      }
    }
  };

  const flushPendingText = (): void => {
    if (!pendingText) {
      return;
    }
    reportPart(new vscode.LanguageModelTextPart(pendingText));
    pendingText = "";
  };

  let toolAggregator: ToolCallStreamAggregator | undefined;
  const getToolAggregator = (): ToolCallStreamAggregator => {
    if (toolAggregator) {
      return toolAggregator;
    }
    const toolParsingStateStartedAtMs = debugEnabled() ? Date.now() : undefined;
    toolAggregator = new ToolCallStreamAggregator({
      options: input.options,
      messages: input.messages,
      toolsConfig: input.toolsConfig,
      onEmitToolCall: (id, name, args) => {
        flushPendingText();
        reportPart(new vscode.LanguageModelToolCallPart(id, name, args));
        emittedToolCall = true;
        if (firstToolCallAtMs === undefined) {
          firstToolCallAtMs = Date.now();
        }
      },
      onSkipToolCall: (name, required, reason) => {
        skippedToolCalls.push({ name, required, reason });
      },
    });
    if (toolParsingStateStartedAtMs !== undefined) {
      toolParsingStateInitDurationMs = Date.now() - toolParsingStateStartedAtMs;
    }
    return toolAggregator;
  };

  const processFilteredText = (text: string): void => {
    if (!text) {
      return;
    }

    const { segments, incompleteText, extractedParams } = parseTextEmbeddedToolCalls(
      pendingTextEmbeddedContent + text,
    );
    pendingTextEmbeddedContent =
      incompleteText.length > MAX_EMBEDDED_TOOL_TEXT_CHARS ? "" : incompleteText;
    if (extractedParams && Object.keys(extractedParams).length > 0) {
      const named = segments.find(
        (segment) => segment.type === "toolCall" || segment.type === "invalidToolCall",
      );
      const toolName =
        named?.type === "toolCall"
          ? named.toolCall.name
          : named?.type === "invalidToolCall"
            ? named.name
            : undefined;
      if (toolName) {
        getToolAggregator().recordExtractedParameters(extractedParams, toolName);
      }
    }

    for (const segment of segments) {
      if (segment.type === "text") {
        pendingText += segment.text;
        continue;
      }

      if (segment.type === "invalidToolCall") {
        sawToolCall = true;
        getToolAggregator().recordInvalidToolCall(segment.name);
        continue;
      }

      sawToolCall = true;
      getToolAggregator().tryEmitText(segment.toolCall.name, segment.toolCall.args);
    }
  };

  const processAnswerText = (text: string): void => {
    if (!text) {
      return;
    }
    markFirstResponse();
    processFilteredText(text);
  };

  const router = new ReasoningStreamRouter({
    reasoningIsolationExpected: input.reasoningIsolationExpected,
    onThinking: (text) => {
      sawReasoning = true;
      markFirstResponse();
      pendingThinking.push(text);
    },
    onText: (text) => {
      flushBufferedThinking();
      processAnswerText(text);
      flushPendingText();
    },
    onFirstResponse: () => {
      markFirstResponse();
    },
  });

  try {
    for await (const chunk of streamChatCompletion(
      input.apiKey,
      input.requestBody,
      input.signal,
      input.userAgent,
      {
        maxOutputTokens: input.model.maxOutputTokens,
        maxFetchAttempts: input.maxFetchAttempts,
        firstTokenTimeoutMs: input.firstTokenTimeoutMs,
        idleTimeoutMs: input.idleTimeoutMs,
      },
    )) {
      if (input.token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const choice = chunk.choices?.[0];
      streamChunkCount += 1;
      if (choice?.finish_reason != null) {
        lastFinishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        lastUsage = chunk.usage;
      }

      const reasoningContent = (choice?.delta as { reasoning_content?: string } | undefined)
        ?.reasoning_content;
      const content = choice?.delta?.content;

      const streamedToolCalls = choice ? collectChoiceToolCalls(choice) : [];

      debugLog(
        "stream chunk",
        {
          rc: Boolean(reasoningContent),
          rcTail: reasoningContent?.slice(-32),
          content: Boolean(content),
          contentHead: content?.slice(0, 64),
          contentTail: content?.slice(-32),
          toolCallCount: streamedToolCalls.length,
          toolCalls: streamedToolCalls.map((toolCall) => ({
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.function?.name,
            argsChars: toolCall.function?.arguments?.length ?? 0,
          })),
          finish: choice?.finish_reason ?? null,
        },
        "chunk",
      );

      if (reasoningContent) {
        router.handleReasoningContent(reasoningContent);
      }

      if (content) {
        router.handleContent(content);
        if (!input.reasoningIsolationExpected || router.isAnswerStarted()) {
          flushPendingText();
        }
      }

      if (streamedToolCalls.length > 0) {
        markFirstResponse();
        sawToolCall = true;
        getToolAggregator().handleToolCalls(streamedToolCalls);
      }

      if (repetitionGuard.tripped) {
        debugLog("repetitionGuard", "stopping stream consumption");
        break;
      }
    }

    if (!repetitionGuard.tripped && repetitionGuard.flush()) {
      const willAutoContinue = input.autoContinueOnLoop && !input.hasRetriedRepetitionLoop;
      debugLog("repetitionGuard", {
        model: input.model.id,
        trippedLine: repetitionGuard.trippedLine,
        action: willAutoContinue ? "flushTrippedAutoContinue" : "flushTrippedStopWithoutChatNotice",
      });
      if (!willAutoContinue) {
        outputLog(
          "repetitionGuard",
          `Stopped degenerate repeat loop on ${input.model.id}: "${repetitionGuard.trippedLine}"`,
        );
      }
    }

    if (toolAggregator) {
      toolAggregator.flushRemaining();
    }
  } catch (streamErr) {
    if (isCancellation(streamErr, input.token) || input.signal.aborted) {
      throw new vscode.CancellationError();
    }
    throw streamErr;
  }

  router.flush();

  if (lastFinishReason === "tool_calls" && !emittedToolCall) {
    sawToolCall = true;
    if (skippedToolCalls.length === 0) {
      skippedToolCalls.push({
        name: "tool_call",
        required: [],
        reason: "missing_payload",
      });
      debugLog("Missing tool call payload after finish_reason=tool_calls", {
        streamChunkCount,
        aggregatorSawToolCall: toolAggregator?.getSawToolCall() ?? false,
      });
    }
  }

  const incompleteTextToolName = getIncompleteTextToolCallName(pendingTextEmbeddedContent);
  if (incompleteTextToolName) {
    sawToolCall = true;
    const schema = getToolAggregator().getToolSchema(incompleteTextToolName);
    skippedToolCalls.push({
      name: incompleteTextToolName,
      required: schema?.required ?? [],
    });
    debugLog("Skipped truncated text tool call", { name: incompleteTextToolName });
  }

  if (pendingText || emittedToolCall || reportedVisibleContent) {
    flushBufferedThinking();
  }
  if (pendingText) {
    flushPendingText();
  }

  return {
    reportedContent,
    reportedVisibleContent,
    sawToolCall,
    emittedToolCall,
    sawReasoning,
    lastFinishReason,
    lastUsage,
    lastVisibleText,
    skippedToolCalls,
    repetitionTripped: repetitionGuard.tripped,
    trippedLine: repetitionGuard.trippedLine,
    streamChunkCount,
    firstResponseAtMs,
    firstToolCallAtMs,
    toolParsingStateInitDurationMs,
  };
}
