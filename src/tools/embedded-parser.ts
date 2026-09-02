import { parseJsonOrRepair } from "../shared/json-repair";
import { parseToolArgumentsStrict } from "./json-args";
import type { ParsedTextSegment, ParsedTextToolCallResult } from "./parser";
import {
  extractStandaloneXmlParameters as scanStandaloneXmlParameters,
  findXmlConstructStart,
  indexOfUnquoted,
  isTokenInStringOrRegexLiteral,
  scanXmlToolConstruct,
} from "./xml-tool-scanner";

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

export const FORBIDDEN_TOOL_IDENTIFIERS = new Set(["__proto__", "prototype", "constructor"]);

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
    /^[\\[{\"]/.test(trimmed) ||
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

  const orphanClose = /<\/(?:tool_calls|tool_call|function|parameter|tool_parameter|invoke)>/gi;
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
  ] as const;

  const extractedParams: Record<string, unknown> = {};
  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const textContextPrefix = (): string =>
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
    const xmlStartIndex = findXmlConstructStart(remaining, accumulatedSoFar);

    const isInsideCodeFence = (offset: number): boolean => {
      const textUpToOffset = accumulatedSoFar + remaining.slice(0, offset);
      const matches = textUpToOffset.match(/```/g);
      return matches !== null && matches.length % 2 === 1;
    };

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
    ].filter((match) => match.index !== -1 && !isInsideCodeFence(match.index));

    tokenMatches.sort((left, right) => left.index - right.index);
    const nextTokenMatch = tokenMatches[0];

    if (!nextTokenMatch) {
      const partialBeginIndex = findTrailingTokenPrefixStartAny(remaining, partialTokens);
      if (
        partialBeginIndex === -1 ||
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
      );
      if (scanned.status === "incomplete") {
        incompleteText = remaining;
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

export function getIncompleteTextToolCallName(text: string): string | undefined {
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

  const xmlHermesMatch = text.match(/<tool_call>\s*<function=([a-zA-Z0-9_.-]+)/i);
  if (xmlHermesMatch) {
    return isValidToolIdentifier(xmlHermesMatch[1]) ? xmlHermesMatch[1].trim() : undefined;
  }

  const xmlStandardMatch = text.match(/<tool_call\s+name="([a-zA-Z0-9_.-]+)"/i);
  if (xmlStandardMatch) {
    return isValidToolIdentifier(xmlStandardMatch[1]) ? xmlStandardMatch[1].trim() : undefined;
  }

  const xmlInvokeMatch = text.match(/<invoke\s+name="([a-zA-Z0-9_.-]+)"/i);
  if (xmlInvokeMatch) {
    return isValidToolIdentifier(xmlInvokeMatch[1]) ? xmlInvokeMatch[1].trim() : undefined;
  }

  const xmlFunctionMatch = text.match(/<function=([a-zA-Z0-9_.-]+)/i);
  if (xmlFunctionMatch) {
    return isValidToolIdentifier(xmlFunctionMatch[1]) ? xmlFunctionMatch[1].trim() : undefined;
  }

  return undefined;
}
