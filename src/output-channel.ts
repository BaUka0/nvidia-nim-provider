import * as vscode from "vscode";
import { DEBUG_ENV_VAR, PROVIDER_DISPLAY_NAME } from "./constants";

const OUTPUT_CHANNEL_NAME = PROVIDER_DISPLAY_NAME;
const DEBUG_LOG_PREFIX = `[${PROVIDER_DISPLAY_NAME} Debug]`;
const LOG_PREFIX = `[${PROVIDER_DISPLAY_NAME}]`;

function getGlobalOutputChannel(): vscode.OutputChannel | undefined {
  const globalWindow = globalThis as typeof globalThis & {
    __nvidiaNimOutputChannel?: vscode.OutputChannel;
  };
  return globalWindow.__nvidiaNimOutputChannel;
}

function setGlobalOutputChannel(channel: vscode.OutputChannel): void {
  const globalWindow = globalThis as typeof globalThis & {
    __nvidiaNimOutputChannel?: vscode.OutputChannel;
  };
  globalWindow.__nvidiaNimOutputChannel = channel;
}

export function getOutputChannel(): vscode.OutputChannel {
  let channel = getGlobalOutputChannel();
  if (!channel) {
    channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    setGlobalOutputChannel(channel);
  }
  return channel;
}

export function debugEnabled(): boolean {
  return process.env[DEBUG_ENV_VAR] === "1";
}

export function debugLog(label: string, value: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  const message = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${DEBUG_LOG_PREFIX} ${label}: ${message}`);
    return;
  }
  console.log(`${DEBUG_LOG_PREFIX} ${label}:`, value);
}

export function outputLog(label: string, value: unknown): void {
  const message = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${LOG_PREFIX} ${label}: ${message}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${label}:`, value);
}
