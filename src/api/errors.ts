import { PROVIDER_DISPLAY_NAME } from "../shared/constants";

export type ApiErrorKind =
  | "auth_failed"
  | "rate_limited"
  | "model_unavailable"
  | "server_error"
  | "timeout"
  | "network_error"
  | "invalid_request"
  | "unknown";

export interface ApiErrorContext {
  operation?: string;
  model?: string;
  status?: number;
  detail?: string;
}

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
  model_unavailable: {
    code: "MODEL_UNAVAILABLE",
    cause: "The selected NVIDIA NIM model is not available for this API key or endpoint.",
    action: "Choose another model or refresh the NVIDIA NIM model list.",
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
  network_error: {
    code: "NETWORK_ERROR",
    cause: "The request could not reach NVIDIA NIM.",
    action: "Check your network connection and try again.",
  },
  invalid_request: {
    code: "INVALID_REQUEST",
    cause: "NVIDIA NIM rejected the request.",
    action: "Check the selected model, messages, and tool arguments, then try again.",
  },
  unknown: {
    code: "NVIDIA_NIM_ERROR",
    cause: "The NVIDIA NIM request failed.",
    action: "Try again. If the problem persists, switch models or inspect the debug log.",
  },
};

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

export class NvidiaApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly status?: number;
  readonly operation?: string;
  readonly retryable: boolean;

  constructor(kind: ApiErrorKind, message: string, context: ApiErrorContext = {}) {
    super(message);
    this.name = "NvidiaApiError";
    this.kind = kind;
    this.code = ERROR_MESSAGES[kind].code;
    this.status = context.status;
    this.operation = context.operation;
    this.retryable = context.status !== undefined && RETRYABLE_STATUS_CODES.has(context.status);
  }
}

function getErrorStatus(error: unknown, context: ApiErrorContext): number | undefined {
  if (context.status !== undefined) {
    return context.status;
  }
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
  }
  if (error instanceof Error) {
    const match = error.message.match(/\bHTTP\s+(\d{3})\b/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function classifyKind(error: unknown, status: number | undefined): ApiErrorKind {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 404) {
    return "model_unavailable";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return "server_error";
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    return "invalid_request";
  }

  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /\btimeout\b|timed out/i.test(error.message)) {
      return "timeout";
    }
    if (
      error.name === "TypeError" ||
      /network|fetch failed|econnreset|enotfound|socket|dns/i.test(error.message)
    ) {
      return "network_error";
    }
  }

  return "unknown";
}

function buildClassifiedMessage(
  kind: ApiErrorKind,
  error: unknown,
  context: ApiErrorContext,
): string {
  const structured = ERROR_MESSAGES[kind];
  const originalDetail = context.detail ?? (error instanceof Error ? error.message : String(error));
  const detail = originalDetail && originalDetail !== structured.cause ? originalDetail : undefined;

  let cause = structured.cause;
  if (kind === "auth_failed") {
    cause = "Authentication failed. Your API key may be invalid or expired.";
  } else if (kind === "rate_limited") {
    cause = "Rate limited.";
  } else if (kind === "model_unavailable" && context.model) {
    cause = `NVIDIA NIM model "${context.model}" is not available for this API key or endpoint.`;
  } else if (kind === "server_error") {
    cause = "Server error. The NVIDIA NIM service may be experiencing issues.";
  } else if (kind === "timeout" && context.operation === "stream") {
    cause = "NVIDIA NIM streaming timeout: no data received. The model may be stalled.";
  }

  const statusDetail =
    context.status !== undefined && !(detail ?? "").includes(`HTTP ${context.status}`)
      ? `HTTP ${context.status}${detail ? `: ${detail}` : ""}`
      : detail;
  return [
    `[${structured.code}] ${cause}`,
    statusDetail ? `Details: ${statusDetail}` : "",
    `Action: ${structured.action}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Convert HTTP, timeout, and network failures into one stable provider error.
 * Abort errors intentionally pass through so callers can distinguish cancellation.
 */
export function classifyApiError(error: unknown, context: ApiErrorContext = {}): Error {
  if (isAbortError(error)) {
    return error;
  }
  if (error instanceof NvidiaApiError) {
    return error;
  }

  const status = getErrorStatus(error, context);
  const kind = classifyKind(error, status);
  return new NvidiaApiError(kind, buildClassifiedMessage(kind, error, { ...context, status }), {
    ...context,
    status,
  });
}

export function isRetryableApiStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function formatStructuredError(key: string, detail?: string): string {
  const err = ERROR_MESSAGES[key];
  if (!err) return detail ?? "An unknown error occurred.";
  return [`[${err.code}] ${err.cause}`, detail ? `Details: ${detail}` : "", `Action: ${err.action}`]
    .filter(Boolean)
    .join("\n");
}
