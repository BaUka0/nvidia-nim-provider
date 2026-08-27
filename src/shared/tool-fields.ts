/**
 * Schema `required` keys that are UX/metadata rather than payload. Stripped
 * from the model-facing schema so the model is not forced to invent them.
 */
export const AUXILIARY_REQUIRED_FIELDS = new Set([
  "goal",
  "explanation",
  "mode",
  "summary",
  "description",
  "isRegexp",
  "startLine",
  "endLine",
]);

/** Boolean metadata keys that may be defaulted when required but omitted. */
export const AUXILIARY_BOOLEAN_FIELDS = new Set([
  "isregexp",
  "isregex",
  "casesensitive",
  "recursive",
]);
