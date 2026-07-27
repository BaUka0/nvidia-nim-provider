import * as vscode from "vscode";
import { LanguageModelChatMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import { jsonrepair } from "jsonrepair";

function safeJsonParse(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return parseToolArgumentsStrict(text);
  } catch {
    // Repair is deliberately attempted only after strict JSON parsing fails.
  }

  try {
    return parseJsonObject(JSON.parse(jsonrepair(text)));
  } catch {
    throw new Error("Failed to parse JSON");
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Tool arguments must be a JSON object");
}

export function parseToolArguments(text: string): Record<string, unknown> {
  return safeJsonParse(text);
}

export function parseToolArgumentsStrict(text: string): Record<string, unknown> {
  return parseJsonObject(JSON.parse(text));
}

export type ToolSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface ToolPropertySchema {
  type?: ToolSchemaType;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, ToolPropertySchema>;
  items?: ToolPropertySchema;
}

export interface ToolSchema {
  required?: string[];
  enumValues?: Record<string, string[]>;
  properties?: Record<string, ToolPropertySchema>;
}

export interface SkippedToolCall {
  name: string;
  required: string[];
}

export interface ParsedTextToolCall {
  name: string;
  args: unknown;
}

export interface ParsedTextSegmentText {
  type: "text";
  text: string;
}

export interface ParsedTextSegmentToolCall {
  type: "toolCall";
  toolCall: ParsedTextToolCall;
}

export interface ParsedTextSegmentInvalidToolCall {
  type: "invalidToolCall";
  name: string;
}

export type ParsedTextSegment =
  | ParsedTextSegmentText
  | ParsedTextSegmentToolCall
  | ParsedTextSegmentInvalidToolCall;

export interface ParsedTextToolCallResult {
  segments: ParsedTextSegment[];
  incompleteText: string;
}

export interface ChatRequestContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
}

export function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(sortObjectKeys(args))}`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

export function getCompletedToolCallKeys(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
): Set<string> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    const hasNonToolResultContent = message.content.some((part) => {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      return !(typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content));
    });
    if (hasNonToolResultContent) {
      startIndex = i + 1;
      break;
    }
  }

  const completedCallIds = new Set<string>();

  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
        completedCallIds.add(toolResultPart.callId);
      }
    }
  }

  const keys = new Set<string>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolCallPart = part as { callId?: unknown; name?: unknown; input?: unknown };
      if (
        typeof toolCallPart.callId !== "string" ||
        !completedCallIds.has(toolCallPart.callId) ||
        typeof toolCallPart.name !== "string"
      ) {
        continue;
      }

      const repairedArgs = repairToolArguments(
        toolCallPart.name,
        toolCallPart.input ?? {},
        requestContext,
        toolSchemas.get(toolCallPart.name),
      );
      keys.add(buildToolCallCanonicalKey(toolCallPart.name, repairedArgs));
    }
  }

  return keys;
}

export function getToolSchemaMap(
  options: ProvideLanguageModelChatResponseOptions,
): Map<string, ToolSchema> {
  const map = new Map<string, ToolSchema>();
  for (const tool of options.tools ?? []) {
    const inputSchema = tool.inputSchema as
      | { required?: unknown; properties?: unknown }
      | undefined;
    const required = Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : undefined;
    const properties = normalizeProperties(inputSchema?.properties);
    const enumValues: Record<string, string[]> = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      const allowed = propertySchema.enum?.filter(
        (item): item is string => typeof item === "string",
      );
      if (allowed && allowed.length > 0) {
        enumValues[name] = allowed;
      }
    }
    map.set(tool.name, {
      required,
      enumValues,
      properties,
    });
  }
  return map;
}

function normalizeProperties(value: unknown): Record<string, ToolPropertySchema> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const properties: Record<string, ToolPropertySchema> = {};
  for (const [name, rawSchema] of Object.entries(value)) {
    if (typeof rawSchema !== "object" || rawSchema === null || Array.isArray(rawSchema)) {
      continue;
    }

    const schema = rawSchema as {
      type?: unknown;
      enum?: unknown;
      required?: unknown;
      properties?: unknown;
      items?: unknown;
    };
    const type =
      schema.type === "string" ||
      schema.type === "number" ||
      schema.type === "integer" ||
      schema.type === "boolean" ||
      schema.type === "object" ||
      schema.type === "array"
        ? schema.type
        : undefined;
    const property: ToolPropertySchema = {
      ...(type ? { type } : {}),
      ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
      ...(Array.isArray(schema.required)
        ? {
            required: schema.required.filter(
              (item): item is string => typeof item === "string" && item.length > 0,
            ),
          }
        : {}),
    };
    const nestedProperties = normalizeProperties(schema.properties);
    if (Object.keys(nestedProperties).length > 0) {
      property.properties = nestedProperties;
    }
    const nestedItems = normalizePropertySchema(schema.items);
    if (nestedItems) {
      property.items = nestedItems;
    }
    properties[name] = property;
  }
  return properties;
}

function normalizePropertySchema(value: unknown): ToolPropertySchema | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeProperties({ value });
  return normalized.value;
}

function normalizeScalar(value: unknown, schema: ToolPropertySchema): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (schema.type === "boolean") {
    if (["true", "yes", "1"].includes(trimmed.toLowerCase())) return true;
    if (["false", "no", "0"].includes(trimmed.toLowerCase())) return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const numberValue = Number(trimmed);
    if (trimmed.length > 0 && Number.isFinite(numberValue)) return numberValue;
  }
  return value;
}

function normalizeValue(value: unknown, schema: ToolPropertySchema): unknown {
  const normalized = normalizeScalar(value, schema);
  if (
    schema.type === "object" &&
    typeof normalized === "object" &&
    normalized !== null &&
    !Array.isArray(normalized)
  ) {
    return normalizeArguments(normalized as Record<string, unknown>, {
      properties: schema.properties,
    });
  }
  if (schema.type === "array" && Array.isArray(normalized) && schema.items) {
    return normalized.map((item) => normalizeValue(item, schema.items!));
  }
  return normalized;
}

function normalizeArguments(
  args: Record<string, unknown>,
  schema: ToolSchema,
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const normalized: Record<string, unknown> = { ...args };
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (name in normalized) {
      normalized[name] = normalizeValue(normalized[name], propertySchema);
    }
  }
  return normalized;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return typeof left === "object" && left !== null && typeof right === "object" && right !== null
    ? JSON.stringify(left) === JSON.stringify(right)
    : false;
}

function isSchemaValueValid(value: unknown, schema: ToolPropertySchema): boolean {
  if (schema.enum && !schema.enum.some((allowed) => valuesEqual(value, allowed))) {
    return false;
  }

  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        (!schema.items || value.every((item) => isSchemaValueValid(item, schema.items!)))
      );
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      return validateToolArguments(value, {
        required: schema.required,
        properties: schema.properties,
      });
    default:
      return true;
  }
}

export function validateToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  if (!schema || typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    const value = record[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return false;
    }
  }
  for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (name in record && !isSchemaValueValid(record[name], propertySchema)) {
      return false;
    }
  }
  return true;
}

export function hasRequiredToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  return validateToolArguments(args, schema);
}

export function buildInvalidToolCallFallback(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    const requiredArgs = skippedWithRequiredArgs.required.map((arg) => `\`${arg}\``).join(", ");
    return `Tool call \`${skippedWithRequiredArgs.name}\` was rejected: missing ${requiredArgs}. Retry with all required fields filled.`;
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return `Tool call \`${firstSkippedToolCall.name}\` had invalid arguments. Retry with a valid JSON object.`;
}

export function buildInvalidToolCallRetryMessage(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    const requiredList = skippedWithRequiredArgs.required.join(", ");
    return [
      `Your previous tool call "${skippedWithRequiredArgs.name}" was rejected because it was missing required arguments: ${requiredList}.`,
      `Retry NOW. Provide a valid JSON object containing ALL of: ${requiredList}.`,
      "Do not call any tool with an empty object or missing fields.",
      "Do not ask the user to retry. Do not explain the error.",
    ].join(" ");
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return [
    `Your previous tool call "${firstSkippedToolCall.name}" was rejected due to invalid or incomplete arguments.`,
    "Retry NOW with a complete, valid JSON object.",
    "Do not emit malformed JSON or empty arguments.",
    "Do not ask the user to retry. Do not explain what went wrong.",
  ].join(" ");
}

export function findTrailingTokenPrefixStart(text: string, token: string): number {
  const maxPrefixLength = Math.min(text.length, token.length - 1);
  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (text.endsWith(token.slice(0, prefixLength))) {
      return text.length - prefixLength;
    }
  }

  return -1;
}

export function findTrailingTokenPrefixStartAny(text: string, tokens: readonly string[]): number {
  let bestMatch = -1;

  for (const token of tokens) {
    const matchIndex = findTrailingTokenPrefixStart(text, token);
    if (matchIndex !== -1 && (bestMatch === -1 || matchIndex < bestMatch)) {
      bestMatch = matchIndex;
    }
  }

  return bestMatch;
}

export function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

export function stripKnownControlText(text: string): string {
  return text.replace(/<｜DSML｜[^\s<]*/g, "").replace(/<\|DSML\|>[^\s<]*/g, "");
}

export function findControlTextTerminatorIndex(text: string): number {
  const terminatorMatch = text.match(/[\s<]/);
  return terminatorMatch?.index ?? -1;
}

export function parseDeepSeekTextEmbeddedToolCallContent(
  content: string,
): { name: string; argsText: string } | undefined {
  const separatorToken = "<｜tool▁sep｜>";
  const separatorIndex = content.indexOf(separatorToken);
  if (separatorIndex === -1) {
    return undefined;
  }

  const afterSeparator = content.slice(separatorIndex + separatorToken.length).trim();
  if (!afterSeparator) {
    return undefined;
  }

  const newlineIndex = afterSeparator.indexOf("\n");
  const name =
    newlineIndex === -1 ? afterSeparator.trim() : afterSeparator.slice(0, newlineIndex).trim();
  const argsText =
    newlineIndex === -1 ? "" : unwrapJsonCodeFence(afterSeparator.slice(newlineIndex).trim());

  if (!name) {
    return undefined;
  }

  return {
    name,
    argsText,
  };
}

export function parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
  const beginToken = "<|tool_call_begin|>";
  const argBeginToken = "<|tool_call_argument_begin|>";
  const endToken = "<|tool_call_end|>";
  const deepSeekCallsBeginToken = "<｜tool▁calls▁begin｜>";
  const deepSeekCallBeginToken = "<｜tool▁call▁begin｜>";
  const deepSeekCallEndToken = "<｜tool▁call▁end｜>";
  const deepSeekCallsEndToken = "<｜tool▁calls▁end｜>";
  const unicodeDsmlToken = "<｜DSML｜";
  const asciiDsmlToken = "<|DSML|>";
  const partialTokens = [
    beginToken,
    deepSeekCallsBeginToken,
    deepSeekCallBeginToken,
    deepSeekCallsEndToken,
    unicodeDsmlToken,
    asciiDsmlToken,
  ] as const;

  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const appendText = (value: string): void => {
    const sanitizedValue = stripKnownControlText(value);
    if (!sanitizedValue) {
      return;
    }
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text") {
      lastSegment.text += sanitizedValue;
      return;
    }
    segments.push({ type: "text", text: sanitizedValue });
  };

  while (remaining.length > 0) {
    const tokenMatches = [
      { kind: "openai", token: beginToken, index: remaining.indexOf(beginToken) },
      {
        kind: "strip",
        token: deepSeekCallsBeginToken,
        index: remaining.indexOf(deepSeekCallsBeginToken),
      },
      {
        kind: "deepseek",
        token: deepSeekCallBeginToken,
        index: remaining.indexOf(deepSeekCallBeginToken),
      },
      {
        kind: "strip",
        token: deepSeekCallsEndToken,
        index: remaining.indexOf(deepSeekCallsEndToken),
      },
      {
        kind: "control",
        token: unicodeDsmlToken,
        index: remaining.indexOf(unicodeDsmlToken),
      },
      {
        kind: "control",
        token: asciiDsmlToken,
        index: remaining.indexOf(asciiDsmlToken),
      },
    ].filter((match) => match.index !== -1);

    tokenMatches.sort((left, right) => left.index - right.index);
    const nextTokenMatch = tokenMatches[0];

    if (!nextTokenMatch) {
      const partialBeginIndex = findTrailingTokenPrefixStartAny(remaining, partialTokens);
      if (partialBeginIndex === -1) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialBeginIndex));
        incompleteText = remaining.slice(partialBeginIndex);
      }
      break;
    }

    appendText(remaining.slice(0, nextTokenMatch.index));
    remaining = remaining.slice(nextTokenMatch.index + nextTokenMatch.token.length);

    if (nextTokenMatch.kind === "strip") {
      continue;
    }

    if (nextTokenMatch.kind === "control") {
      const terminatorIndex = findControlTextTerminatorIndex(remaining);
      if (terminatorIndex === -1) {
        incompleteText = nextTokenMatch.token + remaining;
        break;
      }

      remaining = remaining.slice(terminatorIndex);
      continue;
    }

    if (nextTokenMatch.kind === "deepseek") {
      const endIndex = remaining.indexOf(deepSeekCallEndToken);
      if (endIndex === -1) {
        incompleteText = nextTokenMatch.token + remaining;
        break;
      }

      const callText = remaining.slice(0, endIndex);
      remaining = remaining.slice(endIndex + deepSeekCallEndToken.length);

      const parsedToolCallContent = parseDeepSeekTextEmbeddedToolCallContent(callText);

      if (parsedToolCallContent) {
        try {
          const parsedArgs = parsedToolCallContent.argsText
            ? parseToolArgumentsStrict(parsedToolCallContent.argsText)
            : {};
          segments.push({
            type: "toolCall",
            toolCall: { name: parsedToolCallContent.name, args: parsedArgs },
          });
          continue;
        } catch {
          segments.push({ type: "invalidToolCall", name: parsedToolCallContent.name });
          continue;
        }
      }

      appendText(`${nextTokenMatch.token}${callText}${deepSeekCallEndToken}`);
      continue;
    }

    const argBeginIndex = remaining.indexOf(argBeginToken);
    const endIndex = remaining.indexOf(endToken);
    if (argBeginIndex === -1 || endIndex === -1 || argBeginIndex > endIndex) {
      incompleteText = beginToken + remaining;
      break;
    }

    const name = remaining.slice(0, argBeginIndex).trim();
    const argsText = remaining.slice(argBeginIndex + argBeginToken.length, endIndex).trim();
    remaining = remaining.slice(endIndex + endToken.length);

    if (!name) {
      continue;
    }

    try {
      segments.push({
        type: "toolCall",
        toolCall: { name, args: parseToolArgumentsStrict(argsText) },
      });
    } catch {
      segments.push({ type: "invalidToolCall", name });
    }
  }

  return { segments, incompleteText };
}

/**
 * Return the tool name from a text call that was cut off before its closing
 * control token. A partial control prefix without a name is treated as
 * display noise and remains suppressible by the stream parser.
 */
export function getIncompleteTextToolCallName(text: string): string | undefined {
  const openaiBeginToken = "<|tool_call_begin|>";
  const openaiArgumentToken = "<|tool_call_argument_begin|>";
  const openaiBeginIndex = text.indexOf(openaiBeginToken);
  if (openaiBeginIndex !== -1) {
    const callText = text.slice(openaiBeginIndex + openaiBeginToken.length);
    const argumentIndex = callText.indexOf(openaiArgumentToken);
    if (argumentIndex !== -1) {
      const name = callText.slice(0, argumentIndex).trim();
      return name || "unknown_tool";
    }
    // A stream can end after the function name but before the argument
    // marker. Preserve the name so the provider emits a controlled fallback
    // instead of silently dropping the incomplete tool request.
    const name = callText.split(/[\s<|]/u, 1)[0]?.trim();
    return name || undefined;
  }

  const deepSeekBeginToken = "<｜tool▁call▁begin｜>";
  const deepSeekBeginIndex = text.indexOf(deepSeekBeginToken);
  if (deepSeekBeginIndex !== -1) {
    const callText = text.slice(deepSeekBeginIndex + deepSeekBeginToken.length);
    const parsed = parseDeepSeekTextEmbeddedToolCallContent(callText);
    return parsed?.name || undefined;
  }

  return undefined;
}

export function extractChatRequestContext(
  messages: readonly LanguageModelChatMessage[],
): ChatRequestContext | undefined {
  const filePattern = /The user's current file is\s+([^\n]+?)\.(?:\s|$)/;
  const selectionPattern = /The current selection is from line\s+(\d+)\s+to line\s+(\d+)/;
  const cwdPattern = /(?:^|\n)Cwd:\s+([^\n]+)/;
  const context: ChatRequestContext = {};

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.content) {
      const text =
        part instanceof vscode.LanguageModelTextPart
          ? part.value
          : typeof part === "object" &&
              part !== null &&
              "value" in part &&
              typeof (part as { value?: unknown }).value === "string"
            ? (part as { value: string }).value
            : undefined;

      if (!text) {
        continue;
      }

      const fileMatch = text.match(filePattern);
      const selectionMatch = text.match(selectionPattern);
      const cwdMatch = text.match(cwdPattern);

      if (fileMatch && !context.filePath) {
        context.filePath = fileMatch[1].trim();
      }
      if (cwdMatch && !context.cwd) {
        context.cwd = cwdMatch[1].trim();
      }
      if (selectionMatch && context.startLine === undefined && context.endLine === undefined) {
        const startLine = Number(selectionMatch[1]);
        const endLine = Number(selectionMatch[2]);
        if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
          context.startLine = startLine;
          context.endLine = endLine;
        }
      }

      if (
        context.filePath &&
        context.cwd &&
        context.startLine !== undefined &&
        context.endLine !== undefined
      ) {
        break;
      }
    }
  }

  return context.filePath ||
    context.cwd ||
    context.startLine !== undefined ||
    context.endLine !== undefined
    ? context
    : undefined;
}

export function repairToolArguments(
  toolName: string,
  args: unknown,
  requestContext: ChatRequestContext | undefined,
  schema?: ToolSchema,
): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }

  const record = args as Record<string, unknown>;
  const required = new Set(schema?.required ?? []);
  const needsStringField = (value: unknown, field: string): boolean =>
    required.has(field) && (typeof value !== "string" || value.trim().length === 0);
  const needsNumberField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "number";

  const repaired: Record<string, unknown> = normalizeArguments({ ...record }, schema ?? {});

  const argumentsSchema = schema?.properties?.arguments;
  if (
    typeof repaired.arguments === "string" &&
    (!argumentsSchema || argumentsSchema.type === "object")
  ) {
    try {
      repaired.arguments = safeJsonParse(repaired.arguments);
    } catch {
      // Leave an invalid nested value for schema validation to reject.
    }
  }

  if (
    repaired.arguments &&
    typeof repaired.arguments === "object" &&
    !Array.isArray(repaired.arguments)
  ) {
    const inner = repaired.arguments as Record<string, unknown>;
    const outerRequiredKeys = schema?.required ?? [];
    const knownPropertyNames = Object.keys(schema?.properties ?? {});
    const hasRequiredInInner = outerRequiredKeys.some((k) => k in inner);
    const hasKnownPropertyInInner = knownPropertyNames.some((k) => k in inner);
    if (!schema?.properties?.arguments && (hasRequiredInInner || hasKnownPropertyInInner)) {
      for (const [key, value] of Object.entries(inner)) {
        if (!(key in repaired)) {
          repaired[key] = value;
        }
      }
      delete repaired.arguments;
    }
  }

  const context = requestContext;
  if (!context) {
    return normalizeArguments(repaired, schema ?? {});
  }

  if (toolName === "read_file") {
    return normalizeArguments(
      {
        ...repaired,
        ...(needsStringField(repaired.filePath, "filePath") && context.filePath
          ? { filePath: context.filePath }
          : {}),
        ...(needsNumberField(repaired.startLine, "startLine")
          ? { startLine: context.startLine ?? 1 }
          : {}),
        ...(needsNumberField(repaired.endLine, "endLine")
          ? { endLine: context.endLine ?? 200 }
          : {}),
      },
      schema ?? {},
    );
  }

  if (toolName === "list_dir") {
    return normalizeArguments(
      {
        ...repaired,
        ...(needsStringField(repaired.path, "path") && context.cwd ? { path: context.cwd } : {}),
      },
      schema ?? {},
    );
  }

  return normalizeArguments(repaired, schema ?? {});
}

export function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
