// Re-export from new locations for backward compatibility
export type { LegacyPart } from "./messages/converter";
export type { ThinkTagFilterState, ThinkFilterSegment } from "./messages/think-filter";
export {
  convertMessages,
  convertTools,
  estimateTokens,
  estimateMessagesTokens,
  tryParseJSONObject,
  validateRequest,
  getTextPartValue,
} from "./messages/converter";
export {
  filterThinkTagsFromChunk,
  flushThinkTagFilter,
  stripThinkTags,
} from "./messages/think-filter";
