import { PROVIDER_DISPLAY_NAME } from "../shared/constants";

export interface StructuredError {
  code: string;
  cause: string;
  action: string;
}

export const ERROR_MESSAGES: Record<string, StructuredError> = {
  auth_failed: {
    code: "AUTH_FAILED",
    cause: "API key is invalid or expired.",
    action: "Update your API key via Command Palette > NVIDIA NIM: Manage API Key.",
  },
  rate_limited: {
    code: "RATE_LIMITED",
    cause: "Too many requests to NVIDIA NIM API.",
    action: "Wait a moment and try again. Consider switching to a different model.",
  },
  server_error: {
    code: "SERVER_ERROR",
    cause: `${PROVIDER_DISPLAY_NAME} service is experiencing issues.`,
    action: "Wait a few minutes and try again.",
  },
  timeout: {
    code: "STREAM_TIMEOUT",
    cause: "The model took too long to respond.",
    action: "Try again with a shorter prompt or switch to a faster model.",
  },
  token_limit: {
    code: "TOKEN_LIMIT_EXCEEDED",
    cause: "The conversation is too long for this model's context window.",
    action: "Start a new chat or switch to a model with a larger context window.",
  },
};

export function formatStructuredError(key: string, detail?: string): string {
  const err = ERROR_MESSAGES[key];
  if (!err) return detail ?? "An unknown error occurred.";
  return [`[${err.code}] ${err.cause}`, detail ? `Details: ${detail}` : "", `Action: ${err.action}`]
    .filter(Boolean)
    .join("\n");
}
