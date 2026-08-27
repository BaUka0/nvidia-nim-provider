/**
 * Tool-call identifiers emitted to VS Code when the upstream stream does not
 * supply its own `id`.
 *
 * - Upstream `id` is always preferred when the model/gateway sends one.
 * - `tool_*` is assigned to native OpenAI-style streamed function calls.
 * - `text_tool_*` is assigned to tool calls recovered from embedded XML / DSML
 *   text rather than the `tool_calls` array.
 */
export const NATIVE_TOOL_CALL_ID_PREFIX = "tool_";
export const TEXT_EMBEDDED_TOOL_CALL_ID_PREFIX = "text_tool_";
