import { tryParseJsonObjectOrRepair } from "../shared/json-repair";

export type XmlToolKind =
  | "tool_calls"
  | "tool_call"
  | "function"
  | "invoke"
  | "parameter"
  | "tool_parameter";

export interface XmlScannedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type XmlScanResult =
  | {
      status: "complete";
      consumed: number;
      toolCall?: XmlScannedToolCall;
      extractedParams?: Record<string, unknown>;
    }
  | { status: "incomplete" }
  | { status: "not-a-tag"; skip: number };

interface ParsedXmlTag {
  kind: XmlToolKind;
  closing: boolean;
  name?: string;
  rawLength: number;
  incomplete: boolean;
}

interface StackFrame {
  kind: XmlToolKind;
  paramKey?: string;
}

const TOOL_KINDS = new Set<string>([
  "tool_calls",
  "tool_call",
  "function",
  "invoke",
  "parameter",
  "tool_parameter",
]);

const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*/;
const TAG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*/;

/**
 * True when `index` sits inside a JS/TS string or regex literal, e.g.
 * `const token = "<tool_calls>";` or `/^\s*<\/tool_calls>/`.
 * Real Hermes/Anthropic tool tags sit on their own line after prose.
 */
export function isTokenInStringOrRegexLiteral(text: string, index: number): boolean {
  if (index <= 0) {
    return false;
  }

  const prev = text[index - 1];
  if (prev === "\\" || prev === '"' || prev === "'" || prev === "`" || prev === "/") {
    return true;
  }

  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const scanFrom = Math.max(lineStart, index - 512);
  let inSingle = false;
  let inDouble = false;
  let inTick = false;
  for (let i = scanFrom; i < index; i += 1) {
    const ch = text[i];
    const escaped = i > scanFrom && text[i - 1] === "\\";
    if (escaped) {
      continue;
    }
    if (!inDouble && !inTick && ch === "'") {
      inSingle = !inSingle;
    } else if (!inSingle && !inTick && ch === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && ch === "`") {
      inTick = !inTick;
    }
  }
  return inSingle || inDouble || inTick;
}

export function indexOfUnquoted(text: string, token: string, from = 0, contextPrefix = ""): number {
  let pos = from;
  while (pos < text.length) {
    const index = text.indexOf(token, pos);
    if (index === -1) {
      return -1;
    }
    if (!isTokenInStringOrRegexLiteral(contextPrefix + text, contextPrefix.length + index)) {
      return index;
    }
    pos = index + 1;
  }
  return -1;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function asToolKind(name: string): XmlToolKind | undefined {
  const normalized = name.toLowerCase();
  return TOOL_KINDS.has(normalized) ? (normalized as XmlToolKind) : undefined;
}

function readXmlTag(text: string, index: number): ParsedXmlTag | undefined {
  if (text[index] !== "<") {
    return undefined;
  }

  let cursor = index + 1;
  if (cursor >= text.length) {
    return { kind: "tool_call", closing: false, rawLength: 0, incomplete: true };
  }

  const closing = text[cursor] === "/";
  if (closing) {
    cursor += 1;
    if (cursor >= text.length) {
      return { kind: "tool_call", closing: true, rawLength: 0, incomplete: true };
    }
  }

  const nameMatch = text.slice(cursor).match(TAG_NAME_RE);
  if (!nameMatch) {
    return undefined;
  }

  const kind = asToolKind(nameMatch[0]);
  if (!kind) {
    return undefined;
  }
  cursor += nameMatch[0].length;

  let name: string | undefined;
  if (!closing) {
    if (text[cursor] === "=") {
      cursor += 1;
      if (cursor >= text.length) {
        return { kind, closing: false, rawLength: 0, incomplete: true };
      }
      const valueMatch = text.slice(cursor).match(IDENT_RE);
      if (!valueMatch) {
        return { kind, closing: false, rawLength: 0, incomplete: true };
      }
      name = valueMatch[0];
      cursor += name.length;
    } else {
      cursor = skipWhitespace(text, cursor);
      const attrMatch = text.slice(cursor).match(/^name\s*=\s*"([^"]*)"/i);
      if (attrMatch) {
        name = attrMatch[1];
        cursor += attrMatch[0].length;
      }
    }
  }

  cursor = skipWhitespace(text, cursor);
  if (cursor >= text.length) {
    return { kind, closing, name, rawLength: 0, incomplete: true };
  }
  if (text[cursor] !== ">") {
    return undefined;
  }

  return {
    kind,
    closing,
    name,
    rawLength: cursor + 1 - index,
    incomplete: false,
  };
}

function findParameterClose(
  text: string,
  startIndex: number,
): { index: number; length: number } | undefined {
  let cursor = startIndex;
  while (cursor < text.length) {
    const lt = text.indexOf("<", cursor);
    if (lt === -1) {
      return undefined;
    }

    const slice = text.slice(lt);
    if (/^<\/parameter>/i.test(slice)) {
      return { index: lt, length: "</parameter>".length };
    }
    if (/^<\/tool_parameter>/i.test(slice)) {
      return { index: lt, length: "</tool_parameter>".length };
    }

    cursor = lt + 1;
  }
  return undefined;
}

function readBalancedJsonObject(
  text: string,
  startIndex: number,
): { json: string; end: number } | { incomplete: true } | undefined {
  if (text[startIndex] !== "{") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let cursor = startIndex; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { json: text.slice(startIndex, cursor + 1), end: cursor + 1 };
      }
    }
  }
  return { incomplete: true };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  return tryParseJsonObjectOrRepair(text);
}

function mergeQwenJson(
  jsonText: string,
  args: Record<string, unknown>,
  setName: (name: string) => void,
  isValidName: (name: string) => boolean,
): void {
  const parsed = parseJsonObject(jsonText);
  if (!parsed) {
    return;
  }

  const name = String(parsed.name ?? parsed.tool ?? parsed.function ?? "");
  if (name && isValidName(name)) {
    setName(name);
  }

  const inner =
    typeof parsed.arguments === "object" && parsed.arguments !== null
      ? parsed.arguments
      : typeof parsed.parameters === "object" && parsed.parameters !== null
        ? parsed.parameters
        : parsed;

  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    if (inner === parsed) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key === "name" || key === "tool" || key === "function") {
          continue;
        }
        args[key] = value;
      }
      return;
    }
    Object.assign(args, inner);
  }
}

function isParameterKind(kind: XmlToolKind): boolean {
  return kind === "parameter" || kind === "tool_parameter";
}

function isPlausibleToolContinuation(text: string, afterTag: number): "yes" | "no" | "incomplete" {
  const cursor = skipWhitespace(text, afterTag);
  if (cursor >= text.length) {
    return "incomplete";
  }
  if (text[cursor] === "{") {
    return "yes";
  }
  if (text[cursor] !== "<") {
    return "no";
  }

  const next = readXmlTag(text, cursor);
  if (!next) {
    return "no";
  }
  if (next.incomplete) {
    return "incomplete";
  }
  if (
    isParameterKind(next.kind) ||
    next.kind === "function" ||
    next.kind === "tool_call" ||
    next.kind === "invoke" ||
    next.kind === "tool_calls"
  ) {
    return "yes";
  }
  return "no";
}

function scanParameterValue(
  text: string,
  startIndex: number,
  parseValue: (raw: string) => unknown,
  key: string | undefined,
): XmlScanResult {
  const close = findParameterClose(text, startIndex);
  if (!close) {
    return { status: "incomplete" };
  }
  const extractedParams: Record<string, unknown> = {};
  if (key && !/^__proto__$|^prototype$|^constructor$/.test(key)) {
    extractedParams[key] = parseValue(text.slice(startIndex, close.index));
  }
  return {
    status: "complete",
    consumed: close.index + close.length,
    extractedParams,
  };
}

function scanToolRegion(
  text: string,
  firstTag: ParsedXmlTag,
  parseValue: (raw: string) => unknown,
  isValidName: (name: string) => boolean,
): XmlScanResult {
  const stack: StackFrame[] = [{ kind: firstTag.kind }];
  let cursor = firstTag.rawLength;
  let toolName = firstTag.name;
  const args: Record<string, unknown> = {};

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (isParameterKind(top.kind)) {
      const close = findParameterClose(text, cursor);
      if (!close) {
        return { status: "incomplete" };
      }
      if (top.paramKey) {
        args[top.paramKey] = parseValue(text.slice(cursor, close.index));
      }
      cursor = close.index + close.length;
      stack.pop();
      continue;
    }

    cursor = skipWhitespace(text, cursor);
    if (cursor >= text.length) {
      return { status: "incomplete" };
    }

    if (text[cursor] === "{") {
      const json = readBalancedJsonObject(text, cursor);
      if (!json) {
        return { status: "incomplete" };
      }
      if ("incomplete" in json) {
        return { status: "incomplete" };
      }
      mergeQwenJson(
        json.json,
        args,
        (name) => {
          toolName = name;
        },
        isValidName,
      );
      cursor = json.end;
      continue;
    }

    const tag = readXmlTag(text, cursor);
    if (tag?.incomplete) {
      return { status: "incomplete" };
    }
    if (!tag) {
      const nextLt = text.indexOf("<", cursor + 1);
      if (nextLt === -1) {
        return { status: "incomplete" };
      }
      cursor = nextLt;
      continue;
    }

    if (tag.closing) {
      if (tag.kind === top.kind) {
        stack.pop();
        cursor += tag.rawLength;
        continue;
      }
      if (tag.kind === "tool_call" || tag.kind === "invoke") {
        while (stack.length > 0 && stack[stack.length - 1].kind === "function") {
          stack.pop();
        }
        if (stack.length > 0 && stack[stack.length - 1].kind === tag.kind) {
          stack.pop();
          cursor += tag.rawLength;
          continue;
        }
      }
      cursor += tag.rawLength;
      continue;
    }

    if (isParameterKind(tag.kind)) {
      stack.push({ kind: tag.kind, paramKey: tag.name });
      cursor += tag.rawLength;
      continue;
    }
    if (tag.kind === "function") {
      if (tag.name) {
        toolName = tag.name;
      }
      stack.push({ kind: "function" });
      cursor += tag.rawLength;
      continue;
    }
    if (tag.kind === "tool_call" || tag.kind === "invoke") {
      if (tag.name) {
        toolName = tag.name;
      }
      stack.push({ kind: tag.kind });
      cursor += tag.rawLength;
      continue;
    }

    cursor += tag.rawLength;
  }

  if (toolName && isValidName(toolName)) {
    return {
      status: "complete",
      consumed: cursor,
      toolCall: { name: toolName, args },
    };
  }
  return { status: "complete", consumed: cursor };
}

export function findXmlConstructStart(text: string, contextPrefix = ""): number {
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt === -1) {
      return -1;
    }
    if (isTokenInStringOrRegexLiteral(contextPrefix + text, contextPrefix.length + lt)) {
      pos = lt + 1;
      continue;
    }
    const tag = readXmlTag(text, lt);
    if (tag?.incomplete) {
      return lt;
    }
    if (tag && !tag.closing) {
      return lt;
    }
    pos = lt + 1;
  }
  return -1;
}

export function scanXmlToolConstruct(
  text: string,
  parseValue: (raw: string) => unknown,
  isValidName: (name: string) => boolean,
): XmlScanResult {
  const tag = readXmlTag(text, 0);
  if (tag?.incomplete) {
    return { status: "incomplete" };
  }
  if (!tag) {
    return { status: "not-a-tag", skip: 1 };
  }
  if (tag.closing) {
    return { status: "complete", consumed: tag.rawLength };
  }
  if (tag.kind === "tool_calls") {
    const peek = isPlausibleToolContinuation(text, tag.rawLength);
    if (peek === "incomplete") {
      return { status: "incomplete" };
    }
    if (peek === "no") {
      return { status: "not-a-tag", skip: tag.rawLength };
    }
    return { status: "complete", consumed: tag.rawLength };
  }

  if (isParameterKind(tag.kind)) {
    const scanned = scanParameterValue(text, tag.rawLength, parseValue, tag.name);
    if (scanned.status !== "complete") {
      return scanned;
    }
    return {
      status: "complete",
      consumed: scanned.consumed,
      extractedParams: scanned.extractedParams,
    };
  }

  if (tag.kind === "tool_call" && !tag.name) {
    const peek = isPlausibleToolContinuation(text, tag.rawLength);
    if (peek === "incomplete") {
      return { status: "incomplete" };
    }
    if (peek === "no") {
      return { status: "not-a-tag", skip: tag.rawLength };
    }
  }

  if (tag.kind === "function") {
    if (!tag.name || !isValidName(tag.name)) {
      return { status: "not-a-tag", skip: tag.rawLength };
    }
    const peek = isPlausibleToolContinuation(text, tag.rawLength);
    if (peek === "incomplete") {
      return { status: "incomplete" };
    }
    if (peek === "no") {
      return { status: "not-a-tag", skip: tag.rawLength };
    }
  }

  if (tag.kind === "invoke" && (!tag.name || !isValidName(tag.name))) {
    return { status: "not-a-tag", skip: tag.rawLength };
  }

  return scanToolRegion(text, tag, parseValue, isValidName);
}

export function extractStandaloneXmlParameters(
  text: string,
  parseValue: (raw: string) => unknown,
): { cleanText: string; extractedParams: Record<string, unknown> } {
  const extractedParams: Record<string, unknown> = {};
  const cleanParts: string[] = [];
  let cursor = 0;
  let insideFence = false;

  while (cursor < text.length) {
    if (text.startsWith("```", cursor)) {
      insideFence = !insideFence;
      cleanParts.push("```");
      cursor += 3;
      continue;
    }
    if (insideFence) {
      cleanParts.push(text[cursor]);
      cursor += 1;
      continue;
    }

    const tag = readXmlTag(text, cursor);
    if (
      tag &&
      !tag.incomplete &&
      !tag.closing &&
      isParameterKind(tag.kind) &&
      !isTokenInStringOrRegexLiteral(text, cursor)
    ) {
      const scanned = scanParameterValue(text, cursor + tag.rawLength, parseValue, tag.name);
      if (scanned.status === "complete") {
        Object.assign(extractedParams, scanned.extractedParams);
        cursor = scanned.consumed;
        continue;
      }
      cleanParts.push(text.slice(cursor));
      break;
    }

    cleanParts.push(text[cursor]);
    cursor += 1;
  }

  return { cleanText: cleanParts.join(""), extractedParams };
}
