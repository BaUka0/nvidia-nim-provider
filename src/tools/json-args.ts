import { parseJsonOrRepair, tryParseJsonOrRepair } from "../shared/json-repair";

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Tool arguments must be a JSON object");
}

function safeJsonParse(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return parseToolArgumentsStrict(text);
  } catch {
    // Repair is deliberately attempted only after strict JSON parsing fails.
  }

  try {
    return parseJsonObject(parseJsonOrRepair(text));
  } catch {
    throw new Error("Failed to parse JSON");
  }
}

export function parseToolArguments(text: string): Record<string, unknown> {
  return safeJsonParse(text);
}

export function parseToolArgumentsStrict(text: string): Record<string, unknown> {
  return parseJsonObject(JSON.parse(text));
}

export function tryParseJsonValue(text: string): unknown {
  return tryParseJsonOrRepair(text);
}
