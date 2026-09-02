import { ConfigManager, ToolsConfig } from "../shared/config";
import { MAX_REPAIRED_LINE_SPAN } from "../shared/constants";
import { AUXILIARY_BOOLEAN_FIELDS } from "../shared/tool-fields";
import { FORBIDDEN_TOOL_IDENTIFIERS } from "./embedded-parser";
import { parseToolArguments } from "./json-args";
import { ChatRequestContext } from "./request-context";
import { isEditTool, isReadTool, isTerminalTool } from "./tool-kinds";
import { normalizeArguments, ToolSchema } from "./tool-schema";

export function fillMissingAuxiliaryBooleans(
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
