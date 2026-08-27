import * as vscode from "vscode";
import { DEBUG_ENV_VAR, PROVIDER_DISPLAY_NAME } from "./constants";

// Prefixes are built lazily (not at module load) because a top-level
// template would capture PROVIDER_DISPLAY_NAME before constants finishes
// initializing, producing "[undefined Debug]".
const debugPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Debug]`;
const logPrefix = (): string => `[${PROVIDER_DISPLAY_NAME}]`;
const errorPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Error]`;
const warnPrefix = (): string => `[${PROVIDER_DISPLAY_NAME} Warning]`;

let outputChannel: vscode.OutputChannel | undefined;
let developerDebugLogging = false;
let debugEnabledCache: boolean | undefined;

/** Called from activation / config changes; avoids a logging ↔ config import cycle. */
export function setDeveloperDebugLogging(enabled: boolean): void {
  developerDebugLogging = enabled;
  debugEnabledCache = undefined;
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(PROVIDER_DISPLAY_NAME);
  }
  return outputChannel;
}

export function disposeOutputChannel(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

export function debugEnabled(): boolean {
  if (debugEnabledCache !== undefined) {
    const envOn = process.env[DEBUG_ENV_VAR] === "1";
    const expected = envOn || developerDebugLogging;
    if (debugEnabledCache === expected) {
      return debugEnabledCache;
    }
  }
  const enabled = process.env[DEBUG_ENV_VAR] === "1" || developerDebugLogging;
  debugEnabledCache = enabled;
  return enabled;
}

export function invalidateDebugEnabledCache(): void {
  debugEnabledCache = undefined;
}

const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|apikey|authorization|token|secret|password)$/i;
const NIM_SECRET_PATTERN = /\bnvapi-[A-Za-z0-9_-]{8,}/g;
const BEARER_SECRET_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization|X-Api-Key)\s*:\s*\S+/gi;

/** Mask API keys and bearer tokens inside any string before it reaches a log. */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_SECRET_PATTERN, "Bearer [REDACTED]")
    .replace(NIM_SECRET_PATTERN, "nvapi-[REDACTED]")
    .replace(AUTH_HEADER_PATTERN, "$1: [REDACTED]");
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
  if (outputChannel) {
    outputChannel.appendLine(`${debugPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.log(`${debugPrefix()} ${label}:`, redactValue(value));
}

export function outputLog(label: string, value: unknown): void {
  if (outputChannel) {
    outputChannel.appendLine(`${logPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.log(`${logPrefix()} ${label}:`, redactValue(value));
}

export function errorLog(label: string, value: unknown): void {
  if (outputChannel) {
    outputChannel.appendLine(`${errorPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.error(`${errorPrefix()} ${label}:`, redactValue(value));
}

export function warnLog(label: string, value: unknown): void {
  if (outputChannel) {
    outputChannel.appendLine(`${warnPrefix()} ${label}: ${toLogMessage(value)}`);
    return;
  }
  console.warn(`${warnPrefix()} ${label}:`, redactValue(value));
}
