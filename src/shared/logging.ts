import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { DEBUG_ENV_VAR, PROVIDER_DISPLAY_NAME } from "./constants";

// Prefixes are built lazily (not at module load) because logging sits in an
// import cycle (logging -> config -> logging via constants) and a top-level
// template would capture PROVIDER_DISPLAY_NAME before constants finishes
// initializing, producing "[undefined Debug]".
const debugPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Debug]`;
const logPrefix = (): string => `[${PROVIDER_DISPLAY_NAME}]`;
const errorPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Error]`;
const warnPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Warning]`;

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
    channel = vscode.window.createOutputChannel(PROVIDER_DISPLAY_NAME);
    setGlobalOutputChannel(channel);
  }
  return channel;
}

export function debugEnabled(): boolean {
  return process.env[DEBUG_ENV_VAR] === "1" || ConfigManager.getDeveloperConfig().debugLogging;
}

const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|apikey|authorization|token|secret|password)$/i;
const NIM_SECRET_PATTERN = /\bnvapi-[A-Za-z0-9_-]{8,}/g;
const BEARER_SECRET_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Mask API keys and bearer tokens inside any string before it reaches a log. */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_SECRET_PATTERN, "Bearer [REDACTED]")
    .replace(NIM_SECRET_PATTERN, "nvapi-[REDACTED]");
}

/**
 * Deep-redact a log payload: sensitive object keys become `[REDACTED]` and
 * secret-looking string values are masked. Recursion is depth-capped so
 * circular structures terminate instead of throwing.
 */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return value;
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value instanceof Error) {
    return redactSecrets(value.message);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && (typeof item === "string" || item === undefined)) {
        redacted[key] = item === undefined ? undefined : "[REDACTED]";
        continue;
      }
      redacted[key] = redactValue(item, depth + 1);
    }
    return redacted;
  }
  return value;
}

/** Serialize a log payload without ever throwing on circular structures. */
function toLogMessage(value: unknown): string {
  const redacted = redactValue(value);
  if (typeof redacted === "string") {
    return redacted;
  }
  try {
    return JSON.stringify(redacted, null, 2);
  } catch {
    return redactSecrets(String(value));
  }
}

export function debugLog(label: string, value: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${debugPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.log(`${debugPrefix()} ${label}:`, redactValue(value));
}

export function outputLog(label: string, value: unknown): void {
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${logPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.log(`${logPrefix()} ${label}:`, redactValue(value));
}

export function errorLog(label: string, value: unknown): void {
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${errorPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.error(`${errorPrefix()} ${label}:`, redactValue(value));
}

export function warnLog(label: string, value: unknown): void {
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`${warnPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.warn(`${warnPrefix()} ${label}:`, redactValue(value));
}
