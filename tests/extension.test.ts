import { fetchModels } from "../src/api/client";
import { NimChatModelProvider } from "../src/provider/chat-provider";
import packageJson from "../package.json";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateOutputChannel = jest.fn(() => ({
  appendLine: jest.fn(),
  show: jest.fn(),
  dispose: jest.fn(),
}));
const mockShowInformationMessage = jest.fn();
const mockShowWarningMessage = jest.fn();
const mockShowErrorMessage = jest.fn();
const mockShowInputBox = jest.fn();
const mockRegisterCommand = jest.fn(
  (command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return { dispose: jest.fn() };
  },
);
const mockExecuteCommand = jest.fn();
const mockRegisterLanguageModelChatProvider = jest.fn(() => ({ dispose: jest.fn() }));

jest.mock("../src/api/client", () => ({
  fetchModels: jest.fn(),
}));

let providerInstance: { fireModelInfoChanged: jest.Mock } | undefined;
jest.mock("../src/provider/chat-provider", () => ({
  NimChatModelProvider: jest.fn().mockImplementation(() => {
    providerInstance = {
      fireModelInfoChanged: jest.fn(),
    };
    return providerInstance;
  }),
}));

jest.mock("../src/tools/vision", () => ({
  registerNimTools: jest.fn(() => ({ dispose: jest.fn() })),
}));

const mockStatusBarOk = jest.fn();
const mockStatusBarRefresh = jest.fn();
const mockStatusBarError = jest.fn();
const mockStatusBarDispose = jest.fn();

jest.mock("../src/shared/status-bar", () => ({
  StatusBarManager: jest.fn().mockImplementation(() => ({
    showOk: mockStatusBarOk,
    showRefreshing: mockStatusBarRefresh,
    showError: mockStatusBarError,
    dispose: mockStatusBarDispose,
  })),
}));

jest.mock("vscode", () => ({
  SecretStorage: class {},
  Disposable: {
    from: jest.fn(),
  },
  EventEmitter: class {
    event = jest.fn();
    fire = jest.fn();
  },
  version: "1.104.0",
  window: {
    createOutputChannel: mockCreateOutputChannel,
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInputBox: mockShowInputBox,
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  lm: {
    registerLanguageModelChatProvider: mockRegisterLanguageModelChatProvider,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
}));

const flushAsyncWork = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("activate", () => {
  beforeEach(() => {
    registeredCommands.clear();
    jest.clearAllMocks();
    delete process.env.NVIDIA_NIM_DEBUG;
  });

  it("registers the NVIDIA NIM provider and management command on activation", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);

    expect(mockRegisterLanguageModelChatProvider).toHaveBeenCalledWith(
      "nvidia-nim",
      expect.anything(),
    );
    expect(mockRegisterCommand).toHaveBeenCalledWith("nvidia-nim.manage", expect.any(Function));
    expect(process.env.NVIDIA_NIM_DEBUG).toBe("0");
  });

  it("migrates a legacy API key into the VS Code language model provider group on activation", async () => {
    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    expect(mockExecuteCommand).toHaveBeenCalledWith("lm.migrateLanguageModelsProviderGroup", {
      vendor: "nvidia-nim",
      name: "NVIDIA NIM",
      apiKey: "test-key",
    });
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.legacyMigrationDone", true);
  });

  it("skips legacy API key migration on activation after the one-time migration has run", async () => {
    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === "nvidia-nim.debug") return false;
        if (key === "nvidia-nim.legacyMigrationDone") return true;
        return fallback;
      }),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    expect(mockExecuteCommand).not.toHaveBeenCalledWith(
      "lm.migrateLanguageModelsProviderGroup",
      expect.anything(),
    );
  });

  it("treats an already-existing VS Code model group as migrated", async () => {
    mockExecuteCommand.mockRejectedValueOnce(
      new Error("Language model group with name NVIDIA NIM already exists for vendor nvidia-nim"),
    );
    (fetchModels as jest.Mock).mockResolvedValue(null);
    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.legacyMigrationDone", true);
  });

  it("declares an API key configuration schema for VS Code model settings", () => {
    expect(packageJson.activationEvents).toContain("onLanguageModelChatProvider:nvidia-nim");

    const providerContribution = packageJson.contributes?.languageModelChatProviders?.find(
      (provider) => provider.vendor === "nvidia-nim",
    );

    expect(
      (providerContribution as { managementCommand?: string } | undefined)?.managementCommand,
    ).toBeUndefined();
    expect(providerContribution?.configuration?.properties?.apiKey).toEqual(
      expect.objectContaining({
        type: "string",
        secret: true,
      }),
    );
    expect(providerContribution?.configuration?.required).toContain("apiKey");

    expect(packageJson.contributes?.languageModelTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "nvidia_nim_analyze_image",
          toolReferenceName: "nvidia_nim_analyze_image",
          inputSchema: expect.objectContaining({
            required: expect.arrayContaining(["image_data", "prompt"]),
          }),
        }),
      ]),
    );
  });

  it("refreshes cached models in the background on activation when an API key exists", async () => {
    const rawModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: { chat: true, tool_calling: true, vision: true },
        metadata: { context_window: 128000, max_output_tokens: 8192 },
      },
      {
        id: "nvidia/nv-embedqa-e5-v5",
        name: "Embed QA",
        capabilities: { chat: false },
      },
    ];
    (fetchModels as jest.Mock).mockResolvedValue(rawModels);

    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const providerInstance = (NimChatModelProvider as jest.Mock).mock.results[0]?.value;
    const { version } = packageJson;
    expect(fetchModels).toHaveBeenCalledWith(
      "test-key",
      undefined,
      `nvidia-nim-provider/${version} VSCode/1.104.0`,
    );
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.rawModels", rawModels);
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(providerInstance.fireModelInfoChanged).toHaveBeenCalled();
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
  });

  it("stores raw and normalized model caches when the refresh command succeeds", async () => {
    const rawModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: { chat: true, tool_calling: true, vision: true },
        metadata: { context_window: 128000, max_output_tokens: 8192 },
      },
      {
        id: "nvidia/nv-embedqa-e5-v5",
        name: "Embed QA",
        capabilities: { chat: false },
      },
    ];
    (fetchModels as jest.Mock).mockResolvedValue(rawModels);

    const secrets = {
      get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-key"),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    await refresh?.();

    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.rawModels", rawModels);
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(globalState.update).toHaveBeenCalledWith(
      "nvidia-nim.modelsCacheKeyFingerprint",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Refreshed 1 NVIDIA NIM models.");
  });

  it("clears raw and normalized model caches when the refresh command returns an empty model list", async () => {
    (fetchModels as jest.Mock).mockResolvedValue([]);

    const secrets = {
      get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-key"),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    await refresh?.();

    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.rawModels", []);
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", []);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Refreshed 0 NVIDIA NIM models.");
  });

  it("keeps existing caches untouched when refresh fails after a previous successful cache", async () => {
    (fetchModels as jest.Mock).mockRejectedValue(new Error("network down"));

    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === "nvidia-nim.debug") {
          return false;
        }
        if (key === "nvidia-nim.models") {
          return [
            {
              id: "cached-model",
              displayName: "Cached Model",
              contextWindow: 131072,
              maxOutputTokens: 16384,
              supportsTools: true,
              supportsVision: false,
            },
          ];
        }
        if (key === "nvidia-nim.rawModels") {
          return [{ id: "cached-model", name: "Cached Model" }];
        }
        return fallback;
      }),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    await refresh?.();

    expect(globalState.update).not.toHaveBeenCalledWith("nvidia-nim.rawModels", expect.anything());
    expect(globalState.update).not.toHaveBeenCalledWith("nvidia-nim.models", expect.anything());
    expect(mockShowErrorMessage).toHaveBeenCalledWith("Failed to refresh models: network down");
  });

  it("rolls back the raw cache if normalized cache persistence fails", async () => {
    const rawModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: { chat: true, tool_calling: true, vision: true },
        metadata: { context_window: 128000, max_output_tokens: 8192 },
      },
    ];
    (fetchModels as jest.Mock).mockResolvedValue(rawModels);

    const previousRawModels = [{ id: "cached-model", name: "Cached Model" }];
    const update = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("persist normalized failed"))
      .mockResolvedValueOnce(undefined);
    const secrets = {
      get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-key"),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === "nvidia-nim.debug") {
          return false;
        }
        if (key === "nvidia-nim.rawModels") {
          return previousRawModels;
        }
        if (key === "nvidia-nim.models") {
          return [
            {
              id: "cached-model",
              displayName: "Cached Model",
              contextWindow: 131072,
              maxOutputTokens: 16384,
              supportsTools: false,
              supportsVision: false,
            },
          ];
        }
        return fallback;
      }),
      update,
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    await refresh?.();

    expect(update).toHaveBeenNthCalledWith(1, "nvidia-nim.rawModels", rawModels);
    expect(update).toHaveBeenNthCalledWith(2, "nvidia-nim.models", [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(update).toHaveBeenNthCalledWith(3, "nvidia-nim.rawModels", previousRawModels);
    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "Failed to refresh models: persist normalized failed",
    );
  });

  it("waits for an in-flight refresh before starting another refresh", async () => {
    const firstRawModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: { chat: true, tool_calling: true, vision: true },
        metadata: { context_window: 128000, max_output_tokens: 8192 },
      },
    ];
    const secondRawModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        capabilities: { chat: true, tool_calling: false, vision: false },
        metadata: { context_window: 64000, max_output_tokens: 4096 },
      },
    ];
    const firstModelsWrite = createDeferred<void>();
    (fetchModels as jest.Mock)
      .mockResolvedValueOnce(firstRawModels)
      .mockResolvedValueOnce(secondRawModels);

    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async (key: string, value: unknown) => {
        if (
          key === "nvidia-nim.models" &&
          Array.isArray(value) &&
          value.some(
            (model) =>
              typeof model === "object" &&
              model !== null &&
              (model as { id?: string }).id === "deepseek-ai/deepseek-v4-pro",
          )
        ) {
          return firstModelsWrite.promise;
        }
        return undefined;
      }),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    const refreshPromise = refresh?.();
    await flushAsyncWork();

    expect(fetchModels).toHaveBeenCalledTimes(1);

    firstModelsWrite.resolve();
    await refreshPromise;

    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Refreshed 1 NVIDIA NIM models.");
  });

  it("preserves the normalized cache write error when rollback also fails", async () => {
    const rawModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: { chat: true, tool_calling: true, vision: true },
        metadata: { context_window: 128000, max_output_tokens: 8192 },
      },
    ];
    (fetchModels as jest.Mock).mockResolvedValue(rawModels);

    const normalizedWriteError = new Error("persist normalized failed");
    const rollbackWriteError = new Error("rollback failed");
    const secrets = {
      get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-key"),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === "nvidia-nim.debug") {
          return false;
        }
        if (key === "nvidia-nim.rawModels") {
          return [{ id: "cached-model", name: "Cached Model" }];
        }
        return fallback;
      }),
      update: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(normalizedWriteError)
        .mockRejectedValueOnce(rollbackWriteError),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const refresh = registeredCommands.get("nvidia-nim.refreshModels");
    expect(refresh).toBeDefined();

    await refresh?.();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "Failed to refresh models: persist normalized failed",
    );
  });

  it("does not attempt a background refresh on activation when no API key is configured", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    expect(fetchModels).not.toHaveBeenCalled();
    expect(globalState.update).not.toHaveBeenCalledWith("nvidia-nim.models", expect.anything());
  });

  it("stores only the NVIDIA NIM secret key from the manage command", async () => {
    mockShowInputBox.mockResolvedValue("new-key");
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);

    const manage = registeredCommands.get("nvidia-nim.manage");
    expect(manage).toBeDefined();

    await manage?.();

    expect(secrets.store).toHaveBeenCalledTimes(1);
    expect(secrets.store).toHaveBeenCalledWith("nvidia-nim.apiKey", "new-key");
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it("migrates a newly saved API key into the VS Code language model provider group", async () => {
    mockShowInputBox.mockResolvedValue("new-key");
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);

    const manage = registeredCommands.get("nvidia-nim.manage");
    expect(manage).toBeDefined();

    await manage?.();

    expect(mockExecuteCommand).toHaveBeenCalledWith("lm.migrateLanguageModelsProviderGroup", {
      vendor: "nvidia-nim",
      name: "NVIDIA NIM",
      apiKey: "new-key",
    });
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.legacyMigrationDone", true);
  });

  it("clears the legacy API key and instructs users to remove the VS Code model group", async () => {
    mockShowInputBox.mockResolvedValue("   ");
    const secrets = {
      get: jest.fn(async (key: string) => (key === "nvidia-nim.apiKey" ? "old-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const manage = registeredCommands.get("nvidia-nim.manage");
    expect(manage).toBeDefined();

    await manage?.();

    expect(secrets.delete).toHaveBeenCalledWith("nvidia-nim.apiKey");
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "NVIDIA NIM legacy API key cleared. If NVIDIA NIM still appears in Copilot Chat, remove its model group from Manage Models.",
    );
  });

  it("toggles NVIDIA NIM debug logging state and env var", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);

    const toggleDebug = registeredCommands.get("nvidia-nim.toggleDebugLogging");
    expect(toggleDebug).toBeDefined();

    await toggleDebug?.();

    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.debug", true);
    expect(process.env.NVIDIA_NIM_DEBUG).toBe("1");
  });

  it("creates and registers status bar item on activation", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "nvidia-nim.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);

    const { StatusBarManager } = await import("../src/shared/status-bar");
    expect(StatusBarManager).toHaveBeenCalled();
    const hasStatusBarDisposable = context.subscriptions.some(
      (s) => typeof s.dispose === "function",
    );
    expect(hasStatusBarDisposable).toBe(true);
  });
});
