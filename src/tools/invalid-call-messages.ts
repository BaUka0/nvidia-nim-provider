import type { SkippedToolCall } from "./parser";

export function buildInvalidToolCallRetryMessage(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  if (skippedToolCalls.some((toolCall) => toolCall.reason === "missing_payload")) {
    return "The previous response finished with tool_calls but no tool function arguments were received. Retry with a native tool call containing complete JSON arguments.";
  }

  const truncated = skippedToolCalls.find((toolCall) => toolCall.reason === "truncated");
  if (truncated) {
    return `The previous tool call "${truncated.name}" was cut off before its arguments were complete, so it was not run. Call it again with complete JSON arguments; if they are long, split the change into smaller tool calls.`;
  }

  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    const requiredList = skippedWithRequiredArgs.required.join(", ");
    return `The previous tool call "${skippedWithRequiredArgs.name}" was missing required arguments: ${requiredList}. Provide a valid JSON object containing all required fields.`;
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return `The previous tool call "${firstSkippedToolCall.name}" was rejected due to invalid or incomplete arguments. Provide a complete, valid JSON arguments object.`;
}
