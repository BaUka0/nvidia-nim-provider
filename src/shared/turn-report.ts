import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectCycleHint } from "../provider/repetition-guard";
import { ConfigManager } from "./config";
import { EXTENSION_VERSION } from "./constants";
import { getSessionEvents, redactSecrets } from "./logging";
import { NimChatRequest } from "../types";

export { detectCycleHint };

/** Keep a short in-memory trail so a loop can be saved after the fact. */
export const MAX_TURN_REPORTS = 5;
const TEXT_SNIPPET_CHARS = 240;
const MAX_ERROR_MESSAGE_CHARS = 300;

const TEMPLATE_KWARG_KEYS = [
  "enable_thinking",
  "low_effort",
  "reasoning_budget",
  "thinking",
  "force_nonempty_content",
  "clear_thinking",
] as const;

export type TurnReportOutcome = "ok" | "retry" | "error" | "cancelled";

export interface TurnReportSkippedTool {
  readonly name: string;
  readonly reason?: string;
}

export interface TurnReport {
  readonly recordedAt: string;
  readonly outcome: TurnReportOutcome;
  readonly modelId: string;
  readonly reasoningMode?: string;
  readonly toolsEnabled: boolean;
  readonly toolNames: string[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly repetitionPenalty?: number;
  readonly toolChoice?: NimChatRequest["tool_choice"];
  readonly chatTemplateKwargs?: Record<string, unknown>;
  readonly sawToolCall: boolean;
  readonly emittedToolCall: boolean;
  readonly skippedToolCalls: TurnReportSkippedTool[];
  readonly finishReason?: string | null;
  readonly streamChunkCount: number;
  readonly visibleChars: number;
  readonly durationMs?: number;
  readonly repetitionTripped: boolean;
  readonly autoContinueFired?: boolean;
  readonly retryReasonHistory?: string[];
  readonly lastVisibleTextHead: string;
  readonly lastVisibleTextTail: string;
  readonly cycleHint: boolean;
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

export interface TurnReportInput {
  readonly outcome: TurnReportOutcome;
  readonly modelId: string;
  readonly requestBody?: NimChatRequest;
  readonly sawToolCall?: boolean;
  readonly emittedToolCall?: boolean;
  readonly skippedToolCalls?: readonly TurnReportSkippedTool[];
  readonly finishReason?: string | null;
  readonly streamChunkCount?: number;
  readonly lastVisibleText?: string;
  readonly durationMs?: number;
  readonly repetitionTripped?: boolean;
  readonly autoContinueFired?: boolean;
  readonly retryReasonHistory?: readonly string[];
  readonly errorKind?: string;
  readonly errorMessage?: string;
  readonly recordedAt?: string;
}

let reports: TurnReport[] = [];

export function resetTurnReportsForTests(): void {
  reports = [];
}

export function getTurnReports(): readonly TurnReport[] {
  return reports;
}

export function resolveDownloadsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Downloads");
}

function timestampStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export function buildTurnReportFilename(now: Date = new Date()): string {
  return `nvidia-nim-turn-report-${timestampStamp(now)}.json`;
}

export function buildSessionLogFilename(now: Date = new Date()): string {
  return `nvidia-nim-session-${timestampStamp(now)}.json`;
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

export function clipHeadTail(
  text: string,
  maxChars: number = TEXT_SNIPPET_CHARS,
): { head: string; tail: string } {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxChars) {
    return { head: redacted, tail: "" };
  }
  return {
    head: redacted.slice(0, maxChars),
    tail: redacted.slice(-maxChars),
  };
}

export function inferReasoningModeFromRequest(
  body: NimChatRequest | undefined,
): string | undefined {
  if (!body) {
    return undefined;
  }
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0) {
    return body.reasoning_effort;
  }
  const kwargs = body.chat_template_kwargs;
  if (!kwargs) {
    if (body.enable_thinking === false) {
      return "none";
    }
    if (body.enable_thinking === true) {
      return "on";
    }
    return undefined;
  }
  if (kwargs.enable_thinking === false || kwargs.thinking === false) {
    return "none";
  }
  if (kwargs.low_effort === true) {
    return "low";
  }
  if (typeof kwargs.reasoning_budget === "number" && Number.isFinite(kwargs.reasoning_budget)) {
    return `budget:${kwargs.reasoning_budget}`;
  }
  if (kwargs.enable_thinking === true || kwargs.thinking === true) {
    return "on";
  }
  return undefined;
}

function pickTemplateKwargs(
  kwargs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!kwargs) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of TEMPLATE_KWARG_KEYS) {
    if (key in kwargs) {
      picked[key] = kwargs[key];
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function toolNamesFromRequest(body: NimChatRequest | undefined): string[] {
  if (!body?.tools?.length) {
    return [];
  }
  const names: string[] = [];
  for (const tool of body.tools) {
    const name = tool.function?.name;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

function sanitizeErrorMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return clipText(redactSecrets(message), MAX_ERROR_MESSAGE_CHARS);
}

export function recordTurnReport(input: TurnReportInput): TurnReport {
  const visible = input.lastVisibleText ?? "";
  const { head, tail } = clipHeadTail(visible);
  const report: TurnReport = {
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    outcome: input.outcome,
    modelId: input.modelId,
    reasoningMode: inferReasoningModeFromRequest(input.requestBody),
    toolsEnabled: Boolean(input.requestBody?.tools?.length),
    toolNames: toolNamesFromRequest(input.requestBody),
    temperature: input.requestBody?.temperature,
    topP: input.requestBody?.top_p,
    frequencyPenalty: input.requestBody?.frequency_penalty,
    presencePenalty: input.requestBody?.presence_penalty,
    repetitionPenalty: input.requestBody?.repetition_penalty,
    toolChoice: input.requestBody?.tool_choice,
    chatTemplateKwargs: pickTemplateKwargs(input.requestBody?.chat_template_kwargs),
    sawToolCall: Boolean(input.sawToolCall),
    emittedToolCall: Boolean(input.emittedToolCall),
    skippedToolCalls: (input.skippedToolCalls ?? []).map((call) => ({
      name: call.name,
      ...(call.reason ? { reason: call.reason } : {}),
    })),
    finishReason: input.finishReason,
    streamChunkCount: input.streamChunkCount ?? 0,
    visibleChars: visible.length,
    durationMs: input.durationMs,
    repetitionTripped: Boolean(input.repetitionTripped),
    autoContinueFired: input.autoContinueFired,
    retryReasonHistory: input.retryReasonHistory ? [...input.retryReasonHistory] : undefined,
    lastVisibleTextHead: head,
    lastVisibleTextTail: tail,
    cycleHint: detectCycleHint(visible),
    errorKind: input.errorKind,
    errorMessage: sanitizeErrorMessage(input.errorMessage),
  };

  reports.push(report);
  if (reports.length > MAX_TURN_REPORTS) {
    reports = reports.slice(-MAX_TURN_REPORTS);
  }
  return report;
}

export function formatTurnReportsPayload(): string | undefined {
  if (reports.length === 0) {
    return undefined;
  }
  const payload = {
    extension: "nvidia-nim-provider",
    version: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    turns: reports,
  };
  return redactSecrets(JSON.stringify(payload, null, 2));
}

export function formatSessionLogsPayload(): string | undefined {
  const events = getSessionEvents();
  if (reports.length === 0 && events.length === 0) {
    return undefined;
  }
  const developer = ConfigManager.getDeveloperConfig();
  const generation = ConfigManager.getGenerationConfig();
  const fallback = ConfigManager.getFallbackConfig();
  const payload = {
    extension: "nvidia-nim-provider",
    version: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    settings: {
      debugLogging: developer.debugLogging,
      logStreamChunks: developer.logStreamChunks,
      logUserMessages: developer.logUserMessages,
      logTimingBreakdowns: developer.logTimingBreakdowns,
      maxRepeatedLines: generation.maxRepeatedLines,
      autoContinueOnLoop: generation.autoContinueOnLoop,
      fallbackEnabled: fallback.enabled,
      fallbackModel: fallback.model,
      fallbackVisionModel: fallback.visionModel,
      fallbackOnRateLimit: fallback.onRateLimit,
      fallbackOnModelUnavailable: fallback.onModelUnavailable,
      fallbackOnEmptyStream: fallback.onEmptyStream,
      fallbackOnTimeout: fallback.onTimeout,
    },
    turns: reports,
    events,
  };
  return redactSecrets(JSON.stringify(payload, null, 2));
}

export async function writeTurnReportFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}
