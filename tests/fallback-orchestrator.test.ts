import { NvidiaApiError } from "../src/api/errors";
import { DEFAULT_FALLBACK_CONFIG } from "../src/shared/config";
import { isFallbackEligibleError } from "../src/provider/fallback-orchestrator";

describe("isFallbackEligibleError", () => {
  const config = { ...DEFAULT_FALLBACK_CONFIG, enabled: true, priorityList: ["a"] };

  it("allows failover after a server_error or context_overflow when nothing visible was reported", () => {
    expect(
      isFallbackEligibleError(new NvidiaApiError("server_error", "502"), config, 0, false),
    ).toBe(true);
    expect(
      isFallbackEligibleError(new NvidiaApiError("context_overflow", "too long"), config, 0, false),
    ).toBe(true);
  });

  it("blocks failover after visible content", () => {
    expect(
      isFallbackEligibleError(new NvidiaApiError("rate_limited", "429"), config, 0, true),
    ).toBe(false);
  });

  it("allows failover for model_unavailable including HTTP 410 Gone", () => {
    expect(
      isFallbackEligibleError(
        new NvidiaApiError("model_unavailable", "gone", { status: 410 }),
        config,
        0,
        false,
      ),
    ).toBe(true);
  });

  it("does not treat invalid_request as fallback-eligible", () => {
    expect(
      isFallbackEligibleError(
        new NvidiaApiError("invalid_request", "bad request", { status: 400 }),
        config,
        0,
        false,
      ),
    ).toBe(false);
  });
});
