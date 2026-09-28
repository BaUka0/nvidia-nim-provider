import type { SkippedToolCall } from "./parser";

export function buildInvalidToolCallFallback(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  if (skippedToolCalls.some((toolCall) => toolCall.reason === "missing_payload")) {
    return "The model indicated a tool call but the stream did not include tool arguments. Retry the request.";
  }

  if (
    skippedToolCalls.length > 0 &&
    skippedToolCalls.every((toolCall) => toolCall.reason === "duplicate")
  ) {
    return `Tool call \`${skippedToolCalls[0].name}\` was not repeated because it already completed with the same arguments. Call it again only with different arguments.`;
  }

  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    const requiredArgs = skippedWithRequiredArgs.required.map((arg) => `\`${arg}\``).join(", ");
    return `Tool call \`${skippedWithRequiredArgs.name}\` was rejected: missing ${requiredArgs}. Retry with all required fields filled.`;
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return `Tool call \`${firstSkippedToolCall.name}\` had invalid arguments. Retry with a valid JSON object.`;
}

export function buildInvalidToolCallRetryMessage(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  if (skippedToolCalls.some((toolCall) => toolCall.reason === "missing_payload")) {
    return "The previous response finished with tool_calls but no tool function arguments were received. Retry with a native tool call containing complete JSON arguments.";
  }

  if (
    skippedToolCalls.length > 0 &&
    skippedToolCalls.every((toolCall) => toolCall.reason === "duplicate")
  ) {
    return `The previous tool call "${skippedToolCalls[0].name}" was identical to one that already completed. Call it again only with different arguments.`;
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
