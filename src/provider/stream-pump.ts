import { randomUUID } from "node:crypto";

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
import { ModelAdapter } from "../models/adapters";
import { ConfigManager } from "../shared/config";
import { emitThinkingPart } from "../shared/proposed-apis";
import { MAX_EMBEDDED_TOOL_TEXT_CHARS } from "../shared/constants";
import { TEXT_EMBEDDED_TOOL_CALL_ID_PREFIX } from "../shared/tool-call-ids";
import { debugEnabled, debugLog, outputLog } from "../shared/logging";
import { NimChatRequest } from "../types";
import {
  buildToolCallCanonicalKey,
  getIncompleteTextToolCallName,
  hasRequiredToolArguments,
  isDuplicateSuppressionEnabled,
  parseTextEmbeddedToolCalls,
  repairToolArguments,
  SkippedToolCall,
} from "../tools/parser";
import { collectChoiceToolCalls } from "../tools/stream-tool-calls";
import { RepetitionGuard } from "./repetition-guard";
import { ToolCallStreamAggregator } from "./tool-call-aggregator";

export const REPETITION_STOP_NOTICE =
  "\n\n_[NVIDIA NIM] Stopped early: the model kept repeating the same output (degenerate loop detected). Try a different model, or raise/disable `nvidia-nim.generation.maxRepeatedLines`._";

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
  adapter?: ModelAdapter;
  reasoningIsolationExpected: boolean;
  maxFetchAttempts: number;
  firstTokenTimeoutMs?: number;
  hasRetriedRepetitionLoop: boolean;
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
  repetitionNoticeSent: boolean;
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
  let repetitionNoticeSent = false;
  let toolParsingStateInitDurationMs: number | undefined;

  const repetitionGuard = new RepetitionGuard({
    maxRepeatedLines: ConfigManager.getGenerationConfig().maxRepeatedLines,
  });

  const markFirstResponse = (): void => {
    if (firstResponseAtMs === undefined) {
      firstResponseAtMs = Date.now();
    }
  };

  const reportPart = (part: LanguageModelResponsePart): void => {
    if (
      part instanceof vscode.LanguageModelTextPart &&
      repetitionNoticeSent &&
      repetitionGuard.tripped
    ) {
      return;
    }
    let crossedThreshold = false;
    if (part instanceof vscode.LanguageModelTextPart && !repetitionGuard.tripped) {
      crossedThreshold = repetitionGuard.add(part.value);
    }
    if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) {
      lastVisibleText = part.value;
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
    if (crossedThreshold && !repetitionNoticeSent) {
      const autoContinue = ConfigManager.getGenerationConfig().autoContinueOnLoop;
      if (autoContinue && !input.hasRetriedRepetitionLoop) {
        debugLog("repetitionGuard", {
          model: input.model.id,
          trippedLine: repetitionGuard.trippedLine,
          action: "autoContinueSuppressedNotice",
        });
      } else {
        repetitionNoticeSent = true;
        input.progress.report(new vscode.LanguageModelTextPart(REPETITION_STOP_NOTICE));
        debugLog("repetitionGuard", {
          model: input.model.id,
          trippedLine: repetitionGuard.trippedLine,
        });
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

    const parseEmbeddedToolCalls =
      input.adapter?.parseTextEmbeddedToolCalls ?? parseTextEmbeddedToolCalls;
    const { segments, incompleteText, extractedParams } = parseEmbeddedToolCalls(
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
        const schema = getToolAggregator().getToolSchemas().get(segment.name);
        skippedToolCalls.push({
          name: segment.name,
          required: schema?.required ?? [],
        });
        debugLog("Skipped invalid text tool call", { name: segment.name });
        continue;
      }

      const toolCall = segment.toolCall;
      sawToolCall = true;
      const schema = getToolAggregator().getToolSchemas().get(toolCall.name);
      const repairedArgs = repairToolArguments(
        toolCall.name,
        toolCall.args,
        getToolAggregator().getRequestContext(),
        schema,
      );
      const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
      if (
        isDuplicateSuppressionEnabled(toolCall.name) &&
        getToolAggregator().getEmittedTextToolCallKeys().has(canonicalKey)
      ) {
        skippedToolCalls.push({
          name: toolCall.name,
          required: [],
          reason: "duplicate",
        });
        debugLog("Skipped duplicate text tool call", { name: toolCall.name });
        continue;
      }

      if (hasRequiredToolArguments(repairedArgs, schema)) {
        debugLog("xml_tool_fallback", { name: toolCall.name });
        flushPendingText();
        reportPart(
          new vscode.LanguageModelToolCallPart(
            `${TEXT_EMBEDDED_TOOL_CALL_ID_PREFIX}${randomUUID()}`,
            toolCall.name,
            repairedArgs as Record<string, unknown>,
          ),
        );
        emittedToolCall = true;
        if (firstToolCallAtMs === undefined) {
          firstToolCallAtMs = Date.now();
        }
        getToolAggregator().getEmittedTextToolCallKeys().add(canonicalKey);
      } else {
        skippedToolCalls.push({
          name: toolCall.name,
          required: schema?.required ?? [],
        });
        debugLog("Skipped invalid text tool call", toolCall);
      }
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
      const thinkingResult = emitThinkingPart(input.progress, text);
      if (thinkingResult.didReport) {
        reportedContent = true;
        input.onContentReported?.();
        if (thinkingResult.emittedVisible) {
          reportedVisibleContent = true;
          input.onVisibleContentReported?.();
        }
      }
    },
    onText: (text) => {
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
      const rawContent = choice?.delta?.content;
      const content = rawContent
        ? (input.adapter?.sanitizeResponseText?.(rawContent) ?? rawContent)
        : rawContent;

      const streamedToolCalls = choice ? collectChoiceToolCalls(choice) : [];

      if (debugEnabled()) {
        debugLog("stream chunk", {
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
        });
      }

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
      const autoContinue = ConfigManager.getGenerationConfig().autoContinueOnLoop;
      if (autoContinue && !input.hasRetriedRepetitionLoop) {
        debugLog("repetitionGuard", {
          model: input.model.id,
          trippedLine: repetitionGuard.trippedLine,
          action: "flushTrippedAutoContinue",
        });
      } else {
        repetitionNoticeSent = true;
        input.progress.report(new vscode.LanguageModelTextPart(REPETITION_STOP_NOTICE));
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
    if (
      input.token.isCancellationRequested ||
      input.signal.aborted ||
      (streamErr instanceof Error && streamErr.name === "AbortError")
    ) {
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
    const schema = getToolAggregator().getToolSchemas().get(incompleteTextToolName);
    skippedToolCalls.push({
      name: incompleteTextToolName,
      required: schema?.required ?? [],
    });
    debugLog("Skipped truncated text tool call", { name: incompleteTextToolName });
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
    repetitionNoticeSent,
    streamChunkCount,
    firstResponseAtMs,
    firstToolCallAtMs,
    toolParsingStateInitDurationMs,
  };
}
