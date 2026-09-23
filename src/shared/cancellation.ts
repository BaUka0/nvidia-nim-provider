import { CancellationToken } from "vscode";
import { UNAVAILABLE_RETRY_MULTIPLIER } from "./constants";

/** AbortError used by fetch/stream cancellation so classifiers see a user abort. */
export function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * A stream error counts as user cancellation when the token fired or the
 * abort surfaced as an AbortError. Shared by the attempt loop, the failover
 * chain, the stream pump, and turn reporting.
 */
export function isCancellation(err: unknown, token: CancellationToken): boolean {
  return token.isCancellationRequested || (err instanceof Error && err.name === "AbortError");
}

/**
 * Exponential pause before a retry. HTTP 503 uses {@link UNAVAILABLE_RETRY_MULTIPLIER};
 * every other status keeps `baseMs` and `capMs` as given.
 */
export function exponentialRetryDelayMs(
  baseMs: number,
  exponent: number,
  capMs: number,
  status?: number,
): number {
  const scale = status === 503 ? UNAVAILABLE_RETRY_MULTIPLIER : 1;
  return Math.min(baseMs * scale * Math.pow(2, exponent), capMs * scale);
}

/**
 * Asynchronously waits for `delayMs` milliseconds, aborting immediately if `signal` fires.
 * In test environments, resolves immediately to avoid artificially slowing down unit test suites.
 */
export function waitForBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (delayMs <= 0 || process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    return Promise.resolve();
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
    if (signal?.aborted) {
      cleanup();
      rejectOnce(createAbortError());
    }
  });
}
