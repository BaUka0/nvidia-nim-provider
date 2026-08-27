import { MAX_FETCH_ATTEMPTS_PER_STREAM, MAX_TOTAL_FETCH_ATTEMPTS } from "./constants";

/**
 * Stream-invocation budget shared by every attempt of a single user-visible
 * response (empty-stream/network retries, overflow retry, summarization, and
 * every fallback hop).
 *
 * `consume()` charges one invocation and returns the HTTP-retry allowance for
 * that invocation. `maxHttpRetries: 0` means one try (no extra retries).
 * It never goes negative and returns 0 when exhausted.
 */
export class FetchAttemptBudget {
  private remainingValue: number;

  constructor(limit: number = MAX_TOTAL_FETCH_ATTEMPTS) {
    this.remainingValue = Math.max(0, limit);
  }

  get remaining(): number {
    return this.remainingValue;
  }

  get exhausted(): boolean {
    return this.remainingValue <= 0;
  }

  consume(maxPerCall: number = MAX_FETCH_ATTEMPTS_PER_STREAM): number {
    if (this.remainingValue <= 0) {
      return 0;
    }
    const want = Math.max(1, Math.min(maxPerCall, MAX_FETCH_ATTEMPTS_PER_STREAM));
    const granted = Math.min(want, this.remainingValue);
    this.remainingValue -= 1;
    return granted;
  }
}

/** Treat a configured retry count of 0 as "try once". */
export function httpAttemptsFromConfig(maxHttpRetries: number): number {
  return Math.max(1, maxHttpRetries);
}
