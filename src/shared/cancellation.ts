import { CancellationToken } from "vscode";

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
