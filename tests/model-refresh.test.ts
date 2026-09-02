import { fetchModels } from "../src/api/client";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../src/api/key-resolver";
import { MODEL_LIST } from "../src/models/catalog";
import { NvidiaModelDiscoveryService } from "../src/models/discovery";
import { refreshModelsFromApi, resetRefreshQueue } from "../src/models/refresh";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  RAW_MODELS_STATE_KEY,
} from "../src/shared/constants";
import { outputLog } from "../src/shared/logging";

jest.mock("../src/api/client", () => ({
  fetchModels: jest.fn(),
}));

jest.mock("../src/shared/logging", () => ({
  ...jest.requireActual("../src/shared/logging"),
  debugLog: jest.fn(),
  outputLog: jest.fn(),
}));

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMutableGlobalState(
  initialValues: Record<string, unknown> = {},
  beforeUpdate?: (key: string, value: unknown) => void | Promise<void>,
) {
  const values = new Map<string, unknown>(Object.entries(initialValues));
  return {
    values,
    get: jest.fn((key: string) => values.get(key)),
    update: jest.fn(async (key: string, value: unknown) => {
      await beforeUpdate?.(key, value);
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }),
  };
}

describe("model cache key ownership and refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRefreshQueue();
  });

  it("uses the shared runtime provider-group key for manual refresh", async () => {
    const secrets = { get: jest.fn(async () => undefined) };
    const resolver = new NvidiaApiKeyResolver(secrets);
    resolver.rememberRuntimeKey("provider-group-key");
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-flash-0731", object: "model" },
    ]);
    const globalState = {
      get: jest.fn(() => undefined),
      update: jest.fn(async () => undefined),
    };
    const provider = { fireModelInfoChanged: jest.fn() };
    const context = {
      secrets,
      globalState,
    };

    await refreshModelsFromApi(
      context as never,
      "test-ua",
      { showMessages: false },
      provider as never,
      undefined,
      resolver,
    );

    expect(fetchModels).toHaveBeenCalledWith("provider-group-key", undefined, "test-ua");
    expect(globalState.update).toHaveBeenCalledWith(
      "nvidia-nim.modelsCacheKeyFingerprint",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(provider.fireModelInfoChanged).toHaveBeenCalledWith({
      invalidateModelCache: false,
    });
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("does not retain stale normalized models when a changed key returns no curated models", async () => {
    const oldModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash 0731",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    const globalState = {
      get: jest.fn((key: string) => {
        if (key === "nvidia-nim.models") return oldModels;
        if (key === "nvidia-nim.modelsCacheVersion") return MODELS_CACHE_VERSION;
        if (key === "nvidia-nim.modelsCacheKeyFingerprint") return "old-key-fingerprint";
        return undefined;
      }),
      update: jest.fn(async () => undefined),
    };
    const secrets = { get: jest.fn(async () => undefined) };
    (fetchModels as jest.Mock).mockResolvedValue([]);
    const discovery = new NvidiaModelDiscoveryService(
      secrets as never,
      "test-ua",
      globalState as never,
    );

    const models = await discovery.getAvailableModels("new-key", { refreshStaleCache: true });

    expect(models).toEqual([]);
    expect(fetchModels).toHaveBeenCalledWith("new-key", undefined, "test-ua");
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", []);
  });

  it("refreshes a legacy cache that has no key fingerprint before serving it", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash 0731",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    const globalState = {
      get: jest.fn((key: string) => {
        if (key === "nvidia-nim.models") return cachedModels;
        if (key === "nvidia-nim.modelsCacheVersion") return MODELS_CACHE_VERSION;
        return undefined;
      }),
      update: jest.fn(async () => undefined),
    };
    const secrets = { get: jest.fn(async () => undefined) };
    (fetchModels as jest.Mock).mockResolvedValue([]);
    const discovery = new NvidiaModelDiscoveryService(
      secrets as never,
      "test-ua",
      globalState as never,
    );

    await expect(discovery.getAvailableModels("new-key")).resolves.toEqual([]);
    expect(fetchModels).toHaveBeenCalledWith("new-key", undefined, "test-ua");
  });

  it("refreshes a cache written by an older cache version", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash 0731",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    const globalState = createMutableGlobalState({
      [MODELS_STATE_KEY]: cachedModels,
      [MODELS_CACHE_VERSION_STATE_KEY]: MODELS_CACHE_VERSION - 1,
      [MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY]: getApiKeyFingerprint("test-key"),
    });
    const secrets = { get: jest.fn(async () => undefined) };
    (fetchModels as jest.Mock).mockResolvedValue([{ id: "minimaxai/minimax-m3" }]);
    const discovery = new NvidiaModelDiscoveryService(
      secrets as never,
      "test-ua",
      globalState as never,
    );

    await expect(discovery.getAvailableModels("test-key")).resolves.toEqual([
      expect.objectContaining({ id: "minimaxai/minimax-m3" }),
    ]);

    expect(fetchModels).toHaveBeenCalledWith("test-key", undefined, "test-ua");
    expect(globalState.values.get(MODELS_CACHE_VERSION_STATE_KEY)).toBe(MODELS_CACHE_VERSION);
  });

  it("writes the raw and normalized cache through discovery", async () => {
    const rawModels = [{ id: "deepseek-ai/deepseek-v4-flash-0731" }];
    const globalState = createMutableGlobalState();
    const secrets = { get: jest.fn(async () => undefined) };
    (fetchModels as jest.Mock).mockResolvedValue(rawModels);
    const discovery = new NvidiaModelDiscoveryService(
      secrets as never,
      "test-ua",
      globalState as never,
    );

    await expect(discovery.fetchAvailableModels("test-key")).resolves.toHaveLength(1);

    expect(globalState.values.get(RAW_MODELS_STATE_KEY)).toEqual(rawModels);
    expect(globalState.values.get(MODELS_STATE_KEY)).toEqual([
      expect.objectContaining({ id: "deepseek-ai/deepseek-v4-flash-0731" }),
    ]);
    expect(globalState.values.get(MODELS_CACHE_VERSION_STATE_KEY)).toBe(MODELS_CACHE_VERSION);
    expect(globalState.values.get(MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY)).toBe(
      getApiKeyFingerprint("test-key"),
    );
  });

  it("filters malformed and non-curated normalized cache entries", () => {
    const curatedModel = {
      id: "deepseek-ai/deepseek-v4-flash-0731",
      displayName: "DeepSeek V4 Flash 0731",
      contextWindow: 1000000,
      maxOutputTokens: 384000,
      supportsTools: true,
      supportsVision: false,
    };
    const staleRuntimeModel = {
      ...curatedModel,
      id: "vendor/removed-model",
      displayName: "Removed Model",
    };
    const globalState = createMutableGlobalState({
      [MODELS_STATE_KEY]: [curatedModel, staleRuntimeModel, { id: "malformed" }],
    });
    const discovery = new NvidiaModelDiscoveryService(
      { get: jest.fn(async () => undefined) } as never,
      "test-ua",
      globalState as never,
    );

    expect(discovery.getNormalizedModels()).toEqual([curatedModel]);
  });

  it("serializes discovery rollback before a queued manual refresh write", async () => {
    const initialRawModels = [{ id: "deepseek-ai/deepseek-v4-flash-0731" }];
    const { adapter: _adapter, ...flashCatalog } = MODEL_LIST["deepseek-ai/deepseek-v4-flash-0731"];
    const initialNormalizedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        ...flashCatalog,
      },
    ];
    const discoveryRawModels = [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b" }];
    const manualRawModels = [{ id: "minimaxai/minimax-m3" }];
    const discoveryWriteBlocked = createDeferred();
    const failDiscoveryWrite = createDeferred();
    let shouldFailDiscoveryWrite = true;
    const globalState = createMutableGlobalState(
      {
        [RAW_MODELS_STATE_KEY]: initialRawModels,
        [MODELS_STATE_KEY]: initialNormalizedModels,
        [MODELS_CACHE_VERSION_STATE_KEY]: MODELS_CACHE_VERSION,
        [MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY]: "initial-fingerprint",
      },
      async (key, value) => {
        const normalized = Array.isArray(value) ? value[0] : undefined;
        if (
          shouldFailDiscoveryWrite &&
          key === MODELS_STATE_KEY &&
          normalized?.id === "nvidia/nemotron-3.5-lightning-30b-a3b"
        ) {
          shouldFailDiscoveryWrite = false;
          discoveryWriteBlocked.resolve();
          await failDiscoveryWrite.promise;
          throw new Error("discovery normalized write failed");
        }
      },
    );
    const secrets = { get: jest.fn(async () => undefined) };
    const discovery = new NvidiaModelDiscoveryService(
      secrets as never,
      "discovery-ua",
      globalState as never,
    );
    const provider = { fireModelInfoChanged: jest.fn() };
    const context = { secrets, globalState };
    (fetchModels as jest.Mock)
      .mockResolvedValueOnce(discoveryRawModels)
      .mockResolvedValueOnce(manualRawModels);

    const discoveryRefresh = discovery.fetchAvailableModels("discovery-key");
    await discoveryWriteBlocked.promise;
    const manualRefresh = refreshModelsFromApi(
      context as never,
      "manual-ua",
      { showMessages: false, apiKey: "manual-key" },
      provider as never,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchModels).toHaveBeenCalledTimes(1);
    failDiscoveryWrite.resolve();

    await expect(discoveryRefresh).resolves.toBeUndefined();
    await manualRefresh;

    expect(fetchModels).toHaveBeenNthCalledWith(2, "manual-key", undefined, "manual-ua");
    expect(globalState.values.get(RAW_MODELS_STATE_KEY)).toEqual(manualRawModels);
    expect(globalState.values.get(MODELS_STATE_KEY)).toEqual([
      expect.objectContaining({ id: "minimaxai/minimax-m3" }),
    ]);
    expect(globalState.values.get(MODELS_CACHE_VERSION_STATE_KEY)).toBe(MODELS_CACHE_VERSION);
    expect(globalState.values.get(MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY)).toBe(
      getApiKeyFingerprint("manual-key"),
    );
    expect(provider.fireModelInfoChanged).toHaveBeenCalledWith({
      invalidateModelCache: false,
    });
  });

  it("reports curated models missing during manual refresh", async () => {
    const globalState = createMutableGlobalState();
    const context = {
      secrets: { get: jest.fn(async () => undefined) },
      globalState,
    };
    (fetchModels as jest.Mock).mockResolvedValue([{ id: "deepseek-ai/deepseek-v4-flash" }]);

    await refreshModelsFromApi(
      context as never,
      "test-ua",
      { showMessages: false, apiKey: "test-key" },
      null,
    );

    expect(outputLog).toHaveBeenCalledWith(
      "models",
      expect.stringContaining(
        "Curated NVIDIA NIM models missing from the current API response: deepseek-ai/deepseek-v4-flash-0731",
      ),
    );
  });
});
