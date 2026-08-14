import { NimAnalyzeImageTool, NimVisionClient } from "../src/tools/vision";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../src/api/key-resolver";
import { MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY } from "../src/shared/constants";

describe("NimVisionClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reads the NVIDIA NIM API key from secret storage", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
    };
    const client = new NimVisionClient(secrets as never);

    await expect(client.analyzeImage("data:image/png;base64,abc", "What is this?")).rejects.toThrow(
      "NVIDIA NIM API key not found",
    );
    expect(secrets.get).toHaveBeenCalledWith("nvidia-nim.apiKey");
  });

  it("rejects a remote image URL without touching the API key", async () => {
    const secrets = { get: jest.fn(async () => "test-key") };
    const client = new NimVisionClient(secrets as never);
    await expect(client.analyzeImage("https://example.com/cat.png", "What?")).rejects.toThrow(
      "requires a base64 image data URL",
    );
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("rejects a non-base64 data URL", async () => {
    const client = new NimVisionClient({ get: jest.fn() } as never);
    await expect(client.analyzeImage("data:image/png,raw-bytes", "What?")).rejects.toThrow(
      "requires a base64 image data URL",
    );
  });

  it("rejects oversized image payloads", async () => {
    const client = new NimVisionClient({ get: jest.fn() } as never);
    const oversizedBase64 = `data:image/png;base64,${"A".repeat(30 * 1024 * 1024)}`;
    await expect(client.analyzeImage(oversizedBase64, "What?")).rejects.toThrow(
      "image is too large",
    );
  });

  it("uses the cached NVIDIA vision model for image analysis", async () => {
    const secrets = {
      get: jest.fn(async () => "test-key"),
    };
    const modelStorage = {
      get: jest.fn(() => [
        {
          id: "minimaxai/minimax-m3",
          displayName: "NVIDIA Vision Model",
          vendor: "nvidia",
          family: "vision",
          contextWindow: 100000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
        },
      ]),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Image analysis" } }] }),
    });
    const client = new NimVisionClient(secrets as never, modelStorage as never);

    const result = await client.analyzeImage("data:image/png;base64,abc", "What is this?");

    expect(result).toBe("Image analysis");
    expect(fetch).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"minimaxai/minimax-m3"'),
      }),
    );
  });

  it("uses the refreshed cached vision model on the next analysis call", async () => {
    const secrets = { get: jest.fn(async () => undefined) };
    const resolver = new NvidiaApiKeyResolver(secrets);
    resolver.rememberRuntimeKey("provider-group-key", "NVIDIA NIM");
    const modelA = {
      id: "minimaxai/minimax-m3",
      displayName: "Vision Model A",
      contextWindow: 1000000,
      maxOutputTokens: 100000,
      supportsTools: true,
      supportsVision: true,
    };
    const modelB = {
      id: "moonshotai/kimi-k2.6",
      displayName: "Vision Model B",
      contextWindow: 256000,
      maxOutputTokens: 65536,
      supportsTools: true,
      supportsVision: true,
    };
    let cachedModels = [modelA];
    const modelStorage = {
      get: jest.fn((key: string) =>
        key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY
          ? getApiKeyFingerprint("provider-group-key")
          : cachedModels,
      ),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Image analysis" } }] }),
    });

    const client = new NimVisionClient(secrets as never, modelStorage as never, resolver);
    await client.analyzeImage("data:image/png;base64,abc", "First image");
    cachedModels = [modelB];
    await client.analyzeImage("data:image/png;base64,abc", "Second image");

    const requestedModels = (fetch as jest.Mock).mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).model,
    );
    expect(requestedModels).toEqual([modelA.id, modelB.id]);
  });

  it("does not fall back to a hardcoded vision model when cache has no vision model", async () => {
    const secrets = {
      get: jest.fn(async () => "test-key"),
    };
    const modelStorage = {
      get: jest.fn(() => []),
    };
    global.fetch = jest.fn();
    const client = new NimVisionClient(secrets as never, modelStorage as never);

    await expect(client.analyzeImage("data:image/png;base64,abc", "What is this?")).rejects.toThrow(
      "No NVIDIA NIM vision model is available",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies vision authentication failures with the shared API error", async () => {
    const secrets = {
      get: jest.fn(async () => "bad-key"),
    };
    const modelStorage = {
      get: jest.fn(() => [
        {
          id: "minimaxai/minimax-m3",
          displayName: "NVIDIA Vision Model",
          contextWindow: 100000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
        },
      ]),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid key",
    });

    const client = new NimVisionClient(secrets as never, modelStorage as never);

    await expect(
      client.analyzeImage("data:image/png;base64,abc", "What is this?"),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("classifies malformed vision responses with operation and model context", async () => {
    const secrets = {
      get: jest.fn(async () => "test-key"),
    };
    const modelStorage = {
      get: jest.fn(() => [
        {
          id: "minimaxai/minimax-m3",
          displayName: "NVIDIA Vision Model",
          contextWindow: 100000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
        },
      ]),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    const client = new NimVisionClient(secrets as never, modelStorage as never);

    await expect(
      client.analyzeImage("data:image/png;base64,abc", "What is this?"),
    ).rejects.toMatchObject({
      name: "NvidiaApiError",
      code: "NVIDIA_NIM_ERROR",
      operation: "vision",
    });
  });

  it("propagates cancellation from the tool invocation to the HTTP request", async () => {
    const secrets = {
      get: jest.fn(async () => "test-key"),
    };
    const modelStorage = {
      get: jest.fn(() => [
        {
          id: "minimaxai/minimax-m3",
          displayName: "NVIDIA Vision Model",
          contextWindow: 100000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
        },
      ]),
    };
    global.fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    let cancel: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn((listener: () => void) => {
        cancel = listener;
        return { dispose: jest.fn() };
      }),
    };
    const tool = new NimAnalyzeImageTool(secrets as never, modelStorage as never);
    const invocation = tool.invoke(
      { input: { image_data: "data:image/png;base64,abc", prompt: "What is this?" } } as never,
      token as never,
    );

    for (
      let attempt = 0;
      attempt < 10 && !(global.fetch as jest.Mock).mock.calls.length;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    cancel?.();

    await expect(invocation).rejects.toMatchObject({ name: "Cancelled" });
    const fetchCalls = (global.fetch as jest.Mock).mock.calls;
    expect(fetchCalls.length).toBeLessThanOrEqual(1);
    if (fetchCalls.length > 0) {
      expect(fetchCalls[0][1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("uses a runtime provider-group key when legacy SecretStorage is empty", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
    };
    const resolver = new NvidiaApiKeyResolver(secrets);
    resolver.rememberRuntimeKey("provider-group-key");
    const modelStorage = {
      get: jest.fn(() => [
        {
          id: "minimaxai/minimax-m3",
          displayName: "NVIDIA Vision Model",
          contextWindow: 100000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
        },
      ]),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Image analysis" } }] }),
    });

    const client = new NimVisionClient(secrets as never, modelStorage as never, resolver);
    await expect(client.analyzeImage("data:image/png;base64,abc", "What is this?")).resolves.toBe(
      "Image analysis",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer provider-group-key" }),
      }),
    );
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("uses the provider-group key that owns the cached vision model list", async () => {
    const secrets = { get: jest.fn(async () => undefined) };
    const resolver = new NvidiaApiKeyResolver(secrets);
    resolver.rememberRuntimeKey("key-a", "group-a");
    resolver.rememberRuntimeKey("key-b", "group-b");
    const modelStorage = {
      get: jest.fn((key: string) =>
        key === "nvidia-nim.modelsCacheKeyFingerprint"
          ? getApiKeyFingerprint("key-a")
          : [
              {
                id: "minimaxai/minimax-m3",
                displayName: "NVIDIA Vision Model",
                contextWindow: 100000,
                maxOutputTokens: 8192,
                supportsTools: true,
                supportsVision: true,
              },
            ],
      ),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Image analysis" } }] }),
    });

    const client = new NimVisionClient(secrets as never, modelStorage as never, resolver);
    await client.analyzeImage("data:image/png;base64,abc", "What is this?");

    expect(fetch).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer key-a" }),
      }),
    );
  });
});
