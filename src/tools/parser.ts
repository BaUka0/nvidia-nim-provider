export { parseToolArguments, parseToolArgumentsStrict, tryParseJsonValue } from "./json-args";

export {
  buildInvalidToolCallFallback,
  buildInvalidToolCallRetryMessage,
} from "./invalid-call-messages";

export {
  ToolSchemaType,
  ToolPropertySchema,
  ToolSchema,
  getToolSchemaMap,
  normalizeProperties,
  normalizePropertySchema,
  normalizeScalar,
  normalizeValue,
  normalizeArguments,
  valuesEqual,
  isSchemaValueValid,
  validateToolArguments,
  hasRequiredToolArguments,
  isToolCallInput,
} from "./tool-schema";

export { ChatRequestContext, extractChatRequestContext } from "./request-context";

export { repairToolArguments, fillMissingAuxiliaryBooleans } from "./argument-repair";

export {
  buildToolCallCanonicalKey,
  isDuplicateSuppressionEnabled,
  sortObjectKeys,
  getCompletedToolCallKeys,
} from "./canonical-key";

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
