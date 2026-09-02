import * as vscode from "vscode";
import { LanguageModelChatMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import { ConfigManager, ToolsConfig } from "../shared/config";
import { MAX_REPAIRED_LINE_SPAN } from "../shared/constants";
import { AUXILIARY_BOOLEAN_FIELDS } from "../shared/tool-fields";
import { FORBIDDEN_TOOL_IDENTIFIERS } from "./embedded-parser";
import { parseToolArguments, tryParseJsonValue } from "./json-args";
import { isDirTool, isEditTool, isReadTool, isTerminalTool } from "./tool-kinds";

export { parseToolArguments, parseToolArgumentsStrict, tryParseJsonValue } from "./json-args";
export {
  buildInvalidToolCallFallback,
  buildInvalidToolCallRetryMessage,
} from "./invalid-call-messages";

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

export type SkippedToolCallReason = "invalid" | "duplicate" | "missing_payload";

export interface SkippedToolCall {
  name: string;
  required: string[];
  reason?: SkippedToolCallReason;
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
  extractedParams?: Record<string, unknown>;
}

export interface ChatRequestContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
  extractedParameters?: Record<string, unknown>;
  /** When set, extracted parameters may only fill a call of this tool name. */
  extractedParametersToolName?: string;
}

export function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(sortObjectKeys(args))}`;
}

export function isDuplicateSuppressionEnabled(
  toolName: string,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): boolean {
  if (!toolsConfig.suppressDuplicateReads) {
    return false;
  }
  if (isTerminalTool(toolName) || isEditTool(toolName) || isDirTool(toolName)) {
    return false;
  }
  return true;
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
  let normalized = normalizeScalar(value, schema);
  if (typeof normalized === "string") {
    const trimmed = normalized.trim();
    if (
      schema.type === "array" ||
      (!schema.type && trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      const parsed = tryParseJsonValue(trimmed);
      if (Array.isArray(parsed)) {
        normalized = parsed;
      }
    } else if (
      schema.type === "object" ||
      (!schema.type && trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      const parsed = tryParseJsonValue(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        normalized = parsed;
      }
    }
  }

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
  if (schema.type === "array" && Array.isArray(normalized)) {
    return schema.items
      ? normalized.map((item) => normalizeValue(item, schema.items!))
      : normalized;
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

export {
  findTrailingTokenPrefixStart,
  findTrailingTokenPrefixStartAny,
  unwrapJsonCodeFence,
  FORBIDDEN_TOOL_IDENTIFIERS,
  isValidToolIdentifier,
  parseEmbeddedToolParameterValue,
  stripKnownControlText,
  extractStandaloneXmlParameters,
  findControlTextTerminatorIndex,
  parseDeepSeekTextEmbeddedToolCallContent,
  parseTextEmbeddedToolCalls,
  getIncompleteTextToolCallName,
} from "./embedded-parser";

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

function fillMissingAuxiliaryBooleans(
  repaired: Record<string, unknown>,
  schema: ToolSchema | undefined,
): void {
  if (!schema?.required) {
    return;
  }

  for (const key of schema.required) {
    const current = repaired[key];
    if (current !== undefined && current !== null) {
      continue;
    }

    const property = schema.properties?.[key];
    if (property?.type !== "boolean") {
      continue;
    }
    if (!AUXILIARY_BOOLEAN_FIELDS.has(key.toLowerCase())) {
      continue;
    }

    const enumValues = property.enum?.filter((item): item is boolean => typeof item === "boolean");
    repaired[key] = enumValues && enumValues.length > 0 ? enumValues[0] : false;
  }
}

export function repairToolArguments(
  toolName: string,
  args: unknown,
  requestContext: ChatRequestContext | undefined,
  schema?: ToolSchema,
  toolsConfig: ToolsConfig = ConfigManager.getToolsConfig(),
): Record<string, unknown> {
  let parsedArgs: Record<string, unknown>;
  if (typeof args === "string") {
    try {
      parsedArgs = parseToolArguments(args);
    } catch {
      parsedArgs = {};
    }
  } else if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    parsedArgs = { ...(args as Record<string, unknown>) };
  } else {
    parsedArgs = {};
  }

  if (!toolsConfig.autoRepairArguments) {
    return parsedArgs;
  }

  const required = new Set(schema?.required ?? []);
  const needsStringField = (value: unknown, field: string): boolean =>
    required.has(field) && (typeof value !== "string" || value.trim().length === 0);
  const needsNumberField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "number";

  // 1. Merge extracted parameters from XML only when they belong to this tool
  // (or the destination schema explicitly lists the key). Unscoped bags never
  // fill file/command/content — that was a prompt-injection path.
  if (
    requestContext?.extractedParameters &&
    requestContext.extractedParametersToolName === toolName
  ) {
    const schemaKeys = Object.keys(schema?.properties ?? {});
    for (const [key, value] of Object.entries(requestContext.extractedParameters)) {
      if (FORBIDDEN_TOOL_IDENTIFIERS.has(key)) {
        continue;
      }
      if (schemaKeys.length > 0 && !schemaKeys.includes(key)) {
        continue;
      }
      if (!(key in parsedArgs) || parsedArgs[key] === undefined || parsedArgs[key] === "") {
        parsedArgs[key] = value;
      }
    }
  }

  // 2. Resolve common property aliases when required properties are missing
  const propertyAliasGroups: readonly (readonly string[])[] = [
    [
      "filePath",
      "targetFile",
      "target_file",
      "file",
      "filename",
      "file_path",
      "filepath",
      "uri",
      "destination",
      "dest",
      "AbsolutePath",
      "FilePath",
      "TargetFile",
    ],
    [
      "content",
      "code",
      "text",
      "data",
      "body",
      "file_content",
      "fileContent",
      "CodeContent",
      "ReplacementContent",
    ],
    [
      "startLine",
      "start",
      "fromLine",
      "from_line",
      "start_line",
      "StartLine",
      "start_offset",
      "startOffset",
    ],
    ["endLine", "end", "toLine", "to_line", "end_line", "EndLine", "end_offset", "endOffset"],
    [
      "path",
      "directory",
      "dir",
      "folder",
      "cwd",
      "targetDirectory",
      "SearchDirectory",
      "DirectoryPath",
      "Path",
    ],
    [
      "query",
      "pattern",
      "search_pattern",
      "searchPattern",
      "regex",
      "searchTerm",
      "search_term",
      "Query",
      "Pattern",
    ],
    ["command", "cmd", "script", "commandLine", "command_line", "CommandLine"],
  ];

  for (const reqKey of required) {
    if (parsedArgs[reqKey] === undefined || parsedArgs[reqKey] === "") {
      for (const group of propertyAliasGroups) {
        if (group.some((alias) => alias.toLowerCase() === reqKey.toLowerCase())) {
          for (const alias of group) {
            if (parsedArgs[alias] !== undefined && parsedArgs[alias] !== "") {
              parsedArgs[reqKey] = parsedArgs[alias];
              break;
            }
          }
          if (parsedArgs[reqKey] !== undefined && parsedArgs[reqKey] !== "") {
            break;
          }
        }
      }
    }
  }

  const repaired: Record<string, unknown> = normalizeArguments(parsedArgs, schema ?? {});

  const argumentsSchema = schema?.properties?.arguments;
  if (
    typeof repaired.arguments === "string" &&
    (!argumentsSchema || argumentsSchema.type === "object")
  ) {
    try {
      repaired.arguments = parseToolArguments(repaired.arguments);
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
      Object.assign(repaired, normalizeArguments(repaired, schema ?? {}));
    }
  }

  if (isTerminalTool(toolName)) {
    if (needsStringField(repaired.goal, "goal")) {
      if (typeof repaired.explanation === "string" && repaired.explanation.trim()) {
        repaired.goal = repaired.explanation;
      } else if (typeof repaired.command === "string" && repaired.command.trim()) {
        repaired.goal = `Run: ${repaired.command.slice(0, 60)}`;
      }
    }
    if (needsStringField(repaired.explanation, "explanation")) {
      if (typeof repaired.goal === "string" && repaired.goal.trim()) {
        repaired.explanation = repaired.goal;
      }
    }
    if (needsStringField(repaired.mode, "mode")) {
      repaired.mode = schema?.enumValues?.mode?.[0] ?? "sync";
    }
  }

  fillMissingAuxiliaryBooleans(repaired, schema);

  const context = requestContext;
  const currentFilePath =
    typeof repaired.filePath === "string" && repaired.filePath.trim().length > 0
      ? repaired.filePath
      : typeof repaired.AbsolutePath === "string" && repaired.AbsolutePath.trim().length > 0
        ? repaired.AbsolutePath
        : typeof repaired.TargetFile === "string" && repaired.TargetFile.trim().length > 0
          ? repaired.TargetFile
          : undefined;

  const isMatchingContextFile = Boolean(
    context?.filePath &&
    currentFilePath &&
    (currentFilePath === context.filePath ||
      currentFilePath.replace(/\\/g, "/") === context.filePath.replace(/\\/g, "/")),
  );

  const clampLineSpan = (
    startKey: "startLine" | "StartLine",
    endKey: "endLine" | "EndLine",
  ): void => {
    const start = repaired[startKey];
    const end = repaired[endKey];
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      end - start + 1 > MAX_REPAIRED_LINE_SPAN
    ) {
      repaired[endKey] = start + MAX_REPAIRED_LINE_SPAN - 1;
    }
  };

  if (isReadTool(toolName)) {
    // Do not invent filePath from regex-extracted chat context (prompt-injection).
    if (needsNumberField(repaired.startLine, "startLine")) {
      repaired.startLine = 1;
    }
    if (needsNumberField(repaired.StartLine, "StartLine")) {
      repaired.StartLine = 1;
    }
    if (needsNumberField(repaired.endLine, "endLine")) {
      const start = typeof repaired.startLine === "number" ? repaired.startLine : 1;
      repaired.endLine = start + MAX_REPAIRED_LINE_SPAN - 1;
    }
    if (needsNumberField(repaired.EndLine, "EndLine")) {
      const start = typeof repaired.StartLine === "number" ? repaired.StartLine : 1;
      repaired.EndLine = start + MAX_REPAIRED_LINE_SPAN - 1;
    }
    clampLineSpan("startLine", "endLine");
    clampLineSpan("StartLine", "EndLine");
    if (needsStringField(repaired.mode, "mode")) {
      repaired.mode = schema?.enumValues?.mode?.[0] ?? "full";
    }
  } else if (isEditTool(toolName)) {
    // Line ranges from editor selection apply only when the model already named
    // the same file. Missing filePath is not filled from chat text.
    if (isMatchingContextFile) {
      if (needsNumberField(repaired.startLine, "startLine") && context?.startLine !== undefined) {
        repaired.startLine = context.startLine;
      }
      if (needsNumberField(repaired.StartLine, "StartLine") && context?.startLine !== undefined) {
        repaired.StartLine = context.startLine;
      }
      if (needsNumberField(repaired.endLine, "endLine") && context?.endLine !== undefined) {
        repaired.endLine = context.endLine;
      }
      if (needsNumberField(repaired.EndLine, "EndLine") && context?.endLine !== undefined) {
        repaired.EndLine = context.endLine;
      }
    }
    clampLineSpan("startLine", "endLine");
    clampLineSpan("StartLine", "EndLine");
  }

  // Directory tools keep model-supplied path/cwd. Regex-extracted Cwd is not
  // copied in — that string is attacker-controlled prompt text.

  return normalizeArguments(repaired, schema ?? {});
}

export function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
