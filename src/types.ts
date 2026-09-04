export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export type NimContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface NimChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | NimContentPart[];
  name?: string;
  tool_calls?: NimToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface NimToolCall {
  id: string;
  /** Optional index used in streaming tool call deltas */
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NimTool {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonObject };
}

export interface NimChatRequest {
  model: string;
  messages: NimChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  tools?: NimTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; function: { name: string } };
  reasoning_effort?: string;
  enable_thinking?: boolean;
  chat_template_kwargs?: Record<string, unknown>;
  stream_options?: { include_usage: boolean };
}

export interface NimStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: NimToolCall[] | NimToolCall | string;
  };
  message?: {
    content?: string;
    tool_calls?: NimToolCall[] | NimToolCall | string;
  };
  finish_reason: string | null;
}

export interface NimStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: NimStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface NvidiaModelCapabilities {
  chat?: boolean;
  vision?: boolean;
  tool_calling?: boolean;
}

export interface NvidiaModelMetadata {
  context_window?: number;
  max_output_tokens?: number;
  max_tokens?: number;
}

export interface NvidiaModelSummary {
  id: string;
  name?: string;
  capabilities?: NvidiaModelCapabilities;
  metadata?: NvidiaModelMetadata;
}

export interface NvidiaModelListResponse {
  data?: NvidiaModelSummary[];
}
