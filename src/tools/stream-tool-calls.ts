import { NimToolCall } from "../types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function normalizeOneToolCall(raw: unknown): NimToolCall[] {
  const record = asRecord(raw);
  if (!record) {
    return [];
  }

  const keys = Object.keys(record);
  const looksLikeIndexMap =
    keys.length > 0 &&
    !("function" in record) &&
    !("id" in record) &&
    keys.every((key) => /^\d+$/.test(key));
  if (looksLikeIndexMap) {
    return keys
      .sort((left, right) => Number(left) - Number(right))
      .flatMap((key) => normalizeStreamToolCalls(record[key]));
  }

  const func = asRecord(record.function) ?? {};
  const name = typeof func.name === "string" ? func.name : "";
  const args = stringifyArguments(func.arguments);
  const id = typeof record.id === "string" ? record.id : "";
  const index = typeof record.index === "number" ? record.index : undefined;

  if (!id && !name && !args) {
    return [];
  }

  return [
    {
      id,
      ...(index !== undefined ? { index } : {}),
      type: "function",
      function: { name, arguments: args },
    },
  ];
}

export function normalizeStreamToolCalls(raw: unknown): NimToolCall[] {
  if (raw == null) {
    return [];
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    try {
      return normalizeStreamToolCalls(JSON.parse(trimmed) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeOneToolCall(item));
  }
  return normalizeOneToolCall(raw);
}

export function collectChoiceToolCalls(choice: {
  delta?: { tool_calls?: unknown };
  message?: { tool_calls?: unknown };
}): NimToolCall[] {
  const fromDelta = normalizeStreamToolCalls(choice.delta?.tool_calls);
  if (fromDelta.length > 0) {
    return fromDelta;
  }
  return normalizeStreamToolCalls(choice.message?.tool_calls);
}
