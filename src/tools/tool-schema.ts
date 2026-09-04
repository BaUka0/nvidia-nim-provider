import * as vscode from "vscode";
import { tryParseJsonValue } from "./json-args";

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

export function getToolSchemaMap(
  options: vscode.ProvideLanguageModelChatResponseOptions,
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

export function normalizeProperties(value: unknown): Record<string, ToolPropertySchema> {
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

export function normalizePropertySchema(value: unknown): ToolPropertySchema | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeProperties({ value });
  return normalized.value;
}

export function normalizeScalar(value: unknown, schema: ToolPropertySchema): unknown {
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

export function normalizeValue(value: unknown, schema: ToolPropertySchema): unknown {
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

export function normalizeArguments(
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

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return typeof left === "object" && left !== null && typeof right === "object" && right !== null
    ? JSON.stringify(left) === JSON.stringify(right)
    : false;
}

export function isSchemaValueValid(value: unknown, schema: ToolPropertySchema): boolean {
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

export function isValidToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  return validateToolArguments(args, schema);
}

/** @deprecated Use {@link isValidToolArguments}; kept as the historical name. */
export function hasRequiredToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  return isValidToolArguments(args, schema);
}

/** Required keys that are absent or empty after repair. Used for model retry text. */
export function missingRequiredToolArguments(
  args: unknown,
  schema: ToolSchema | undefined,
): string[] {
  const required = schema?.required ?? [];
  if (required.length === 0) {
    return [];
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [...required];
  }
  const record = args as Record<string, unknown>;
  return required.filter((key) => {
    const value = record[key];
    return (
      value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    );
  });
}

export function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
