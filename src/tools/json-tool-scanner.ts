import { parseJsonOrRepair, tryParseJsonObjectOrRepair } from "../shared/json-repair";
import { isTokenInStringOrRegexLiteral, readBalancedJsonObject } from "./xml-tool-scanner";
import {
  ToolSchema,
  hasRequiredToolArguments,
  isToolCallInput,
  FORBIDDEN_TOOL_IDENTIFIERS,
} from "./tool-schema";
import { repairToolArguments, PROPERTY_ALIAS_GROUPS } from "./argument-repair";

export interface JsonScannedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type JsonScanResult =
  | {
      status: "complete";
      consumed: number;
      toolCall?: JsonScannedToolCall;
      toolCalls?: JsonScannedToolCall[];
      invalidToolCall?: { name: string };
    }
  | { status: "incomplete" }
  | { status: "not-a-tool"; skip: number };

const EXPLICIT_TOOL_NAME_KEYS = ["name", "tool", "function", "action", "tool_name"] as const;

const AUXILIARY_KEYS = new Set([
  "explanation",
  "reason",
  "thought",
  "comments",
  "description",
  "goal",
]);

export function buildKnownPropertySet(toolSchemas?: ReadonlyMap<string, ToolSchema>): Set<string> {
  const set = new Set<string>(["name", "tool", "function", "action", "tool_name", "tool_calls"]);

  for (const group of PROPERTY_ALIAS_GROUPS) {
    for (const alias of group) {
      set.add(alias);
      set.add(alias.toLowerCase());
    }
  }

  if (toolSchemas) {
    for (const schema of toolSchemas.values()) {
      for (const req of schema.required ?? []) {
        set.add(req);
        set.add(req.toLowerCase());
      }
      for (const prop of Object.keys(schema.properties ?? {})) {
        set.add(prop);
        set.add(prop.toLowerCase());
      }
    }
  }

  return set;
}

export function isPlausibleJsonToolStart(
  slice: string,
  knownProperties: ReadonlySet<string>,
): boolean {
  if (slice[0] !== "{" && slice[0] !== "[") {
    return false;
  }
  if (slice[0] === "[") {
    const afterBracket = slice.slice(1).trimStart();
    if (afterBracket.length === 0) return true;
    if (afterBracket[0] === "{") {
      return isPlausibleJsonToolStart(afterBracket, knownProperties);
    }
    return false;
  }

  const trimmed = slice.slice(1).trimStart();
  if (trimmed.length === 0) {
    return true;
  }

  if (trimmed[0] !== '"') {
    return false;
  }

  const endQuoteIndex = trimmed.indexOf('"', 1);
  if (endQuoteIndex === -1) {
    const partialKey = trimmed.slice(1).toLowerCase();
    for (const prop of knownProperties) {
      if (prop.startsWith(partialKey)) {
        return true;
      }
    }
    return false;
  }

  const firstKey = trimmed.slice(1, endQuoteIndex);
  const lowerKey = firstKey.toLowerCase();
  return knownProperties.has(firstKey) || knownProperties.has(lowerKey);
}

function isJsonShapedConstruct(slice: string): boolean {
  if (slice[0] !== "{" && slice[0] !== "[") {
    return false;
  }
  const rest = slice.slice(1).trimStart();
  if (rest.length === 0) {
    return true;
  }
  if (slice[0] === "{") {
    return rest[0] === '"';
  }
  return rest[0] === "{" || rest[0] === "[" || rest[0] === '"';
}

export function findJsonConstructStart(
  text: string,
  contextPrefix = "",
  knownProperties: ReadonlySet<string>,
): { index: number; kind: "fenced" | "raw" } | undefined {
  let pos = 0;
  while (pos < text.length) {
    const candidates = [
      { index: text.indexOf("```", pos), kind: "fenced" as const },
      { index: text.indexOf("{", pos), kind: "raw" as const },
      { index: text.indexOf("[", pos), kind: "raw" as const },
    ].filter((c) => c.index !== -1);

    if (candidates.length === 0) {
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const nextCandidate = candidates[0];
    const nextIndex = nextCandidate.index;
    const nextKind = nextCandidate.kind;

    const totalPos = contextPrefix.length + nextIndex;
    if (isTokenInStringOrRegexLiteral(contextPrefix + text, totalPos)) {
      pos = nextIndex + 1;
      continue;
    }

    if (nextKind === "fenced") {
      const slice = text.slice(nextIndex);
      const match = slice.match(/^```(?:json)?\s*(\{|\[)?/i);
      if (match) {
        if (/^```json/i.test(match[0]) || match[1]) {
          return { index: nextIndex, kind: "fenced" };
        }
      }
      pos = nextIndex + 3;
      continue;
    }

    if (nextKind === "raw") {
      const slice = text.slice(nextIndex);
      if (isPlausibleJsonToolStart(slice, knownProperties)) {
        return { index: nextIndex, kind: "raw" };
      }
      const balanced = readBalancedJsonObject(text, nextIndex);
      if (balanced && !("incomplete" in balanced)) {
        pos = balanced.end;
        continue;
      }
      // Hold an unclosed JSON value whole. Stepping inside extracts a nested object as a tool call.
      if (isJsonShapedConstruct(slice)) {
        return { index: nextIndex, kind: "raw" };
      }
      pos = nextIndex + 1;
      continue;
    }
  }
  return undefined;
}

function hasAliasInSchema(
  key: string,
  declaredProps: ReadonlySet<string>,
  requiredProps: ReadonlySet<string>,
): boolean {
  for (const group of PROPERTY_ALIAS_GROUPS) {
    if (group.some((alias) => alias.toLowerCase() === key)) {
      if (
        group.some(
          (alias) =>
            declaredProps.has(alias.toLowerCase()) || requiredProps.has(alias.toLowerCase()),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function findBestMatchingTool(
  parsedArgs: Record<string, unknown>,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
): { name: string; args: Record<string, unknown> } | undefined {
  const argKeys = Object.keys(parsedArgs).filter(
    (k) => !AUXILIARY_KEYS.has(k.toLowerCase()) && !FORBIDDEN_TOOL_IDENTIFIERS.has(k),
  );
  if (argKeys.length === 0) {
    return undefined;
  }

  let bestMatch:
    | {
        name: string;
        args: Record<string, unknown>;
        score: number;
        unrecognizedCount: number;
        satisfiedRequired: number;
      }
    | undefined;

  for (const [toolName, schema] of toolSchemas.entries()) {
    const repaired = repairToolArguments(toolName, parsedArgs, schema);
    if (!isToolCallInput(repaired) || !hasRequiredToolArguments(repaired, schema)) {
      continue;
    }

    const declaredProps = new Set(Object.keys(schema.properties ?? {}).map((p) => p.toLowerCase()));
    const requiredProps = new Set((schema.required ?? []).map((r) => r.toLowerCase()));

    let directMatches = 0;
    let aliasMatches = 0;
    let unrecognizedCount = 0;

    for (const key of argKeys) {
      const lowerKey = key.toLowerCase();
      if (declaredProps.has(lowerKey) || requiredProps.has(lowerKey)) {
        directMatches += 1;
      } else if (hasAliasInSchema(lowerKey, declaredProps, requiredProps)) {
        aliasMatches += 1;
      } else {
        unrecognizedCount += 1;
      }
    }

    let satisfiedRequired = 0;
    for (const req of schema.required ?? []) {
      if (repaired[req] !== undefined && repaired[req] !== null && repaired[req] !== "") {
        satisfiedRequired += 1;
      }
    }

    if (satisfiedRequired === 0 && directMatches === 0 && aliasMatches === 0) {
      continue;
    }

    const score =
      satisfiedRequired * 10 + directMatches * 3 + aliasMatches * 2 - unrecognizedCount * 20;

    if (score <= 0) {
      continue;
    }

    if (
      !bestMatch ||
      score > bestMatch.score ||
      (score === bestMatch.score && unrecognizedCount < bestMatch.unrecognizedCount) ||
      (score === bestMatch.score &&
        unrecognizedCount === bestMatch.unrecognizedCount &&
        satisfiedRequired > bestMatch.satisfiedRequired)
    ) {
      bestMatch = {
        name: toolName,
        args: repaired,
        score,
        unrecognizedCount,
        satisfiedRequired,
      };
    }
  }

  return bestMatch ? { name: bestMatch.name, args: bestMatch.args } : undefined;
}

function extractSingleToolCall(
  record: Record<string, unknown>,
  toolSchemas: ReadonlyMap<string, ToolSchema> | undefined,
  isValidName: (name: string) => boolean,
): JsonScannedToolCall | undefined {
  if (!toolSchemas || toolSchemas.size === 0) {
    return undefined;
  }

  for (const key of EXPLICIT_TOOL_NAME_KEYS) {
    const val = record[key];
    if (typeof val === "string" && isValidName(val.trim())) {
      const name = val.trim();
      if (toolSchemas.has(name)) {
        let args: Record<string, unknown> = {};
        const inner =
          typeof record.arguments === "object" && record.arguments !== null
            ? record.arguments
            : typeof record.parameters === "object" && record.parameters !== null
              ? record.parameters
              : typeof record.action_input === "object" && record.action_input !== null
                ? record.action_input
                : typeof record.input === "object" && record.input !== null
                  ? record.input
                  : undefined;

        if (inner && !Array.isArray(inner)) {
          args = inner as Record<string, unknown>;
        } else if (typeof record.arguments === "string") {
          args = (tryParseJsonObjectOrRepair(record.arguments) as Record<string, unknown>) ?? {};
        } else {
          for (const [k, v] of Object.entries(record)) {
            if (
              !EXPLICIT_TOOL_NAME_KEYS.includes(k as never) &&
              k !== "arguments" &&
              k !== "parameters" &&
              k !== "action_input" &&
              k !== "input"
            ) {
              args[k] = v;
            }
          }
        }
        return { name, args };
      }
    }
  }

  const matched = findBestMatchingTool(record, toolSchemas);
  if (matched) {
    return matched;
  }

  return undefined;
}

export function scanJsonToolConstruct(
  text: string,
  toolSchemas: ReadonlyMap<string, ToolSchema> | undefined,
  isValidName: (name: string) => boolean,
  atStreamEnd = false,
): JsonScanResult {
  let jsonStartIndex = 0;
  let isFenced = false;
  let fenceLength = 0;

  if (text.startsWith("```")) {
    isFenced = true;
    const match = text.match(/^```(?:json)?\s*/i);
    if (!match) {
      return { status: "not-a-tool", skip: 3 };
    }
    fenceLength = match[0].length;
    jsonStartIndex = fenceLength;
  }

  while (
    jsonStartIndex < text.length &&
    (text[jsonStartIndex] === " " ||
      text[jsonStartIndex] === "\n" ||
      text[jsonStartIndex] === "\r" ||
      text[jsonStartIndex] === "\t")
  ) {
    jsonStartIndex += 1;
  }

  if (jsonStartIndex >= text.length) {
    return { status: "incomplete" };
  }

  const startChar = text[jsonStartIndex];
  if (startChar !== "{" && startChar !== "[") {
    return { status: "not-a-tool", skip: isFenced ? fenceLength : 1 };
  }

  const balanced = readBalancedJsonObject(text, jsonStartIndex);
  if (!balanced || "incomplete" in balanced) {
    return { status: "incomplete" };
  }

  let consumed = balanced.end;
  if (isFenced) {
    const rest = text.slice(consumed);
    const closeMatch = rest.match(/^\s*```/);
    if (!closeMatch) {
      // Keep waiting while the stream is open. At the end, a balanced value still commits.
      if (!atStreamEnd) {
        return { status: "incomplete" };
      }
    } else {
      consumed += closeMatch[0].length;
    }
  }
  if (text.slice(consumed).startsWith("\r\n")) {
    consumed += 2;
  } else if (text.slice(consumed).startsWith("\n")) {
    consumed += 1;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonOrRepair(balanced.json);
  } catch {
    return { status: "not-a-tool", skip: consumed };
  }

  if (!parsed || typeof parsed !== "object") {
    return { status: "not-a-tool", skip: consumed };
  }

  if (Array.isArray(parsed)) {
    const toolCalls: JsonScannedToolCall[] = [];
    for (const item of parsed) {
      if (typeof item === "object" && item !== null) {
        const extracted = extractSingleToolCall(item, toolSchemas, isValidName);
        if (extracted) {
          toolCalls.push(extracted);
        }
      }
    }
    if (toolCalls.length > 0) {
      return { status: "complete", consumed, toolCalls };
    }
    return { status: "not-a-tool", skip: consumed };
  }

  const record = parsed as Record<string, unknown>;

  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
    const toolCalls: JsonScannedToolCall[] = [];
    for (const item of record.tool_calls) {
      if (typeof item === "object" && item !== null) {
        const itemRecord = item as Record<string, unknown>;
        const func = itemRecord.function as Record<string, unknown> | undefined;
        const name = String(func?.name ?? itemRecord.name ?? "").trim();
        const rawArgs = func?.arguments ?? itemRecord.arguments ?? itemRecord.parameters ?? {};
        if (name && isValidName(name) && toolSchemas?.has(name)) {
          const args =
            typeof rawArgs === "string" ? (tryParseJsonObjectOrRepair(rawArgs) ?? {}) : rawArgs;
          toolCalls.push({ name, args: args as Record<string, unknown> });
        }
      }
    }
    if (toolCalls.length > 0) {
      return { status: "complete", consumed, toolCalls };
    }
  }

  const single = extractSingleToolCall(record, toolSchemas, isValidName);
  if (single) {
    return { status: "complete", consumed, toolCall: single };
  }

  return { status: "not-a-tool", skip: consumed };
}

export function getIncompleteJsonToolCallName(
  text: string,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): string | undefined {
  if (!toolSchemas || toolSchemas.size === 0) {
    return undefined;
  }

  const match = text.match(/"(?:name|tool|function|action|tool_name)"\s*:\s*"([a-zA-Z0-9_.-]+)"/);
  if (match) {
    const candidate = match[1].trim();
    if (candidate && toolSchemas.has(candidate)) {
      return candidate;
    }
  }

  const partial = tryParseJsonObjectOrRepair(text);
  if (partial && typeof partial === "object" && !Array.isArray(partial)) {
    const matched = findBestMatchingTool(partial as Record<string, unknown>, toolSchemas);
    if (matched) {
      return matched.name;
    }
  }

  return undefined;
}
