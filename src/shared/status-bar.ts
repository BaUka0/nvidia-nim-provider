import * as vscode from "vscode";
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
  output: number;
  contextWindow: number;
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
  }

  showOk(modelCount: number): void {
    this.item.text = `$(zap) ${PROVIDER_DISPLAY_NAME}: ${modelCount} models`;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  showRefreshing(): void {
    this.item.text = STATUS_BAR_DEFAULT_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Refreshing ${PROVIDER_DISPLAY_NAME} models...`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  showError(message: string): void {
    this.item.text = STATUS_BAR_ERROR_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `${PROVIDER_DISPLAY_NAME} Error: ${message}`;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  showUsage(modelName: string, promptTokens?: number, completionTokens?: number): void {
    if (promptTokens !== undefined && completionTokens !== undefined) {
      this.item.text = `$(zap) ${modelName}: ${formatTokenCount(promptTokens)}→${formatTokenCount(completionTokens)}`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}\nPrompt: ${promptTokens} tokens\nCompletion: ${completionTokens} tokens`;
    } else if (promptTokens !== undefined) {
      this.item.text = `$(zap) ${modelName}: ${formatTokenCount(promptTokens)} in`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}\nPrompt: ${promptTokens} tokens`;
    } else {
      this.item.text = `$(zap) ${modelName}`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}`;
    }
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.show();
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
    const totalTokens = inputTokens + breakdown.output;
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

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**$(zap) ${PROVIDER_DISPLAY_NAME} — ${breakdown.modelName}**\n\n`);
    md.appendMarkdown(
      `**${inputTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens** (${percentage.toFixed(1)}%)\n\n`,
    );
    md.appendMarkdown(`| Category | Tokens |\n`);
    md.appendMarkdown(`|---|---|\n`);
    md.appendMarkdown(`| System Prompt | ${cat.systemPrompt.toLocaleString()} |\n`);
    md.appendMarkdown(`| Tools (definitions) | ${cat.tools.toLocaleString()} |\n`);
    md.appendMarkdown(`| User Messages | ${cat.userMessages.toLocaleString()} |\n`);
    md.appendMarkdown(`| Assistant Messages | ${cat.assistantMessages.toLocaleString()} |\n`);
    md.appendMarkdown(`| Tool Calls | ${cat.toolCalls.toLocaleString()} |\n`);
    md.appendMarkdown(`| Tool Results | ${cat.toolResults.toLocaleString()} |\n`);
    md.appendMarkdown(`| Images / Media | ${cat.images.toLocaleString()} |\n`);
    md.appendMarkdown(
      `| **Input Total** | **${inputTokens.toLocaleString()}**${hasActual ? " *(actual)*" : ""} |\n`,
    );
    md.appendMarkdown(`| Output (completion) | ${breakdown.output.toLocaleString()} |\n`);
    md.appendMarkdown(`| **Total Used** | **${totalTokens.toLocaleString()}** |\n`);

    this.item.tooltip = md;
    this.item.command = undefined;

    if (percentage >= 95) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (percentage >= 80) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
