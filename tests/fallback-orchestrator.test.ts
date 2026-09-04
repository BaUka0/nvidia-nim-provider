import { NvidiaApiError } from "../src/api/errors";
import { DEFAULT_FALLBACK_CONFIG } from "../src/shared/config";
import {
  fallbackCapacityLabel,
  isFallbackEligibleError,
} from "../src/provider/fallback-orchestrator";

describe("isFallbackEligibleError", () => {
  const config = { ...DEFAULT_FALLBACK_CONFIG, enabled: true, priorityList: ["a"] };

  it("allows failover after a server_error or context_overflow when the failing attempt reported nothing visible", () => {
    expect(
      isFallbackEligibleError(new NvidiaApiError("server_error", "502"), config, 0, false),
    ).toBe(true);
    expect(
      isFallbackEligibleError(new NvidiaApiError("context_overflow", "too long"), config, 0, false),
    ).toBe(true);
  });

  it("blocks failover after the failing attempt reported visible content", () => {
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

  it("allows failover for network_error when nothing visible was reported", () => {
    expect(
      isFallbackEligibleError(
        new NvidiaApiError("network_error", "fetch failed"),
        config,
        0,
        false,
      ),
    ).toBe(true);
  });
});

describe("fallbackCapacityLabel", () => {
  it("does not label overflow or server failures as rate limited", () => {
    expect(fallbackCapacityLabel(new NvidiaApiError("context_overflow", "too long"))).toBe(
      "Context overflow",
    );
    expect(fallbackCapacityLabel(new NvidiaApiError("token_limit", "too long"))).toBe(
      "Context overflow",
    );
    expect(fallbackCapacityLabel(new NvidiaApiError("server_error", "502", { status: 502 }))).toBe(
      "Server error",
    );
    expect(fallbackCapacityLabel(new NvidiaApiError("network_error", "offline"))).toBe(
      "Network error",
    );
    expect(fallbackCapacityLabel(new NvidiaApiError("rate_limited", "429", { status: 529 }))).toBe(
      "Overloaded",
    );
    expect(fallbackCapacityLabel(new NvidiaApiError("rate_limited", "429", { status: 429 }))).toBe(
      "Rate limited",
    );
    expect(
      fallbackCapacityLabel(
        new NvidiaApiError("empty_stream", "no content", { operation: "invalid_tool_call" }),
      ),
    ).toBe("Invalid tool call");
    expect(fallbackCapacityLabel(new NvidiaApiError("empty_stream", "no content"))).toBe(
      "Empty response",
    );
  });
});
