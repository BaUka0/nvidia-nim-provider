export { parseToolArguments, parseToolArgumentsStrict, tryParseJsonValue } from "./json-args";

export {
  buildInvalidToolCallFallback,
  buildInvalidToolCallRetryMessage,
} from "./invalid-call-messages";

export {
  ToolSchema,
  getToolSchemaMap,
  normalizeArguments,
  hasRequiredToolArguments,
  isValidToolArguments,
  missingRequiredToolArguments,
  isToolCallInput,
} from "./tool-schema";

export { ChatRequestContext, extractChatRequestContext } from "./request-context";

export { repairToolArguments } from "./argument-repair";

export {
  buildToolCallCanonicalKey,
  isDuplicateSuppressionEnabled,
  getCompletedToolCallKeys,
} from "./canonical-key";

export {
  isValidToolIdentifier,
  stripKnownControlText,
  extractStandaloneXmlParameters,
  parseTextEmbeddedToolCalls,
  getIncompleteTextToolCallName,
} from "./embedded-parser";

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
