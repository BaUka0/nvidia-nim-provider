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
    return [
      "Your previous response finished with tool_calls but no tool function arguments were received.",
      "Retry NOW with a native tool call that includes the function name and a complete JSON arguments object.",
      "Do not emit an empty tool_calls array.",
      "Do not ask the user to retry. Do not explain the error.",
    ].join(" ");
  }

  if (
    skippedToolCalls.length > 0 &&
    skippedToolCalls.every((toolCall) => toolCall.reason === "duplicate")
  ) {
    return [
      `Your previous tool call "${skippedToolCalls[0].name}" was identical to one that already completed.`,
      "Retry NOW with different arguments (for read_file, pass a new startLine/endLine for the unread range).",
      "Do not ask the user to retry. Do not explain the error.",
    ].join(" ");
  }

  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (skippedWithRequiredArgs) {
    const requiredList = skippedWithRequiredArgs.required.join(", ");
    return [
      `Your previous tool call "${skippedWithRequiredArgs.name}" was rejected because it was missing required arguments: ${requiredList}.`,
      `Retry NOW. Provide a valid JSON object containing ALL of: ${requiredList}.`,
      "Do not call any tool with an empty object or missing fields.",
      "Do not ask the user to retry. Do not explain the error.",
    ].join(" ");
  }

  const firstSkippedToolCall = skippedToolCalls[0];
  if (!firstSkippedToolCall) {
    return undefined;
  }

  return [
    `Your previous tool call "${firstSkippedToolCall.name}" was rejected due to invalid or incomplete arguments.`,
    "Retry NOW with a complete, valid JSON object.",
    "Do not emit malformed JSON or empty arguments.",
    "Do not ask the user to retry. Do not explain what went wrong.",
  ].join(" ");
}
