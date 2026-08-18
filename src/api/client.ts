import { ConfigManager } from "../shared/config";
import {
  BASE_RETRY_DELAY_MS,
  BASE_URL,
  MAX_RETRY_DELAY_MS,
  STREAM_IDLE_TIMEOUT_MAX_MS,
  STREAM_IDLE_TIMEOUT_MIN_MS,
} from "../shared/constants";
import { debugLog } from "../shared/logging";
import {
  NvidiaModelListResponse,
  NvidiaModelSummary,
  NimChatRequest,
  NimStreamResponse,
} from "../types";
import { classifyApiError, isRetryableApiStatus, NvidiaApiError } from "./errors";

/**
 * Determine whether an HTTP status code is safe to retry.
 * Retries on 429 (rate limit), 529 (overloaded), 502, 503, 504 (server errors).
 * Never retries on 400, 401, 403, 404, 422 (client errors).
 */
function isRetryableHttpError(status: number): boolean {
  return isRetryableApiStatus(status);
}

/**
 * Read Retry-After header value (seconds or HTTP-date) if present.
 */
function getRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers?.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const dateValue = Date.parse(raw);
  if (Number.isFinite(dateValue)) {
    const deltaMs = dateValue - Date.now();
    return deltaMs > 0 ? deltaMs : undefined;
  }

  return undefined;
}

/**
 * Calculate delay with exponential backoff and full jitter.
 * This prevents thundering herd when multiple clients retry simultaneously.
 */
function calculateRetryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined && retryAfter > 0) {
    // Add jitter to server-provided retry-after (±25%)
    const jitter = retryAfter * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.max(Math.round(retryAfter + jitter), 0), MAX_RETRY_DELAY_MS);
  }

  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  // Full jitter: random delay between 0 and cappedDelay
  return Math.round(Math.random() * cappedDelay);
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function cleanup(): void {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    }
    function resolveOnce(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function onAbort(): void {
      rejectOnce(createAbortError());
    }

    const timeoutId = setTimeout(resolveOnce, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal can be aborted between the pre-subscription check above and
    // registering the listener. Re-check after subscribing so that narrow
    // race cannot leave the retry sleeping until the full backoff expires.
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must never mask the original retryable failure.
  }
}

async function readResponseDetail(response: Response): Promise<string | undefined> {
  try {
    const detail = await response.text();
    return detail || undefined;
  } catch {
    return undefined;
  }
}

async function classifyResponseError(
  response: Response,
  context: { operation: string; model?: string },
): Promise<Error> {
  const detail = await readResponseDetail(response);
  return classifyApiError(new Error(`HTTP ${response.status} ${response.statusText}`), {
    ...context,
    status: response.status,
    detail,
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries?: number,
  errorContext: { operation?: string; model?: string } = {},
): Promise<Response> {
  const maxRetries = retries ?? ConfigManager.getNetworkConfig().maxHttpRetries;
  let lastError: Error | undefined;
  const signal = init.signal ?? undefined;
  const classificationContext = {
    operation: errorContext.operation ?? "request",
    ...(errorContext.model ? { model: errorContext.model } : {}),
  };
  for (let i = 0; i < maxRetries; i++) {
    throwIfAborted(signal);
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableHttpError(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      await discardResponseBody(response);
      if (i < maxRetries - 1) {
        const retryAfter = getRetryAfterMs(response);
        const delay = calculateRetryDelay(i, retryAfter);
        debugLog(
          "fetchWithRetry",
          `Attempt ${i + 1} failed with ${response.status}, retrying after ${delay}ms`,
        );
        await waitForRetry(delay, signal);
      } else {
        throw classifyApiError(lastError, { status: response.status, ...classificationContext });
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === "AbortError" || signal?.aborted) {
        throw lastError;
      }
      if (lastError instanceof NvidiaApiError) {
        throw lastError;
      }
      if (i < maxRetries - 1) {
        const delay = calculateRetryDelay(i);
        debugLog(
          "fetchWithRetry",
          `Attempt ${i + 1} failed with network error, retrying after ${delay}ms`,
        );
        await waitForRetry(delay, signal);
      } else {
        throw classifyApiError(lastError, classificationContext);
      }
    }
  }
  throw classifyApiError(
    lastError ?? new Error("Network request failed after retries"),
    classificationContext,
  );
}

export async function fetchModels(
  apiKey: string,
  signal?: AbortSignal,
  userAgent?: string,
): Promise<NvidiaModelSummary[] | null> {
  try {
    return await fetchModelsOrThrow(apiKey, signal, userAgent);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    debugLog("fetchModels", classifyApiError(error, { operation: "models" }));
    return null;
  }
}

/**
 * Fetch the model list while preserving structured API failures for callers
 * such as manual refresh. `fetchModels` remains the nullable compatibility
 * wrapper used by older integrations.
 */
export async function fetchModelsOrThrow(
  apiKey: string,
  signal?: AbortSignal,
  userAgent?: string,
  retries?: number,
): Promise<NvidiaModelSummary[]> {
  const response = await fetchWithRetry(
    `${BASE_URL}/models`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      signal,
    },
    retries ?? ConfigManager.getNetworkConfig().maxHttpRetries,
    { operation: "models" },
  );
  if (!response.ok) {
    throw await classifyResponseError(response, { operation: "models" });
  }

  try {
    const data = (await response.json()) as NvidiaModelListResponse;
    if (!Array.isArray(data.data)) {
      throw new Error("NVIDIA NIM models response did not contain a data array");
    }
    return data.data;
  } catch (error) {
    throw classifyApiError(error, { operation: "models" });
  }
}

export async function chatCompletion(
  apiKey: string,
  requestBody: NimChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
  retries?: number,
): Promise<string> {
  const response = await fetchWithRetry(
    `${BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      body: JSON.stringify({ ...requestBody, stream: false }),
      signal,
    },
    retries ?? ConfigManager.getNetworkConfig().maxHttpRetries,
    { operation: "completion", model: requestBody.model },
  );

  if (!response.ok) {
    throw await classifyResponseError(response, {
      operation: "completion",
      model: requestBody.model,
    });
  }

  try {
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    throw classifyApiError(error, { operation: "completion", model: requestBody.model });
  }
}

export interface StreamChatCompletionOptions {
  maxOutputTokens?: number;
  maxFetchAttempts?: number;
  idleTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
}

export async function* streamChatCompletion(
  apiKey: string,
  requestBody: NimChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
  options?: StreamChatCompletionOptions,
): AsyncGenerator<NimStreamResponse, void, unknown> {
  const fetchAttempts =
    options?.maxFetchAttempts ?? ConfigManager.getNetworkConfig().maxHttpRetries;
  const response = await fetchWithRetry(
    `${BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      body: JSON.stringify(requestBody),
      signal,
    },
    Math.max(1, fetchAttempts),
    { operation: "stream", model: requestBody.model },
  );

  if (!response.ok) {
    throw await classifyResponseError(response, {
      operation: "stream",
      model: requestBody.model,
    });
  }

  if (!response.body) {
    throw classifyApiError(new Error("No response body from NVIDIA NIM API"), {
      operation: "stream",
      model: requestBody.model,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const configuredIdleTimeoutMs =
    options?.idleTimeoutMs ?? ConfigManager.getNetworkConfig().streamIdleTimeout * 1000;

  const idleTimeoutMs = options?.maxOutputTokens
    ? Math.min(
        STREAM_IDLE_TIMEOUT_MAX_MS,
        Math.max(STREAM_IDLE_TIMEOUT_MIN_MS, Math.round(options.maxOutputTokens / 10) * 1000),
      )
    : configuredIdleTimeoutMs;

  const firstTokenTimeoutMs = options?.firstTokenTimeoutMs;
  let isFirstChunk = true;
  let buffer = "";
  let lastChunkTime = Date.now();

  function readWithTimeout() {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const currentTimeoutMs =
      isFirstChunk && typeof firstTokenTimeoutMs === "number" && firstTokenTimeoutMs > 0
        ? Math.min(idleTimeoutMs, firstTokenTimeoutMs)
        : idleTimeoutMs;

    return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (result: Awaited<ReturnType<typeof reader.read>>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };

      const onAbort = (): void => {
        void reader.cancel(createAbortError()).catch(() => undefined);
        rejectOnce(createAbortError());
      };

      const timeoutId = setTimeout(() => {
        const idleSec = Math.round((Date.now() - lastChunkTime) / 1000);
        const isFirstTokenTimeout =
          isFirstChunk &&
          typeof firstTokenTimeoutMs === "number" &&
          firstTokenTimeoutMs > 0 &&
          currentTimeoutMs === firstTokenTimeoutMs;
        const err = new Error(
          isFirstTokenTimeout
            ? `NVIDIA NIM first token timeout: no response received for ${idleSec}s`
            : `Stream idle timeout: no data for ${idleSec}s`,
        );
        err.name = "TimeoutError";
        void reader.cancel(err).catch(() => undefined);
        rejectOnce(err);
      }, currentTimeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the same check/subscribe race as waitForRetry(): an abort that
      // happens just before listener registration must still cancel the read
      // immediately instead of waiting for the idle timeout.
      if (signal?.aborted) {
        onAbort();
        return;
      }

      reader.read().then(
        (result) => {
          resolveOnce(result);
        },
        (error) => {
          rejectOnce(error);
        },
      );
    });
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout();
      if (done) break;

      isFirstChunk = false;
      lastChunkTime = Date.now();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as NimStreamResponse;
          yield parsed;
        } catch {
          // Ignore malformed lines
        }
      }
    }

    // Flush decoder internal state and process any remaining lines
    const remaining = decoder.decode();
    buffer += remaining;
    const finalLines = buffer.split("\n");
    for (const line of finalLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as NimStreamResponse;
        yield parsed;
      } catch {
        // Ignore malformed lines
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      const idleSec = Math.round((Date.now() - lastChunkTime) / 1000);
      const isFirstToken = error.message.includes("first token timeout");
      throw classifyApiError(
        new Error(
          isFirstToken
            ? `NVIDIA NIM first token timeout: no response received for ${idleSec}s`
            : `NVIDIA NIM streaming timeout: no data received for ${idleSec}s`,
        ),
        {
          operation: "stream",
          model: requestBody.model,
        },
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw classifyApiError(error, { operation: "stream", model: requestBody.model });
  } finally {
    reader.releaseLock();
  }
}
