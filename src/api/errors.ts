import { PROVIDER_DISPLAY_NAME } from "../shared/constants";

export type ApiErrorKind =
  | "auth_failed"
  | "rate_limited"
  | "model_unavailable"
  | "server_error"
  | "timeout"
  | "network_error"
  | "context_overflow"
  | "token_limit"
  | "empty_stream"
  | "invalid_request"
  | "unknown";

export interface ApiErrorContext {
  operation?: string;
  model?: string;
  status?: number;
  detail?: string;
  contextOverflow?: ContextOverflowInfo;
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
  context_overflow: {
    code: "CONTEXT_OVERFLOW",
    cause: "The prompt exceeds the model's context window limit.",
    action:
      "The request will be retried with a shorter response. If it fails again, start a new chat.",
  },
  token_limit: {
    code: "TOKEN_LIMIT_EXCEEDED",
    cause: "The conversation is too long for this model's context window.",
    action: "Start a new chat or switch to a model with a larger context window.",
  },
  empty_stream: {
    code: "EMPTY_STREAM",
    cause: "The model finished without returning any visible answer or tool call.",
    action: "Try again. If it repeats, lower the reasoning effort or switch to a different model.",
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

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 529]);

/**
 * Patterns that indicate the server rejected the request due to context overflow.
 * Covers common OpenAI-compatible and NVIDIA NIM error message formats.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /maximum.*context.*length/i,
  /context.*length.*exceed/i,
  /token.*limit.*exceed/i,
  /prompt.*too.*long/i,
  /prompt.*length.*exceed/i,
  /request.*too.*large/i,
  // "max token" variants require an explicit excess/limit verb so unrelated
  // 400s such as "invalid value for max_tokens" are not misclassified.
  /max(?:imum)?[^.\n]{0,40}tokens?\s+(?:limit\s+)?exceed(?:s|ed)?/i,
  /exceed(?:s|ed)?[^.\n]{0,40}max(?:imum)?[^.\n]{0,40}tokens?/i,
  /max(?:imum)?\s+(?:context\s+)?(?:length|tokens?)\s+(?:limit\s+)?(?:is|of)\s+\d/i,
];

/**
 * Extract reported maximum and actual usage from server error detail text.
 * Handles formats like:
 *   "Maximum context length is 204800 tokens"
 *   "prompt is too long: 1048576 > 1048575"
 *   "token limit exceeded: 1000001 > 1000000"
 */
export function parseContextOverflowDetail(detail: string): ContextOverflowInfo {
  const result: ContextOverflowInfo = {};

  // Try to extract reported maximum
  const maxMatch =
    detail.match(/(?:maximum|max|limit).*?context.*?length.*?(?:is|=|:|of)\s*(\d[\d_,]*)/i) ??
    detail.match(/(?:maximum|max|limit).*?(?:token|context).*?(?:is|=|:|of)\s*(\d[\d_,]*)/i) ??
    detail.match(/(?:is|=|>)\s*(\d[\d_,]*)(?:\s*(?:token|>))/i);
  if (maxMatch) {
    result.reportedMaximum = parseNumericValue(maxMatch[1]);
  }

  // Try to extract actual usage
  // The separator group must include 'has' to match NVIDIA NIM format:
  // "your message has 524288 tokens" — 'has' is the separator, not a word prefix.
  const usageMatch =
    // Dedicated pattern for NVIDIA NIM format: "your message has 524288 tokens"
    detail.match(/(?:has|had)\b\s+(\d[\d_,]*)/i) ??
    // NVIDIA NIM format: "your messages resulted in 270981 tokens"
    detail.match(/resulted\s+in\s+(\d[\d_,]*)/i) ??
    detail.match(/(?:prompt|usage|actual|got|have).*?(?:is|=|:|>)\s*(\d[\d_,]*)/i) ??
    detail.match(/(\d[\d_,]*)(?:\s*(?:>|token|\+))/i);
  if (usageMatch) {
    result.actualUsage = parseNumericValue(usageMatch[1]);
  }

  // Fallback: "N > M" pattern
  if (result.actualUsage === undefined && result.reportedMaximum === undefined) {
    const gtMatch = detail.match(/(\d[\d_,]*\s*>\s*\d[\d_,]*)/);
    if (gtMatch) {
      const nums = gtMatch[1].split(">").map((s) => parseNumericValue(s.trim()));
      if (nums.length === 2 && nums[0] !== undefined && nums[1] !== undefined) {
        result.actualUsage = nums[0];
        result.reportedMaximum = nums[1];
      }
    }
  }

  return result;
}

function parseNumericValue(s: string): number | undefined {
  const cleaned = s.replace(/[_,\s]/g, "");
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Check whether an error detail string indicates a context overflow.
 */
export function isContextOverflowError(detail: string | undefined): boolean {
  if (!detail) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(detail));
}

export interface ContextOverflowInfo {
  reportedMaximum?: number;
  actualUsage?: number;
}

export class NvidiaApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly status?: number;
  readonly operation?: string;
  readonly retryable: boolean;
  readonly contextOverflow?: ContextOverflowInfo;

  constructor(kind: ApiErrorKind, message: string, context: ApiErrorContext = {}) {
    super(message);
    this.name = "NvidiaApiError";
    this.kind = kind;
    this.code = ERROR_MESSAGES[kind]?.code ?? "NVIDIA_NIM_ERROR";
    this.status = context.status;
    this.operation = context.operation;
    this.retryable = context.status !== undefined && RETRYABLE_STATUS_CODES.has(context.status);
    this.contextOverflow = context.contextOverflow;

    if (typeof this.stack === "string") {
      const lines = this.stack.split("\n");
      const atIndex = lines.findIndex((line) => line.trimStart().startsWith("at "));
      if (atIndex > 0) {
        this.stack = lines.slice(atIndex).join("\n");
      }
    }
  }
}

export function createStructuredError(
  kind: ApiErrorKind,
  detail?: string,
  context: ApiErrorContext = {},
): NvidiaApiError {
  const message = formatStructuredError(kind, detail);
  return new NvidiaApiError(kind, message, context);
}

function parseHttpStatusFromText(text: string): number | undefined {
  const httpMatch = text.match(/\bHTTP\s+(\d{3})\b/i);
  if (httpMatch) {
    return Number(httpMatch[1]);
  }
  // RFC 7807 problem+json: {"title":"Gone","status":410,"detail":"..."}
  const rfcMatch = text.match(/"status"\s*:\s*(\d{3})/);
  if (rfcMatch) {
    return Number(rfcMatch[1]);
  }
  return undefined;
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
    const fromMessage = parseHttpStatusFromText(error.message);
    if (fromMessage !== undefined) {
      return fromMessage;
    }
  }
  if (typeof context.detail === "string" && context.detail.length > 0) {
    const fromDetail = parseHttpStatusFromText(context.detail);
    if (fromDetail !== undefined) {
      return fromDetail;
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
  if (status === 429 || status === 529) {
    return "rate_limited";
  }
  if (status === 404 || status === 410) {
    return "model_unavailable";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return "server_error";
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    // HTTP 400 may be a context overflow — refine in classifyApiError below
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
    cause = context.status === 529 ? "Service temporarily overloaded." : "Rate limited.";
  } else if (kind === "model_unavailable" && context.status === 410) {
    cause = context.model
      ? `NVIDIA NIM model "${context.model}" has reached end of life and is no longer available.`
      : "The NVIDIA NIM model has reached end of life and is no longer available.";
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
  let kind = classifyKind(error, status);
  // Refine HTTP 400: only classify as context_overflow when the detail
  // text matches known context-limit patterns; otherwise keep invalid_request.
  const detail = context.detail;
  if (kind === "invalid_request" && status === 400 && isContextOverflowError(detail)) {
    kind = "context_overflow";
  }
  const contextOverflow =
    kind === "context_overflow" && detail ? parseContextOverflowDetail(detail) : undefined;
  return new NvidiaApiError(kind, buildClassifiedMessage(kind, error, { ...context, status }), {
    ...context,
    status,
    contextOverflow,
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
