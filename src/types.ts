export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface OcGoContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OcGoChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OcGoContentPart[];
  name?: string;
  tool_calls?: OcGoToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OcGoToolCall {
  id: string;
  /** Optional index used in streaming tool call deltas */
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OcGoTool {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonObject };
}

export interface OcGoChatRequest {
  model: string;
  messages: OcGoChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  stop?: string | string[];
  tools?: OcGoTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; function: { name: string } };
}

export interface OcGoStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: OcGoToolCall[];
  };
  finish_reason: string | null;
}

export interface OcGoStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OcGoStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OcGoModelInfo {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
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

export const FALLBACK_MODELS: OcGoModelInfo[] = [
  {
    id: "glm-5",
    name: "GLM-5",
    displayName: "GLM-5",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    displayName: "GLM-5.1",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    displayName: "Kimi K2.5",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    displayName: "Kimi K2.6",
    contextWindow: 262144,
    maxOutput: 262144,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "mimo-v2-pro",
    name: "MiMo-V2-Pro",
    displayName: "MiMo-V2-Pro",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "mimo-v2-omni",
    name: "MiMo-V2-Omni",
    displayName: "MiMo-V2-Omni",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    displayName: "MiMo-V2.5-Pro",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    displayName: "MiMo-V2.5",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    displayName: "MiniMax M2.5",
    contextWindow: 196608,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    displayName: "MiniMax M2.7",
    contextWindow: 196608,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    displayName: "Qwen3.5 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    displayName: "Qwen3.6 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
  },
];
