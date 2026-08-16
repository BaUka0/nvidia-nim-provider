import {
  chatCompletion,
  fetchModels,
  fetchModelsOrThrow,
  fetchWithRetry,
  streamChatCompletion,
} from "../src/api/client";
import { classifyApiError } from "../src/api/errors";
import { STREAM_IDLE_TIMEOUT_MS } from "../src/shared/constants";
import { NvidiaModelSummary, NimStreamResponse } from "../src/types";
import { makeAbortSignal, makeFetchResponse } from "./helpers/fakes";

const rawModelSummaries: NvidiaModelSummary[] = [
  {
    id: "meta/llama-4-maverick-17b-128e-instruct",
    name: "Llama 4 Maverick 17B 128E Instruct",
    capabilities: {
      chat: true,
      vision: true,
      tool_calling: true,
    },
    metadata: {
      context_window: 262144,
      max_output_tokens: 8192,
    },
  },
];

describe("fetchWithRetry", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("releases a retryable response body before the next attempt", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const order: string[] = [];
    const firstBody = {
      cancel: jest.fn(async () => {
        order.push("cancel");
      }),
    };
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        order.push("fetch-1");
        return makeFetchResponse({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: { get: () => null },
          body: firstBody,
        });
      })
      .mockImplementationOnce(async () => {
        order.push("fetch-2");
        return makeFetchResponse({ ok: true, status: 200, statusText: "OK" });
      });

    const response = await fetchWithRetry("https://example.test", { method: "GET" }, 2);

    expect(response.ok).toBe(true);
    expect(firstBody.cancel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["fetch-1", "cancel", "fetch-2"]);
  });

  it("aborts promptly while waiting between retry attempts", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(1);
    const controller = new AbortController();
    const body = { cancel: jest.fn().mockResolvedValue(undefined) };
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: { get: () => null },
        body,
      }),
    );

    const request = fetchWithRetry(
      "https://example.test",
      { method: "GET", signal: controller.signal },
      3,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("observes an abort that races with retry-wait listener registration", async () => {
    jest.spyOn(Math, "random").mockReturnValue(1);
    const signal = makeAbortSignal({ getAborted: (reads) => reads >= 3 });
    const body = { cancel: jest.fn().mockResolvedValue(undefined) };
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: { get: () => null },
        body,
      }),
    );

    await expect(
      fetchWithRetry("https://example.test", { method: "GET", signal }, 3),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(signal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("classifies the final retryable HTTP status", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const body = { cancel: jest.fn().mockResolvedValue(undefined) };
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        body,
      }),
    );

    await expect(
      fetchWithRetry("https://example.test", { method: "GET" }, 2),
    ).rejects.toMatchObject({
      name: "NvidiaApiError",
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(body.cancel).toHaveBeenCalledTimes(2);
  });

  it("classifies a final network failure with an actionable message", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"));

    const error = await fetchWithRetry("https://example.test", { method: "GET" }, 1, {
      operation: "completion",
      model: "test-model",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "NvidiaApiError",
      kind: "network_error",
      code: "NETWORK_ERROR",
      operation: "completion",
    });
    expect((error as Error).message).toContain(
      "[NETWORK_ERROR] The request could not reach NVIDIA NIM.",
    );
    expect((error as Error).message).toContain(
      "Action: Check your network connection and try again.",
    );
  });
});

describe("classifyApiError", () => {
  it.each([
    [401, "AUTH_FAILED"],
    [404, "MODEL_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
    [529, "RATE_LIMITED"],
    [503, "SERVER_ERROR"],
  ])("maps HTTP %s to %s", (status, code) => {
    const error = classifyApiError(new Error(`HTTP ${status}`), {
      status,
      model: "test-model",
      operation: "stream",
    }) as Error & { code?: string };
    expect(error.code).toBe(code);
  });
});

describe("chatCompletion", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the shared authentication error classification", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid key",
      }),
    );

    await expect(
      chatCompletion("bad-key", { model: "test-model", messages: [] }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

describe("fetchModels", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns raw NVIDIA model summaries on success", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        json: async () => ({ data: rawModelSummaries }),
      }),
    );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(result?.[0]).toEqual(
      expect.objectContaining({
        id: "meta/llama-4-maverick-17b-128e-instruct",
        capabilities: expect.objectContaining({ vision: true, tool_calling: true }),
        metadata: expect.objectContaining({ context_window: 262144, max_output_tokens: 8192 }),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("returns null on failure", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid key",
      }),
    );

    const result = await fetchModels("bad-key");
    expect(result).toBeNull();
  });

  it("retries on network failure and succeeds", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: async () => ({ data: rawModelSummaries }),
        }),
      );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries up to 3 times then returns null", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

    const result = await fetchModels("test-key");
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 with Retry-After then succeeds", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: { get: (name: string) => (name === "retry-after" ? "1" : null) },
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: async () => ({ data: rawModelSummaries }),
        }),
      );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 then succeeds", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: { get: () => null },
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: async () => ({ data: rawModelSummaries }),
        }),
      );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("parses Retry-After as HTTP-date format", async () => {
    const retryDate = new Date(Date.now() + 100).toUTCString();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "retry-after": retryDate }),
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: async () => ({ data: rawModelSummaries }),
        }),
      );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("falls back to exponential backoff when Retry-After is unparseable", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "retry-after": "not-a-number" }),
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: async () => ({ data: rawModelSummaries }),
        }),
      );

    const result = await fetchModels("test-key");
    expect(result).toEqual(rawModelSummaries);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 401 and returns null immediately", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid key",
      }),
    );

    const result = await fetchModels("bad-key");
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves structured errors for strict model-list callers", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid key",
      }),
    );

    await expect(fetchModelsOrThrow("bad-key")).rejects.toMatchObject({
      name: "NvidiaApiError",
      code: "AUTH_FAILED",
      operation: "models",
    });
  });
});

describe("streamChatCompletion", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).fetch;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("yields parsed SSE chunks", async () => {
    const chunk: NimStreamResponse = {
      id: "1",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        body: stream,
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    const results: NimStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe("Hello");
  });

  it("throws on non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Server error",
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow("[SERVER_ERROR] Server error.");
  });

  it("throws authentication error on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid key",
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow(
      "[AUTH_FAILED] Authentication failed. Your API key may be invalid or expired.",
    );
  });

  it("identifies an unavailable model on 404", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Model not found",
      }),
    );

    const gen = streamChatCompletion("key", {
      model: "thinkingmachines/inkling",
      messages: [],
      stream: true,
    });
    await expect(gen.next()).rejects.toThrow(
      '[MODEL_UNAVAILABLE] NVIDIA NIM model "thinkingmachines/inkling" is not available',
    );
  });

  it("retries on 429 and eventually throws after exhausting retries", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name: string) => (name === "retry-after" ? "0" : null) },
        text: async () => "Rate limited",
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow("HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("honors a reduced maxFetchAttempts budget for stream connections", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name: string) => (name === "retry-after" ? "0" : null) },
        text: async () => "Rate limited",
      }),
    );

    const gen = streamChatCompletion(
      "key",
      { model: "kimi-k2.6", messages: [], stream: true },
      undefined,
      undefined,
      { maxFetchAttempts: 1 },
    );
    await expect(gen.next()).rejects.toThrow("HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles partial lines across chunks", async () => {
    const chunk: NimStreamResponse = {
      id: "1",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const jsonStr = JSON.stringify(chunk);
    const part1 = `data: ${jsonStr.slice(0, 10)}`;
    const part2 = `${jsonStr.slice(10)}\n\n`;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        body: stream,
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    const results: NimStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe("Hello");
  });

  it("skips malformed JSON lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {invalid json}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        body: stream,
      }),
    );

    const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
    const results: NimStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
  });

  it("uses dynamic idle timeout based on maxOutputTokens", async () => {
    const chunk: NimStreamResponse = {
      id: "1",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        body: stream,
      }),
    );

    const gen = streamChatCompletion(
      "test-key",
      {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: 100,
        temperature: 0,
      },
      new AbortController().signal,
      "test-agent",
      { maxOutputTokens: 500 },
    );

    for await (const _ of gen) {
      // consume
    }

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("observes an abort that races with stream listener registration", async () => {
    const signal = makeAbortSignal({ getAborted: (reads) => reads >= 3 });
    const reader = {
      read: jest.fn(() => new Promise(() => undefined)),
      cancel: jest.fn().mockResolvedValue(undefined),
      releaseLock: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse({
        ok: true,
        body: { getReader: () => reader },
      }),
    );

    const gen = streamChatCompletion(
      "key",
      { model: "kimi-k2.6", messages: [], stream: true },
      signal,
    );

    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).not.toHaveBeenCalled();
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(signal.removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cancels the reader when the stream idle timeout elapses", async () => {
    jest.useFakeTimers();

    try {
      const cancel = jest.fn().mockResolvedValue(undefined);
      const reader = {
        read: jest.fn(() => new Promise(() => undefined)),
        cancel,
        releaseLock: jest.fn(),
      };

      global.fetch = jest.fn().mockResolvedValue(
        makeFetchResponse({
          ok: true,
          body: {
            getReader: () => reader,
          },
        }),
      );

      const gen = streamChatCompletion("key", { model: "kimi-k2.6", messages: [], stream: true });
      const nextPromise = gen.next();
      const rejection = expect(nextPromise).rejects.toThrow(
        "NVIDIA NIM streaming timeout: no data received",
      );

      await jest.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);

      await rejection;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
