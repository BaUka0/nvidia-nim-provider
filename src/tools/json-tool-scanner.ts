import { parseJsonOrRepair, tryParseJsonObjectOrRepair } from "../shared/json-repair";
import { AUXILIARY_BOOLEAN_FIELDS, isAuxiliaryRequiredField } from "../shared/tool-fields";
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

const NON_OPERATIONAL_METADATA_KEYS = new Set<string>([
  ...AUXILIARY_KEYS,
  "summary",
  "mode",
  ...AUXILIARY_BOOLEAN_FIELDS,
]);

function isNonOperationalMetadataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    NON_OPERATIONAL_METADATA_KEYS.has(lower) ||
    NON_OPERATIONAL_METADATA_KEYS.has(lower.replace(/_/g, ""))
  );
}

/**
 * Concrete workspace target keys from file, directory, search, and command
 * alias groups (excluding content/code/text/data/body and line-number groups),
 * plus plural array variants used by zero-required-arg workspace tools.
 */
const ZERO_REQUIRED_TARGET_KEYS = new Set<string>([
  "filepath",
  "targetfile",
  "target_file",
  "file",
  "filename",
  "file_path",
  "uri",
  "destination",
  "dest",
  "absolutepath",
  "path",
  "directory",
  "dir",
  "folder",
  "cwd",
  "targetdirectory",
  "searchdirectory",
  "directorypath",
  "query",
  "pattern",
  "search_pattern",
  "searchpattern",
  "regex",
  "searchterm",
  "search_term",
  "command",
  "cmd",
  "script",
  "commandline",
  "command_line",
  "filepaths",
  "file_paths",
  "files",
  "paths",
  "uris",
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
  from = 0,
): { index: number; kind: "fenced" | "raw" } | undefined {
  let pos = from;
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
      const fullText = contextPrefix + text;
      const lineStart = fullText.lastIndexOf("\n", totalPos - 1) + 1;
      const linePrefix = fullText.slice(lineStart, totalPos);
      if (!/^[ \t]*$/.test(linePrefix)) {
        pos = nextIndex + 3;
        continue;
      }
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

function hasNonEmptyArgValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return (
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && value.trim().length === 0)
  );
}

function matchesKeyOrAlias(candidateKey: string, targetKey: string): boolean {
  const lowerCandidate = candidateKey.toLowerCase();
  const lowerTarget = targetKey.toLowerCase();
  if (lowerCandidate === lowerTarget) {
    return true;
  }
  return PROPERTY_ALIAS_GROUPS.some(
    (group) =>
      group.some((alias) => alias.toLowerCase() === lowerTarget) &&
      group.some((alias) => alias.toLowerCase() === lowerCandidate),
  );
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
    const schemaRequired = schema.required ?? [];
    const declaredProps = new Set(Object.keys(schema.properties ?? {}).map((p) => p.toLowerCase()));

    if (schemaRequired.length === 0) {
      const hasZeroRequiredTarget =
        declaredProps.size > 0 &&
        Object.entries(parsedArgs).some(([key, value]) => {
          const lowerKey = key.toLowerCase();
          return (
            !FORBIDDEN_TOOL_IDENTIFIERS.has(key) &&
            !isNonOperationalMetadataKey(key) &&
            hasNonEmptyArgValue(value) &&
            declaredProps.has(lowerKey) &&
            ZERO_REQUIRED_TARGET_KEYS.has(lowerKey)
          );
        });
      if (!hasZeroRequiredTarget) {
        continue;
      }
    } else {
      const nonAuxRequired = schemaRequired.filter((req) => !isAuxiliaryRequiredField(req));
      const hasRequiredFromCaller =
        nonAuxRequired.length > 0
          ? Object.entries(parsedArgs).some(
              ([key, value]) =>
                !FORBIDDEN_TOOL_IDENTIFIERS.has(key) &&
                hasNonEmptyArgValue(value) &&
                nonAuxRequired.some((req) => matchesKeyOrAlias(key, req)),
            )
          : Object.entries(parsedArgs).some(
              ([key, value]) =>
                !FORBIDDEN_TOOL_IDENTIFIERS.has(key) &&
                hasNonEmptyArgValue(value) &&
                schemaRequired.some((req) => key.toLowerCase() === req.toLowerCase()),
            );
      if (!hasRequiredFromCaller) {
        continue;
      }
    }

    const repaired = repairToolArguments(toolName, parsedArgs, undefined, schema);
    if (!isToolCallInput(repaired) || !hasRequiredToolArguments(repaired, schema)) {
      continue;
    }

    const requiredProps = new Set(schemaRequired.map((r) => r.toLowerCase()));

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

    if (unrecognizedCount > 0) {
      continue;
    }

    let satisfiedRequired = 0;
    for (const req of schemaRequired) {
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

function withoutForbiddenKeys(source: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_TOOL_IDENTIFIERS.has(key)) {
      continue;
    }
    args[key] = value;
  }
  return args;
}

type SingleToolCallExtraction =
  | { kind: "matched"; toolCall: JsonScannedToolCall; deferred?: boolean }
  | { kind: "none" };

function extractSingleToolCall(
  record: Record<string, unknown>,
  toolSchemas: ReadonlyMap<string, ToolSchema> | undefined,
  isValidName: (name: string) => boolean,
  isFenced = false,
  hasSurroundingText = false,
): SingleToolCallExtraction {
  if (!toolSchemas || toolSchemas.size === 0) {
    return { kind: "none" };
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
          args = withoutForbiddenKeys(inner as Record<string, unknown>);
        } else if (typeof record.arguments === "string") {
          args = withoutForbiddenKeys(
            (tryParseJsonObjectOrRepair(record.arguments) as Record<string, unknown>) ?? {},
          );
        } else {
          for (const [k, v] of Object.entries(record)) {
            if (
              EXPLICIT_TOOL_NAME_KEYS.includes(k as never) ||
              k === "arguments" ||
              k === "parameters" ||
              k === "action_input" ||
              k === "input" ||
              FORBIDDEN_TOOL_IDENTIFIERS.has(k)
            ) {
              continue;
            }
            args[k] = v;
          }
        }
        return { kind: "matched", toolCall: { name, args } };
      }
    }
  }

  let operationalPayloadKeys: string[] | undefined;
  if (isFenced) {
    operationalPayloadKeys = Object.keys(record).filter(
      (key) =>
        !isNonOperationalMetadataKey(key) &&
        !FORBIDDEN_TOOL_IDENTIFIERS.has(key) &&
        hasNonEmptyArgValue(record[key]),
    );
    if (operationalPayloadKeys.length === 0) {
      return { kind: "none" };
    }
  }

  const matched = findBestMatchingTool(record, toolSchemas);
  if (!matched) {
    return { kind: "none" };
  }

  if (isFenced && operationalPayloadKeys && operationalPayloadKeys.length === 1) {
    if (hasSurroundingText) {
      return { kind: "none" };
    }
    return { kind: "matched", toolCall: matched, deferred: true };
  }

  return { kind: "matched", toolCall: matched };
}

export function scanJsonToolConstruct(
  text: string,
  toolSchemas: ReadonlyMap<string, ToolSchema> | undefined,
  isValidName: (name: string) => boolean,
  atStreamEnd = false,
  options?: { hasLeadingText?: boolean },
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

  const hasTrailingText = text.slice(consumed).trim().length > 0;
  const hasSurroundingText = Boolean(options?.hasLeadingText) || hasTrailingText;

  if (Array.isArray(parsed)) {
    const toolCalls: JsonScannedToolCall[] = [];
    for (const item of parsed) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const extracted = extractSingleToolCall(
          item as Record<string, unknown>,
          toolSchemas,
          isValidName,
          isFenced,
          hasSurroundingText,
        );
        if (extracted.kind === "matched") {
          if (extracted.deferred && !atStreamEnd) {
            return { status: "incomplete" };
          }
          toolCalls.push(extracted.toolCall);
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
          const parsedArgs =
            typeof rawArgs === "string" ? (tryParseJsonObjectOrRepair(rawArgs) ?? {}) : rawArgs;
          const args =
            parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
              ? withoutForbiddenKeys(parsedArgs as Record<string, unknown>)
              : {};
          toolCalls.push({ name, args });
        }
      }
    }
    if (toolCalls.length > 0) {
      return { status: "complete", consumed, toolCalls };
    }
  }

  const single = extractSingleToolCall(
    record,
    toolSchemas,
    isValidName,
    isFenced,
    hasSurroundingText,
  );
  if (single.kind === "matched") {
    if (single.deferred && !atStreamEnd) {
      return { status: "incomplete" };
    }
    return { status: "complete", consumed, toolCall: single.toolCall };
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
