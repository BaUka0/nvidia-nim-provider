import * as vscode from "vscode";
import { ConfigManager } from "./config";
import {
  PROVIDER_DISPLAY_NAME,
  REFRESH_MODELS_COMMAND_ID,
  STATUS_BAR_DEFAULT_TEXT,
  STATUS_BAR_ERROR_TEXT,
} from "./constants";
import {
  ActivityPhase,
  fitToWidth,
  formatDuration,
  formatElapsedSeconds,
  formatRate,
  GenerationStats,
  StreamActivitySink,
  StreamActivityTracker,
} from "./live-status";
import { redactSecrets } from "./logging";

const LIVE_REFRESH_MS = 250;
/** Live label width (em), about 40 average characters; the item keeps this width while streaming. */
const LIVE_LABEL_WIDTH_EM = 21;

const PHASE_LABELS: Record<ActivityPhase, string> = {
  waiting: "Waiting for the first token",
  thinking: "Thinking",
  writing: "Writing the answer",
  tool: "Calling a tool",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Neutralize markdown-active characters in untrusted text (e.g. model names
 * derived from API metadata) so it cannot inject links, markup, or break the
 * tooltip table when rendered in a MarkdownString. Escaped characters render
 * unchanged, so legitimate names are unaffected visually.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()|<>$]/g, "\\$&");
}

/** Keeps untrusted text (model names, reasoning) from rendering `$(icon)` codicons. */
function escapeStatusText(text: string): string {
  return text.replace(/\$\(/g, "$\u200b(");
}

function formatStatsSuffix(stats: GenerationStats | undefined): string {
  if (!stats) {
    return "";
  }
  const parts: string[] = [];
  if (stats.ttftMs !== undefined) {
    parts.push(formatDuration(stats.ttftMs));
  }
  if (stats.tokensPerSecond !== undefined) {
    parts.push(`${stats.outputTokensActual ? "" : "~"}${formatRate(stats.tokensPerSecond)} tok/s`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function appendPerformanceTable(
  md: vscode.MarkdownString,
  stats: GenerationStats | undefined,
): void {
  if (!stats || (stats.ttftMs === undefined && stats.tokensPerSecond === undefined)) {
    return;
  }
  md.appendMarkdown(`\n| Performance | |\n|---|---|\n`);
  if (stats.ttftMs !== undefined) {
    md.appendMarkdown(`| Time to first token | ${formatDuration(stats.ttftMs)} |\n`);
  }
  if (stats.tokensPerSecond !== undefined) {
    md.appendMarkdown(
      `| Generation speed${stats.outputTokensActual ? "" : " (estimated)"} | ${formatRate(stats.tokensPerSecond)} tok/s |\n`,
    );
  }
  if (stats.generationMs !== undefined) {
    md.appendMarkdown(`| Generation time | ${formatDuration(stats.generationMs)} |\n`);
  }
}

export interface TokenBreakdown {
  modelName: string;
  systemPrompt: number;
  tools: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  images: number;
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
  output?: number;
  contextWindow: number;
}

/**
 * One provider call shown live in the status bar. Stream deltas go to the
 * tracker; `finish` returns the call's stats and hands the item back.
 */
export class StatusBarActivity implements StreamActivitySink {
  private ended = false;

  constructor(
    public readonly modelName: string,
    public readonly tracker: StreamActivityTracker,
    private readonly onEnd: (activity: StatusBarActivity) => void,
  ) {}

  attemptStarted(): void {
    this.tracker.attemptStarted();
  }

  reasoning(text: string): void {
    this.tracker.reasoning(text);
  }

  answer(text: string): void {
    this.tracker.answer(text);
  }

  toolCall(delta: string): void {
    this.tracker.toolCall(delta);
  }

  /** Ends the activity and returns its stats; `completionTokens` is the backend's count. */
  finish(completionTokens?: number): GenerationStats {
    const stats = this.tracker.stats(completionTokens);
    this.end();
    return stats;
  }

  /** Ends the activity without a summary (errors, cancellation). Idempotent. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.onEnd(this);
  }
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  /** Running provider calls; the newest one owns the item. */
  private readonly activities: StatusBarActivity[] = [];
  private liveTimer: ReturnType<typeof setInterval> | undefined;
  private lastLiveKey = "";
  /** Renders the last static state; deferred while a provider call is running. */
  private renderIdle: (() => void) | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
  }

  private refreshVisibility(): void {
    if (!ConfigManager.getUiConfig().showStatusBarItem) {
      this.item.hide();
    } else {
      this.item.show();
    }
  }

  public updateVisibility(): void {
    this.refreshVisibility();
  }

  private setIdle(render: () => void): void {
    this.renderIdle = render;
    if (this.activities.length === 0) {
      render();
    }
  }

  showOk(modelCount: number): void {
    this.setIdle(() => {
      this.item.text = `$(zap) ${PROVIDER_DISPLAY_NAME}: ${modelCount} models`;
      this.item.command = REFRESH_MODELS_COMMAND_ID;
      this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      this.refreshVisibility();
    });
  }

  showRefreshing(): void {
    this.setIdle(() => {
      this.item.text = STATUS_BAR_DEFAULT_TEXT;
      this.item.command = REFRESH_MODELS_COMMAND_ID;
      this.item.tooltip = `Refreshing ${PROVIDER_DISPLAY_NAME} models...`;
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      this.refreshVisibility();
    });
  }

  showError(message: string): void {
    this.setIdle(() => {
      this.item.text = STATUS_BAR_ERROR_TEXT;
      this.item.command = REFRESH_MODELS_COMMAND_ID;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} Error: ${redactSecrets(message)}`;
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      this.refreshVisibility();
    });
  }

  /**
   * Final summary of a provider call: context use, plus time to first token
   * and generation speed when `stats` is given.
   */
  showTokenBreakdown(breakdown: TokenBreakdown, stats?: GenerationStats): void {
    this.setIdle(() => this.renderTokenBreakdown(breakdown, stats));
  }

  private renderTokenBreakdown(breakdown: TokenBreakdown, stats?: GenerationStats): void {
    const estimatedInput =
      breakdown.systemPrompt +
      breakdown.tools +
      breakdown.userMessages +
      breakdown.assistantMessages +
      breakdown.toolCalls +
      breakdown.toolResults +
      breakdown.images;
    const inputTokens = breakdown.actualPromptTokens ?? estimatedInput;
    const outputTokens = breakdown.actualCompletionTokens ?? breakdown.output;
    const totalTokens = outputTokens === undefined ? undefined : inputTokens + outputTokens;
    const contextWindow = breakdown.contextWindow;
    const percentage = contextWindow > 0 ? (inputTokens / contextWindow) * 100 : 0;

    const hasActual = breakdown.actualPromptTokens !== undefined;
    const scaleFactor = hasActual && estimatedInput > 0 ? inputTokens / estimatedInput : 1;

    const scale = (value: number): number => Math.round(value * scaleFactor);

    const cat = {
      systemPrompt: scale(breakdown.systemPrompt),
      tools: scale(breakdown.tools),
      userMessages: scale(breakdown.userMessages),
      assistantMessages: scale(breakdown.assistantMessages),
      toolCalls: scale(breakdown.toolCalls),
      toolResults: scale(breakdown.toolResults),
      images: scale(breakdown.images),
    };

    this.item.text = `$(zap) ${escapeStatusText(breakdown.modelName)}: ${formatTokenCount(inputTokens)}/${formatTokenCount(contextWindow)}${formatStatsSuffix(stats)}`;

    const safeModelName = escapeMarkdown(breakdown.modelName);
    const md = new vscode.MarkdownString();
    // Untrusted: the tooltip carries no command links, so trust is unnecessary
    // and would otherwise allow injected markdown/command URIs from model names.
    md.isTrusted = false;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**$(zap) ${PROVIDER_DISPLAY_NAME} — ${safeModelName}**\n\n`);
    md.appendMarkdown(
      `**${inputTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens** (${percentage.toFixed(1)}%)\n\n`,
    );
    md.appendMarkdown(`| Category | Tokens |\n`);
    md.appendMarkdown(`|---|---|\n`);
    md.appendMarkdown(`| System Prompt (estimated) | ${cat.systemPrompt.toLocaleString()} |\n`);
    md.appendMarkdown(`| Tools (definitions, estimated) | ${cat.tools.toLocaleString()} |\n`);
    md.appendMarkdown(`| User Messages (estimated) | ${cat.userMessages.toLocaleString()} |\n`);
    md.appendMarkdown(
      `| Assistant Messages (estimated) | ${cat.assistantMessages.toLocaleString()} |\n`,
    );
    md.appendMarkdown(`| Tool Calls (estimated) | ${cat.toolCalls.toLocaleString()} |\n`);
    md.appendMarkdown(`| Tool Results (estimated) | ${cat.toolResults.toLocaleString()} |\n`);
    md.appendMarkdown(`| Images / Media (estimated) | ${cat.images.toLocaleString()} |\n`);
    md.appendMarkdown(
      `| **Input Total${hasActual ? " *(actual)*" : ""}** | **${inputTokens.toLocaleString()}** |\n`,
    );
    const outputIsActual = breakdown.actualCompletionTokens !== undefined;
    const outputLabel =
      outputTokens === undefined
        ? "Output (completion)"
        : outputIsActual
          ? "Output (completion)"
          : "Output (completion) (estimated)";
    md.appendMarkdown(
      `| ${outputLabel} | ${outputTokens === undefined ? "Not reported" : outputTokens.toLocaleString()} |\n`,
    );
    md.appendMarkdown(
      `| **Total Used** | **${totalTokens === undefined ? "Not available" : totalTokens.toLocaleString()}** |\n`,
    );
    appendPerformanceTable(md, stats);

    this.item.tooltip = md;
    this.item.command = REFRESH_MODELS_COMMAND_ID;

    if (percentage >= 95) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (percentage >= 80) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;
    this.refreshVisibility();
  }

  /**
   * Starts showing one provider call live: waiting time, the latest reasoning
   * phrase, and output speed. The newest running call owns the item; when the
   * last one ends, the last static state (usually its summary) comes back.
   */
  beginActivity(modelName: string): StatusBarActivity {
    const activity = new StatusBarActivity(modelName, new StreamActivityTracker(), (ended) =>
      this.endActivity(ended),
    );
    this.activities.push(activity);
    this.liveTimer ??= setInterval(() => this.renderLive(), LIVE_REFRESH_MS);
    this.lastLiveKey = "";
    this.renderLive();
    this.refreshVisibility();
    return activity;
  }

  private endActivity(activity: StatusBarActivity): void {
    const index = this.activities.indexOf(activity);
    if (index >= 0) {
      this.activities.splice(index, 1);
    }
    if (this.activities.length > 0) {
      this.lastLiveKey = "";
      this.renderLive();
      return;
    }
    this.stopLiveTimer();
    this.renderIdle?.();
  }

  private stopLiveTimer(): void {
    if (this.liveTimer !== undefined) {
      clearInterval(this.liveTimer);
      this.liveTimer = undefined;
    }
  }

  private renderLive(): void {
    const activity = this.activities.at(-1);
    if (!activity) {
      return;
    }
    const { tracker } = activity;
    const model = activity.modelName;
    const rate = tracker.liveTokensPerSecond();
    const rateText = rate === undefined ? "" : ` · ~${formatRate(rate)} tok/s`;
    let label: string;
    switch (tracker.phase) {
      case "waiting": {
        const retryText = tracker.attemptCount > 1 ? ` · attempt ${tracker.attemptCount}` : "";
        label = `${model}: waiting ${formatElapsedSeconds(tracker.waitingMs())}${retryText}`;
        break;
      }
      case "thinking":
        // The phrase alone: the model name would eat most of the fixed width.
        label = tracker.currentPhrase() ?? "Thinking…";
        break;
      case "writing":
        label = `${model}: writing${rateText}`;
        break;
      case "tool":
        label = `${model}: calling a tool${rateText}`;
        break;
    }
    const text = `$(loading~spin) ${escapeStatusText(fitToWidth(label, LIVE_LABEL_WIDTH_EM))}`;

    const ttft = tracker.ttftMs();
    const key = [
      text,
      tracker.phase,
      ttft ?? "",
      rate === undefined ? "" : formatRate(rate),
      Math.floor(tracker.elapsedMs() / 1000),
    ].join("\u0000");
    if (key === this.lastLiveKey) {
      return;
    }
    this.lastLiveKey = key;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;
    md.appendMarkdown(
      `**$(loading~spin) ${PROVIDER_DISPLAY_NAME} — ${escapeMarkdown(activity.modelName)}**\n\n`,
    );
    md.appendMarkdown(`| Request | |\n|---|---|\n`);
    md.appendMarkdown(`| Phase | ${PHASE_LABELS[tracker.phase]} |\n`);
    md.appendMarkdown(`| Elapsed | ${formatDuration(tracker.elapsedMs())} |\n`);
    md.appendMarkdown(
      `| Time to first token | ${ttft === undefined ? "Waiting" : formatDuration(ttft)} |\n`,
    );
    if (rate !== undefined) {
      md.appendMarkdown(`| Speed (estimated) | ${formatRate(rate)} tok/s |\n`);
    }
    if (tracker.attemptCount > 1) {
      md.appendMarkdown(`| Attempt | ${tracker.attemptCount} |\n`);
    }

    this.item.text = text;
    this.item.tooltip = md;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  dispose(): void {
    this.stopLiveTimer();
    this.item.dispose();
  }
}
