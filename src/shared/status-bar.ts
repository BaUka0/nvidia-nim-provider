import * as vscode from "vscode";
import { ConfigManager } from "./config";
import {
  PROVIDER_DISPLAY_NAME,
  REFRESH_MODELS_COMMAND_ID,
  STATUS_BAR_DEFAULT_TEXT,
  STATUS_BAR_ERROR_TEXT,
} from "./constants";

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
  return text.replace(/[\\`*_[\]()|<>]/g, "\\$&");
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

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

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

  showOk(modelCount: number): void {
    this.item.text = `$(zap) ${PROVIDER_DISPLAY_NAME}: ${modelCount} models`;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.refreshVisibility();
  }

  showRefreshing(): void {
    this.item.text = STATUS_BAR_DEFAULT_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Refreshing ${PROVIDER_DISPLAY_NAME} models...`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.refreshVisibility();
  }

  showError(message: string): void {
    this.item.text = STATUS_BAR_ERROR_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `${PROVIDER_DISPLAY_NAME} Error: ${message}`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.refreshVisibility();
  }

  showTokenBreakdown(breakdown: TokenBreakdown): void {
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

    this.item.text = `$(zap) ${breakdown.modelName}: ${formatTokenCount(inputTokens)}/${formatTokenCount(contextWindow)}`;

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

  dispose(): void {
    this.item.dispose();
  }
}
