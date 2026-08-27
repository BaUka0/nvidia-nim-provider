import { NimChatMessage, NimChatRequest } from "../types";

/** Shallow-clone a request so a failed attempt cannot mutate the next one. */
export function cloneNimChatRequest(body: NimChatRequest): NimChatRequest {
  return {
    ...body,
    messages: body.messages.map(cloneNimChatMessage),
    tools: body.tools ? [...body.tools] : undefined,
    stop: Array.isArray(body.stop) ? [...body.stop] : body.stop,
    chat_template_kwargs: cloneJsonRecord(body.chat_template_kwargs),
    stream_options: body.stream_options ? { ...body.stream_options } : undefined,
  };
}

function cloneJsonRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function cloneNimChatMessage(message: NimChatMessage): NimChatMessage {
  return {
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
    tool_calls: message.tool_calls
      ? message.tool_calls.map((call) => ({
          ...call,
          function: { ...call.function },
        }))
      : undefined,
  };
}

export function appendChatMessage(body: NimChatRequest, message: NimChatMessage): NimChatRequest {
  const next = cloneNimChatRequest(body);
  next.messages = [...next.messages, message];
  return next;
}
