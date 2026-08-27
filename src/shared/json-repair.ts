import { jsonrepair } from "jsonrepair";
import { MAX_JSON_REPAIR_CHARS } from "./constants";

/**
 * Parse JSON strictly, then repair with `jsonrepair` only after a strict parse
 * fails. Repair is skipped (and throws) when the payload exceeds
 * `MAX_JSON_REPAIR_CHARS` so untrusted model output cannot feed ReDoS-sized
 * strings into the repairer.
 */
export function parseJsonOrRepair(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Repair is attempted only after strict JSON parsing fails.
  }

  if (text.length > MAX_JSON_REPAIR_CHARS) {
    throw new Error(`JSON payload exceeds the ${MAX_JSON_REPAIR_CHARS}-character repair limit`);
  }

  return JSON.parse(jsonrepair(text));
}

/** Parse or repair, returning the original string when both paths fail. */
export function tryParseJsonOrRepair(text: string): unknown {
  if (!text) {
    return text;
  }
  try {
    return parseJsonOrRepair(text);
  } catch {
    return text;
  }
}

export function parseJsonObjectOrRepair(text: string): Record<string, unknown> {
  const parsed = parseJsonOrRepair(text);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("Failed to parse JSON object");
}

export function tryParseJsonObjectOrRepair(text: string): Record<string, unknown> | undefined {
  try {
    return parseJsonObjectOrRepair(text);
  } catch {
    return undefined;
  }
}
