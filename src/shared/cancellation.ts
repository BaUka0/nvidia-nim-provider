import { CancellationToken } from "vscode";

/**
 * A stream error counts as user cancellation when the token fired or the
 * abort surfaced as an AbortError. Shared by the attempt loop, the failover
 * chain, the stream pump, and turn reporting.
 */
export function isCancellation(err: unknown, token: CancellationToken): boolean {
  return token.isCancellationRequested || (err instanceof Error && err.name === "AbortError");
}
