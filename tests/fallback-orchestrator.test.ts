import * as vscode from "vscode";
import { NvidiaApiError } from "../src/api/errors";
import { DEFAULT_FALLBACK_CONFIG } from "../src/shared/config";
import {
  buildFallbackModelInfo,
  fallbackCapacityLabel,
  isFallbackEligibleError,
  shouldRestartTimeoutChain,
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

  it("allows failover for rate_limited and empty_stream when nothing visible was reported", () => {
    expect(
      isFallbackEligibleError(new NvidiaApiError("rate_limited", "429"), config, 0, false),
    ).toBe(true);
    expect(
      isFallbackEligibleError(new NvidiaApiError("empty_stream", "0 chunks"), config, 0, false),
    ).toBe(true);
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

  it("does not fail over a history loop that is already stopped before a request", () => {
    expect(
      isFallbackEligibleError(
        new NvidiaApiError("empty_stream", "loop", { operation: "history_loop" }),
        config,
        0,
        false,
      ),
    ).toBe(false);
  });

  it("does not fail over an in-stream tool-call loop", () => {
    expect(
      isFallbackEligibleError(
        new NvidiaApiError("empty_stream", "loop", { operation: "tool_call_loop" }),
        config,
        0,
        false,
      ),
    ).toBe(false);
  });

  it("respects onFirstTokenTimeout setting for TTFT and connection timeouts", () => {
    const disabledFirstTokenConfig = { ...config, onFirstTokenTimeout: false };

    // First token timeout with onFirstTokenTimeout: false -> ineligible
    const firstTokenErr = new NvidiaApiError(
      "timeout",
      "NVIDIA NIM first token timeout: no response received for 120s",
      { timeoutKind: "first-token" },
    );
    expect(isFallbackEligibleError(firstTokenErr, disabledFirstTokenConfig, 0, false)).toBe(false);

    // Connection timeout with onFirstTokenTimeout: false -> ineligible
    const connectionErr = new NvidiaApiError(
      "timeout",
      "NVIDIA NIM connection timeout: no response received within 120s",
      { timeoutKind: "connection" },
    );
    expect(isFallbackEligibleError(connectionErr, disabledFirstTokenConfig, 0, false)).toBe(false);

    // Idle stream timeout with onFirstTokenTimeout: false -> still eligible because onTimeout: true
    const idleErr = new NvidiaApiError(
      "timeout",
      "NVIDIA NIM streaming timeout: no data received for 60s",
      { timeoutKind: "idle" },
    );
    expect(isFallbackEligibleError(idleErr, disabledFirstTokenConfig, 0, false)).toBe(true);

    // With default onFirstTokenTimeout: true -> eligible
    expect(isFallbackEligibleError(firstTokenErr, config, 0, false)).toBe(true);
    expect(isFallbackEligibleError(connectionErr, config, 0, false)).toBe(true);
  });
});

describe("shouldRestartTimeoutChain", () => {
  const config = { ...DEFAULT_FALLBACK_CONFIG, enabled: true, maxChainRestarts: 2 };

  it("restarts after a timeout with no visible content while restarts remain", () => {
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "stalled"),
        fallbackConfig: config,
        failingAttemptHasVisibleContent: false,
        chainRestarts: 0,
      }),
    ).toBe(true);
  });

  it("does not restart after visible content, non-timeout errors, or a spent budget", () => {
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "stalled"),
        fallbackConfig: config,
        failingAttemptHasVisibleContent: true,
        chainRestarts: 0,
      }),
    ).toBe(false);
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("rate_limited", "429"),
        fallbackConfig: config,
        failingAttemptHasVisibleContent: false,
        chainRestarts: 0,
      }),
    ).toBe(false);
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "stalled"),
        fallbackConfig: { ...config, maxChainRestarts: 0 },
        failingAttemptHasVisibleContent: false,
        chainRestarts: 0,
      }),
    ).toBe(false);
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "stalled"),
        fallbackConfig: config,
        failingAttemptHasVisibleContent: false,
        chainRestarts: 2,
      }),
    ).toBe(false);
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "stalled"),
        fallbackConfig: { ...config, onTimeout: false },
        failingAttemptHasVisibleContent: false,
        chainRestarts: 0,
      }),
    ).toBe(false);
    expect(
      shouldRestartTimeoutChain({
        err: new NvidiaApiError("timeout", "NVIDIA NIM first token timeout: 120s", {
          timeoutKind: "first-token",
        }),
        fallbackConfig: { ...config, onFirstTokenTimeout: false },
        failingAttemptHasVisibleContent: false,
        chainRestarts: 0,
      }),
    ).toBe(false);
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
    expect(
      fallbackCapacityLabel(
        new NvidiaApiError("empty_stream", "loop", { operation: "tool_call_loop" }),
      ),
    ).toBe("Loop detected");
    expect(
      fallbackCapacityLabel(
        new NvidiaApiError("empty_stream", "loop", { operation: "history_loop" }),
      ),
    ).toBe("Loop detected");
    expect(fallbackCapacityLabel(new NvidiaApiError("empty_stream", "no content"))).toBe(
      "Empty response",
    );
  });
});

describe("buildFallbackModelInfo", () => {
  const fallbackModel = {
    id: "deepseek-ai/deepseek-v4-flash-0731",
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
  };

  it("preserves __nvidiaNimRuntimeKeyBinding from source model info", () => {
    const source: vscode.LanguageModelChatInformation = {
      id: "meta/llama-3.3-70b-instruct",
      name: "Llama 3.3 70B Instruct",
      family: "llama",
      version: "1.0",
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      capabilities: {},
    };
    Object.defineProperty(source, "__nvidiaNimRuntimeKeyBinding", {
      value: "binding-uuid-1234",
      configurable: true,
      enumerable: false,
      writable: false,
    });

    const result = buildFallbackModelInfo(source, fallbackModel);
    expect(result.id).toBe(fallbackModel.id);
    expect(result.name).toBe(fallbackModel.displayName);
    const customProps = result as unknown as Record<string, unknown>;
    expect(customProps["__nvidiaNimRuntimeKeyBinding"]).toBe("binding-uuid-1234");
  });

  it("works normally when source model info has no runtime key binding", () => {
    const source: vscode.LanguageModelChatInformation = {
      id: "meta/llama-3.3-70b-instruct",
      name: "Llama 3.3 70B Instruct",
      family: "llama",
      version: "1.0",
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      capabilities: {},
    };

    const result = buildFallbackModelInfo(source, fallbackModel);
    expect(result.id).toBe(fallbackModel.id);
    const customProps = result as unknown as Record<string, unknown>;
    expect(customProps["__nvidiaNimRuntimeKeyBinding"]).toBeUndefined();
  });
});
