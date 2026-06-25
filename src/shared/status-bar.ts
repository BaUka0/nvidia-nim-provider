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

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
  }

  showOk(modelCount: number): void {
    this.item.text = `$(copilot) ${PROVIDER_DISPLAY_NAME}: ${modelCount} models`;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Click to refresh ${PROVIDER_DISPLAY_NAME} models`;
    this.item.show();
  }

  showRefreshing(): void {
    this.item.text = STATUS_BAR_DEFAULT_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `Refreshing ${PROVIDER_DISPLAY_NAME} models...`;
    this.item.show();
  }

  showError(message: string): void {
    this.item.text = STATUS_BAR_ERROR_TEXT;
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.tooltip = `${PROVIDER_DISPLAY_NAME} Error: ${message}`;
    this.item.show();
  }

  showUsage(modelName: string, promptTokens?: number, completionTokens?: number): void {
    if (promptTokens !== undefined && completionTokens !== undefined) {
      this.item.text = `$(copilot) ${modelName}: ${formatTokenCount(promptTokens)}→${formatTokenCount(completionTokens)}`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}\nPrompt: ${promptTokens} tokens\nCompletion: ${completionTokens} tokens`;
    } else if (promptTokens !== undefined) {
      this.item.text = `$(copilot) ${modelName}: ${formatTokenCount(promptTokens)} in`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}\nPrompt: ${promptTokens} tokens`;
    } else {
      this.item.text = `$(copilot) ${modelName}`;
      this.item.tooltip = `${PROVIDER_DISPLAY_NAME} — ${modelName}`;
    }
    this.item.command = REFRESH_MODELS_COMMAND_ID;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
