import { parseJsonOrRepair } from "../shared/json-repair";
import { findTrailingPartialStart, findTrailingPartialStartAny } from "../messages/tag-scan";
import { parseToolArgumentsStrict } from "./json-args";
import type { ParsedTextSegment, ParsedTextToolCallResult } from "./parser";
import {
  extractStandaloneXmlParameters as scanStandaloneXmlParameters,
  findXmlConstructStart,
  indexOfUnquoted,
  isTokenInStringOrRegexLiteral,
  scanXmlToolConstruct,
} from "./xml-tool-scanner";
import { ToolSchema, FORBIDDEN_TOOL_IDENTIFIERS } from "./tool-schema";
import {
  buildKnownPropertySet,
  findJsonConstructStart,
  getIncompleteJsonToolCallName,
  scanJsonToolConstruct,
} from "./json-tool-scanner";

export { FORBIDDEN_TOOL_IDENTIFIERS } from "./tool-schema";

/** Case-sensitive trailing prefix — tool control tokens are exact. */
export function findTrailingTokenPrefixStart(text: string, token: string): number {
  return findTrailingPartialStart(text, token, true);
}

export function findTrailingTokenPrefixStartAny(text: string, tokens: readonly string[]): number {
  return findTrailingPartialStartAny(text, tokens, true);
}

export function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

export function isValidToolIdentifier(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 64 &&
    /^[a-zA-Z0-9_.-]+$/.test(trimmed) &&
    !FORBIDDEN_TOOL_IDENTIFIERS.has(trimmed)
  );
}

export function parseEmbeddedToolParameterValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if (
    /^[[{"]/.test(trimmed) ||
    /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(trimmed)
  ) {
    try {
      return parseJsonOrRepair(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function stripPatternOutsideLiterals(text: string, pattern: RegExp, contextPrefix = ""): string {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  return text.replace(global, (match, ...rest) => {
    const offset = rest[rest.length - 2] as number;
    return isTokenInStringOrRegexLiteral(contextPrefix + text, contextPrefix.length + offset)
      ? match
      : "";
  });
}

export function stripKnownControlText(text: string, contextPrefix = ""): string {
  const controlPatterns = [
    /<｜DSML｜[^\s<]*/g,
    /<\|DSML\|>[^\s<]*/g,
    /<\|python_tag\|>/g,
    /<\|start_header_id\|>.*?<\|end_header_id\|>/g,
    /<\|eot_id\|>/g,
    /<\|eom_id\|>/g,
    /<\|im_start\|>[^\n]*/g,
    /<\|im_end\|>/g,
    /<\|observation\|>/g,
    /<\|assistant\|>/g,
    /\[gMASK\]/g,
    /<sop>/g,
    /<eop>/g,
  ];

  let sanitized = text;
  for (const pattern of controlPatterns) {
    sanitized = stripPatternOutsideLiterals(sanitized, pattern, contextPrefix);
  }

  const orphanClose =
    /<\/(?:tool_calls|tool_call|function|parameter|tool_parameter|invoke)>|\(empty message\)|\[Request interrupted by user\]/gi;
  if (!sanitized.includes("```")) {
    return stripPatternOutsideLiterals(sanitized, orphanClose, contextPrefix);
  }

  const parts = sanitized.split(/(```[\s\S]*?```)/g);
  let walked = contextPrefix;
  return parts
    .map((part) => {
      const next = part.startsWith("```")
        ? part
        : stripPatternOutsideLiterals(part, orphanClose, walked);
      walked += part;
      return next;
    })
    .join("");
}

const TEMPLATE_TOKEN_PATTERN = /<[|｜][A-Za-z_][\w▁.-]{0,40}[|｜]>/g;

/**
 * Counts chat-template tokens such as `<|close|>` or `<｜end▁of▁sentence｜>`
 * left in reply text after `stripKnownControlText`, skipping fenced and inline
 * code. A healthy reply shows none outside code; several mean the deployment
 * is emitting garbage.
 */
export function countLeakedTemplateTokens(text: string): number {
  if (!text.includes("<|") && !text.includes("<｜")) {
    return 0;
  }
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
  return prose.match(TEMPLATE_TOKEN_PATTERN)?.length ?? 0;
}

export function extractStandaloneXmlParameters(text: string): {
  cleanText: string;
  extractedParams: Record<string, unknown>;
} {
  return scanStandaloneXmlParameters(text, parseEmbeddedToolParameterValue);
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

  if (!name || !isValidToolIdentifier(name)) {
    return undefined;
  }

  return {
    name,
    argsText,
  };
}

export function parseTextEmbeddedToolCalls(
  text: string,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
  options?: {
    atStreamEnd?: boolean;
    /** Text already emitted before `text`, e.g. from `TextParseContext.prefix()`. */
    contextPrefix?: string;
  },
): ParsedTextToolCallResult {
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
    "<tool_calls>",
    "<tool_call",
    "<function=",
    "<invoke ",
    "<parameter=",
    "<parameter name=",
    "<tool_parameter",
    "<|python_tag|>",
    "<|start_header_id|>",
    "<|im_start|>",
    "[gMASK]",
    "(empty message)",
    "[Request interrupted by user]",
    "```",
    "```json",
  ] as const;

  const knownProperties = buildKnownPropertySet(toolSchemas);
  const extractedParams: Record<string, unknown> = {};
  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const atStreamEnd = options?.atStreamEnd === true;
  const textContextPrefix = (): string =>
    (options?.contextPrefix ?? "") +
    segments.map((segment) => (segment.type === "text" ? segment.text : "")).join("");

  const appendText = (value: string): void => {
    const sanitizedValue = stripKnownControlText(value, textContextPrefix());
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
    const accumulatedSoFar = textContextPrefix();

    const isInsideCodeFence = (offset: number): boolean =>
      isPositionInsideCodeFence(accumulatedSoFar + remaining, accumulatedSoFar.length + offset);

    // A fenced example must not hide a real call that follows the fence, so
    // keep searching past candidates that sit inside a code fence.
    let xmlStartIndex = findXmlConstructStart(remaining, accumulatedSoFar);
    while (xmlStartIndex !== -1 && isInsideCodeFence(xmlStartIndex)) {
      xmlStartIndex = findXmlConstructStart(remaining, accumulatedSoFar, xmlStartIndex + 1);
    }
    let jsonStart = findJsonConstructStart(remaining, accumulatedSoFar, knownProperties);
    while (jsonStart && isInsideCodeFence(jsonStart.index)) {
      jsonStart = findJsonConstructStart(
        remaining,
        accumulatedSoFar,
        knownProperties,
        jsonStart.index + 1,
      );
    }

    const tokenMatches = [
      {
        kind: "openai" as const,
        token: beginToken,
        index: indexOfUnquoted(remaining, beginToken, 0, accumulatedSoFar),
      },
      {
        kind: "strip" as const,
        token: deepSeekCallsBeginToken,
        index: indexOfUnquoted(remaining, deepSeekCallsBeginToken, 0, accumulatedSoFar),
      },
      {
        kind: "deepseek" as const,
        token: deepSeekCallBeginToken,
        index: indexOfUnquoted(remaining, deepSeekCallBeginToken, 0, accumulatedSoFar),
      },
      {
        kind: "strip" as const,
        token: deepSeekCallsEndToken,
        index: indexOfUnquoted(remaining, deepSeekCallsEndToken, 0, accumulatedSoFar),
      },
      {
        kind: "control" as const,
        token: unicodeDsmlToken,
        index: indexOfUnquoted(remaining, unicodeDsmlToken, 0, accumulatedSoFar),
      },
      {
        kind: "control" as const,
        token: asciiDsmlToken,
        index: indexOfUnquoted(remaining, asciiDsmlToken, 0, accumulatedSoFar),
      },
      ...(xmlStartIndex !== -1
        ? [{ kind: "xml" as const, token: remaining[xmlStartIndex], index: xmlStartIndex }]
        : []),
      ...(jsonStart
        ? [{ kind: "json" as const, token: remaining[jsonStart.index], index: jsonStart.index }]
        : []),
    ].filter((match) => match.index !== -1 && !isInsideCodeFence(match.index));

    tokenMatches.sort((left, right) => left.index - right.index);
    const nextTokenMatch = tokenMatches[0];

    if (!nextTokenMatch) {
      const partialBeginIndex = findTrailingTokenPrefixStartAny(remaining, partialTokens);
      if (
        atStreamEnd ||
        partialBeginIndex === -1 ||
        isInsideCodeFence(partialBeginIndex) ||
        isTokenInStringOrRegexLiteral(
          accumulatedSoFar + remaining,
          accumulatedSoFar.length + partialBeginIndex,
        )
      ) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialBeginIndex));
        incompleteText = remaining.slice(partialBeginIndex);
      }
      break;
    }

    appendText(remaining.slice(0, nextTokenMatch.index));
    remaining = remaining.slice(nextTokenMatch.index);

    if (nextTokenMatch.kind === "strip") {
      remaining = remaining.slice(nextTokenMatch.token.length);
      continue;
    }

    if (nextTokenMatch.kind === "control") {
      remaining = remaining.slice(nextTokenMatch.token.length);
      const terminatorIndex = findControlTextTerminatorIndex(remaining);
      if (terminatorIndex === -1) {
        incompleteText = nextTokenMatch.token + remaining;
        break;
      }
      remaining = remaining.slice(terminatorIndex);
      continue;
    }

    if (nextTokenMatch.kind === "xml") {
      const scanned = scanXmlToolConstruct(
        remaining,
        parseEmbeddedToolParameterValue,
        isValidToolIdentifier,
        atStreamEnd,
      );
      if (scanned.status === "incomplete") {
        // At stream end nothing more will arrive: a cut-off call stays
        // incomplete so the caller can report it, anything else is text.
        if (atStreamEnd && !getIncompleteTextToolCallName(remaining, toolSchemas)) {
          appendText(remaining);
        } else {
          incompleteText = remaining;
        }
        break;
      }
      if (scanned.status === "not-a-tag") {
        appendText(remaining.slice(0, scanned.skip));
        remaining = remaining.slice(scanned.skip);
        continue;
      }
      if (scanned.extractedParams) {
        Object.assign(extractedParams, scanned.extractedParams);
      }
      if (scanned.toolCall) {
        segments.push({
          type: "toolCall",
          toolCall: scanned.toolCall,
        });
      }
      remaining = remaining.slice(scanned.consumed);
      continue;
    }

    if (nextTokenMatch.kind === "json") {
      const scanned = scanJsonToolConstruct(
        remaining,
        toolSchemas,
        isValidToolIdentifier,
        atStreamEnd,
      );
      if (scanned.status === "incomplete") {
        incompleteText = remaining;
        break;
      }
      if (scanned.status === "not-a-tool") {
        appendText(remaining.slice(0, scanned.skip));
        remaining = remaining.slice(scanned.skip);
        continue;
      }
      if (scanned.toolCalls && scanned.toolCalls.length > 0) {
        for (const tc of scanned.toolCalls) {
          segments.push({
            type: "toolCall",
            toolCall: tc,
          });
        }
      } else if (scanned.toolCall) {
        segments.push({
          type: "toolCall",
          toolCall: scanned.toolCall,
        });
      } else if (scanned.invalidToolCall) {
        segments.push({
          type: "invalidToolCall",
          name: scanned.invalidToolCall.name,
        });
      }
      remaining = remaining.slice(scanned.consumed);
      continue;
    }

    if (nextTokenMatch.kind === "deepseek") {
      const endIndex = remaining.indexOf(deepSeekCallEndToken);
      if (endIndex === -1) {
        incompleteText = remaining;
        break;
      }

      const callText = remaining.slice(nextTokenMatch.token.length, endIndex);
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

    // OpenAI format
    const argBeginIndex = remaining.indexOf(argBeginToken);
    const endIndex = remaining.indexOf(endToken);
    if (argBeginIndex === -1 || endIndex === -1 || argBeginIndex > endIndex) {
      incompleteText = remaining;
      break;
    }

    const name = remaining.slice(beginToken.length, argBeginIndex).trim();
    const argsText = remaining.slice(argBeginIndex + argBeginToken.length, endIndex).trim();
    remaining = remaining.slice(endIndex + endToken.length);

    if (!name || !isValidToolIdentifier(name)) {
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

  return { segments, incompleteText, extractedParams };
}

export function getIncompleteTextToolCallName(
  text: string,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): string | undefined {
  const openaiBeginToken = "<|tool_call_begin|>";
  const openaiArgumentToken = "<|tool_call_argument_begin|>";
  const openaiBeginIndex = text.indexOf(openaiBeginToken);
  if (openaiBeginIndex !== -1) {
    const callText = text.slice(openaiBeginIndex + openaiBeginToken.length);
    const argumentIndex = callText.indexOf(openaiArgumentToken);
    if (argumentIndex !== -1) {
      const name = callText.slice(0, argumentIndex).trim();
      return isValidToolIdentifier(name) ? name : undefined;
    }
    const name = callText.split(/[\s<|]/u, 1)[0]?.trim();
    return name && isValidToolIdentifier(name) ? name : undefined;
  }

  const deepSeekBeginToken = "<｜tool▁call▁begin｜>";
  const deepSeekBeginIndex = text.indexOf(deepSeekBeginToken);
  if (deepSeekBeginIndex !== -1) {
    const callText = text.slice(deepSeekBeginIndex + deepSeekBeginToken.length);
    const parsed = parseDeepSeekTextEmbeddedToolCallContent(callText);
    const name = parsed?.name?.trim();
    return name && isValidToolIdentifier(name) ? name : undefined;
  }

  const xmlHermesMatch = text.match(/<tool_call>\s*<function=\s*["']?([a-zA-Z0-9_.-]+)/i);
  if (xmlHermesMatch) {
    return isValidToolIdentifier(xmlHermesMatch[1]) ? xmlHermesMatch[1].trim() : undefined;
  }

  const xmlStandardMatch = text.match(/<tool_call\s+name=\s*["']?([a-zA-Z0-9_.-]+)/i);
  if (xmlStandardMatch) {
    return isValidToolIdentifier(xmlStandardMatch[1]) ? xmlStandardMatch[1].trim() : undefined;
  }

  const xmlInvokeMatch = text.match(/<invoke\s+name=\s*["']?([a-zA-Z0-9_.-]+)/i);
  if (xmlInvokeMatch) {
    return isValidToolIdentifier(xmlInvokeMatch[1]) ? xmlInvokeMatch[1].trim() : undefined;
  }

  const xmlFunctionMatch = text.match(/<function=\s*["']?([a-zA-Z0-9_.-]+)/i);
  if (xmlFunctionMatch) {
    return isValidToolIdentifier(xmlFunctionMatch[1]) ? xmlFunctionMatch[1].trim() : undefined;
  }

  const jsonName = getIncompleteJsonToolCallName(text, toolSchemas);
  if (jsonName) {
    return jsonName;
  }

  return undefined;
}

const CODE_FENCE_OPEN_RE = /^[ \t]*(`{3,})([^`]*)$/;
const CODE_FENCE_CLOSE_RE = /^[ \t]*(`{3,})[ \t]*$/;
const MAX_CONTEXT_LINE_CHARS = 2048;
const KEPT_CONTEXT_LINE_CHARS = 512;

function updateFenceLineState(openFenceTicks: number, rawLine: string): number {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (openFenceTicks === 0) {
    const openMatch = line.match(CODE_FENCE_OPEN_RE);
    return openMatch ? openMatch[1].length : 0;
  }
  const closeMatch = line.match(CODE_FENCE_CLOSE_RE);
  if (closeMatch && closeMatch[1].length >= openFenceTicks) {
    return 0;
  }
  return openFenceTicks;
}

function isOffsetInsideInlineBacktickSpan(line: string, offsetInLine: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const escaped = i > 0 && line[i - 1] === "\\";
    if (!escaped && !inDouble && ch === "'") {
      const precededByLetter = i > 0 && /[a-zA-Z]/.test(line[i - 1]);
      const next = line.slice(i + 1);
      const isContraction = precededByLetter && /^(?:s|t|ll|re|ve|d|m)(?![a-zA-Z])/i.test(next);
      const isPossessive =
        precededByLetter && !inSingle && (next.length === 0 || !/[a-zA-Z]/.test(next[0]));
      if (!isContraction && !isPossessive) {
        inSingle = !inSingle;
      }
      i += 1;
      continue;
    }
    if (!escaped && !inSingle && ch === '"') {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      let runEnd = i;
      while (runEnd < line.length && line[runEnd] === "`") {
        runEnd += 1;
      }
      const runLen = runEnd - i;
      if (i >= offsetInLine) {
        return false;
      }
      let closeIdx = -1;
      let cursor = runEnd;
      while (cursor < line.length) {
        if (line[cursor] === "`") {
          let closeEnd = cursor;
          while (closeEnd < line.length && line[closeEnd] === "`") {
            closeEnd += 1;
          }
          if (closeEnd - cursor === runLen) {
            closeIdx = cursor;
            break;
          }
          cursor = closeEnd;
        } else {
          cursor += 1;
        }
      }
      if (closeIdx !== -1) {
        if (offsetInLine >= runEnd && offsetInLine < closeIdx) {
          return true;
        }
        i = closeIdx + runLen;
        continue;
      }
      if (runLen >= 3 && /^[ \t]*$/.test(line.slice(0, i))) {
        return true;
      }
      i = runEnd;
      continue;
    }
    i += 1;
  }
  return false;
}

function isPositionInsideCodeFence(fullText: string, position: number): boolean {
  const prefix = fullText.slice(0, position);
  const lines = prefix.split("\n");
  let openFenceTicks = 0;
  for (let idx = 0; idx < lines.length - 1; idx += 1) {
    openFenceTicks = updateFenceLineState(openFenceTicks, lines[idx]);
  }
  if (openFenceTicks > 0) {
    return true;
  }
  const lastLinePrefix = lines[lines.length - 1];
  const lineEndIdx = fullText.indexOf("\n", position);
  const currentFullLine =
    lastLinePrefix +
    (lineEndIdx === -1 ? fullText.slice(position) : fullText.slice(position, lineEndIdx));
  return isOffsetInsideInlineBacktickSpan(currentFullLine, lastLinePrefix.length);
}

/**
 * Tracks text already emitted from a stream so the next parse call knows
 * whether it starts inside a code fence or mid-line. A fence opened in an
 * earlier chunk then still protects tool-call examples in later chunks.
 */
export class TextParseContext {
  private openFenceTicks = 0;
  private lineTail = "";

  append(text: string): void {
    if (!text) {
      return;
    }
    const combined = this.lineTail + text;
    const newlineIndex = combined.lastIndexOf("\n");
    if (newlineIndex !== -1) {
      this.settleLines(combined.slice(0, newlineIndex));
      this.lineTail = combined.slice(newlineIndex + 1);
    } else {
      this.lineTail = combined;
    }
    if (this.lineTail.length > MAX_CONTEXT_LINE_CHARS) {
      // Keep backtick runs whole and preserve non-whitespace line prefix state.
      let cut = this.lineTail.length - KEPT_CONTEXT_LINE_CHARS;
      while (cut > 0 && this.lineTail[cut - 1] === "`") {
        cut -= 1;
      }
      const hadNonWhitespacePrefix = !/^[ \t]*$/.test(this.lineTail.slice(0, cut));
      this.lineTail = (hadNonWhitespacePrefix ? "x" : "") + this.lineTail.slice(cut);
    }
  }

  prefix(): string {
    return (this.openFenceTicks > 0 ? `${"`".repeat(this.openFenceTicks)}\n` : "") + this.lineTail;
  }

  private settleLines(linesText: string): void {
    for (const line of linesText.split("\n")) {
      this.openFenceTicks = updateFenceLineState(this.openFenceTicks, line);
    }
  }
}
