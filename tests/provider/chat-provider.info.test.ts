import * as vscode from "vscode";
import { fetchModels, streamChatCompletion } from "../../src/api/client";
import { getApiKeyFingerprint } from "../../src/api/key-resolver";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { MODELS_CACHE_VERSION } from "../../src/shared/constants";

jest.mock("../../src/api/client", () => ({
  fetchModels: jest.fn(),
  streamChatCompletion: jest.fn(),
}));

jest.mock("vscode", () => ({
  SecretStorage: class {},
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 0 },
  LanguageModelChatMessage: {
    User: (content: unknown[]) => ({ role: 1, content }),
  },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class {
    constructor(
      public callId: string,
      public name: string,
      public input: Record<string, unknown>,
    ) {}
  },
  LanguageModelToolResultPart: class {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  },
  window: {
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
    showInputBox: jest.fn(),
    showInformationMessage: jest.fn().mockResolvedValue(undefined),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    })),
  },
  LanguageModelError: {
    NoPermissions: (msg: string) => new Error(msg),
    NotFound: (msg: string) => new Error(msg),
    Blocked: (msg: string) => new Error(msg),
  },
  CancellationError: class extends Error {},
  EventEmitter: class {
    event = jest.fn();
    fire = jest.fn();
  },
  Memento: class {},
}));

describe("NimChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let globalState: vscode.Memento;
  let provider: NimChatModelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = {
      get: jest.fn(),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(),
    } as unknown as vscode.SecretStorage;
    globalState = {
      get: jest.fn().mockImplementation((key: string) =>
        key === "nvidia-nim.models"
          ? [
              {
                id: "kimi-k2.6",
                displayName: "Kimi K2.6",
                contextWindow: 262144,
                maxOutputTokens: 262144,
                supportsTools: true,
                supportsVision: true,
              },
              {
                id: "deepseek-ai/deepseek-v4-pro",
                displayName: "DeepSeek V4 Pro",
                contextWindow: 131072,
                maxOutputTokens: 16384,
                supportsTools: true,
                supportsVision: false,
              },
            ]
          : undefined,
      ),
      update: jest.fn(),
      keys: jest.fn(),
    } as unknown as vscode.Memento;
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);
  });

  it("provideLanguageModelChatInformation returns no models when no provider group API key exists", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    expect(infos).toEqual([]);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("provideLanguageModelChatInformation fetches models on demand when cache is empty and a provider group API key exists", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    (fetchModels as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(fetchModels).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        detail: "NVIDIA NIM",
      }),
    ]);
    expect(infos[0]).not.toHaveProperty("apiKey");
  });

  it("provideLanguageModelChatInformation uses the VS Code model configuration API key", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    (fetchModels as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(fetchModels).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(secrets.get).not.toHaveBeenCalledWith("nvidia-nim.apiKey");
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash",
      }),
    ]);
    expect(infos[0]).not.toHaveProperty("apiKey");
  });

  it("does not return legacy cached models for groupless resolution", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      return undefined;
    });
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );

    expect(infos).toEqual([]);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("treats an undefined configuration property as groupless resolution", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      return undefined;
    });
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: undefined } as any,
      token as any,
    );

    expect(infos).toEqual([]);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("uses the legacy API key fallback for a configuration-only provider group missing an api key", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    (fetchModels as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-pro",
        object: "model",
        owned_by: "deepseek-ai",
      },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: {} } as any,
      token as any,
    );

    expect(fetchModels).toHaveBeenCalledWith("legacy-key", undefined, "test-ua");
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        isUserSelectable: true,
      }),
    ]);
  });

  it("keeps a configuration-only provider group selectable after a groupless reset", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("legacy-key");
      }
      return undefined;
    });
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const grouplessInfos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    const groupInfos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: {} } as any,
      token as any,
    );

    expect(grouplessInfos).toEqual([]);
    expect(groupInfos).toHaveLength(1);
    expect(groupInfos[0]).toEqual(
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-pro",
        isUserSelectable: true,
      }),
    );
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("keeps duplicate configured provider group models resolvable but hides them from the picker", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation({ silent: true } as any, token as any);
    const firstInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );
    const duplicateInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM 2", silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(firstInfos).toHaveLength(1);
    expect(firstInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(duplicateInfos).toHaveLength(1);
    expect(duplicateInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: false }));
  });

  it("hides duplicate model ids from a second provider group even when it uses a different API key", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation({ silent: true } as any, token as any);
    const firstInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-aaa" } } as any,
      token as any,
    );
    const differentKeyInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM 2", silent: true, configuration: { apiKey: "key-bbb" } } as any,
      token as any,
    );

    expect(firstInfos).toHaveLength(1);
    expect(firstInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(differentKeyInfos).toHaveLength(1);
    expect(differentKeyInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: false }));
  });

  it("keeps cloned models from duplicate provider groups bound to their own API keys", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-flash", object: "model" },
    ]);
    (streamChatCompletion as jest.Mock).mockImplementation(() =>
      (async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      })(),
    );
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation({ silent: true } as any, token as any);
    const [modelA] = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM A", silent: true, configuration: { apiKey: "key-a" } } as any,
      token as any,
    );
    const [modelB] = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM B", silent: true, configuration: { apiKey: "key-b" } } as any,
      token as any,
    );

    const progress = { report: jest.fn() };
    for (const model of [{ ...modelA }, { ...modelB }]) {
      await provider.provideLanguageModelChatResponse(
        model as any,
        [{ role: 1, content: [{ value: "Hi" }] }] as any,
        { modelOptions: {} } as any,
        progress,
        token as any,
      );
    }

    expect((streamChatCompletion as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      "key-a",
      "key-b",
    ]);
  });

  it("allows the same configured provider group again after a new provider resolution cycle starts", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation({ silent: true } as any, token as any);
    await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );
    await provider.provideLanguageModelChatInformation({ silent: true } as any, token as any);
    const infos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(infos).toHaveLength(1);
  });

  it("refreshes stale cached models when a configured API key is available", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "stale-model",
            displayName: "Stale Model",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: false,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return undefined;
      }
      return undefined;
    });
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (fetchModels as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(fetchModels).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(infos[0]).toEqual(
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash",
        isUserSelectable: true,
      }),
    );
  });

  it("does not expose stale non-whitelist models when refreshing them fails", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "stale-model",
            displayName: "Stale Model",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            supportsTools: false,
            supportsVision: false,
          },
        ];
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return undefined;
      }
      return undefined;
    });
    (fetchModels as jest.Mock).mockResolvedValue(null);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(fetchModels).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(infos).toEqual([]);
  });

  it("provideLanguageModelChatInformation returns cached normalized models for a configured provider group", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return cachedModels;
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("configured-key");
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );
    expect(infos.length).toBe(1);
    expect(infos[0].id).toBe("deepseek-ai/deepseek-v4-flash");
    expect(infos[0].detail).toBe("NVIDIA NIM");
    expect(infos[0].tooltip).toBe("NVIDIA NIM DeepSeek V4 Flash");
    expect(infos[0].family).toBe("nvidia-nim");
    expect(infos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(globalState.get).toHaveBeenCalledWith("nvidia-nim.models");
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("does not refetch a fresh cache on repeated provider-group resolution", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") return cachedModels;
      if (key === "nvidia-nim.modelsCacheVersion") return MODELS_CACHE_VERSION;
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("configured-key");
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const options = {
      group: "NVIDIA NIM",
      silent: true,
      configuration: { apiKey: "configured-key" },
    };

    await expect(
      provider.provideLanguageModelChatInformation(options as any, token as any),
    ).resolves.toHaveLength(1);
    await expect(
      provider.provideLanguageModelChatInformation(options as any, token as any),
    ).resolves.toHaveLength(1);

    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("migrates an older cache version during provider-group resolution", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") return cachedModels;
      if (key === "nvidia-nim.modelsCacheVersion") return MODELS_CACHE_VERSION - 1;
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("configured-key");
      }
      return undefined;
    });
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-pro", object: "model" },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      {
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "configured-key" },
      } as any,
      token as any,
    );

    expect(infos).toEqual([expect.objectContaining({ id: "deepseek-ai/deepseek-v4-pro" })]);
    expect(fetchModels).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
  });

  it("provideLanguageModelChatInformation returns no models when the cache is not normalized", async () => {
    (globalState.get as jest.Mock).mockReturnValue([{ id: "cached-model", name: "Cached Model" }]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );

    expect(infos).toEqual([]);
  });

  it.each([{}, "bad-cache", 123])(
    "provideLanguageModelChatInformation returns no models when cache is malformed non-array: %p",
    async (malformedCache) => {
      (globalState.get as jest.Mock).mockReturnValue(malformedCache);
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      };

      const infos = await provider.provideLanguageModelChatInformation(
        { silent: true } as any,
        token as any,
      );

      expect(infos).toEqual([]);
    },
  );

  it("does not advertise image input for non-vision normalized models", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 131072,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return cachedModels;
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("configured-key");
      }
      return undefined;
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "configured-key" } } as any,
      token as any,
    );

    expect(infos).toHaveLength(1);
    expect(infos[0].capabilities?.imageInput).toBe(false);
    expect(infos[0].capabilities?.toolCalling).toBe(128);
  });

  it("provideLanguageModelChatInformation returns empty array on cancellation", async () => {
    const token = {
      isCancellationRequested: true,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    expect(infos).toEqual([]);
  });

  it("refreshes cached models when the provider-group key changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return cachedModels;
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("key-a");
      }
      return undefined;
    });
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-pro", object: "model" },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const firstInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-a" } } as any,
      token as any,
    );
    const secondInfos = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-b" } } as any,
      token as any,
    );

    expect(firstInfos[0].id).toBe("deepseek-ai/deepseek-v4-flash");
    expect(secondInfos[0].id).toBe("deepseek-ai/deepseek-v4-pro");
    expect(secondInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(fetchModels).toHaveBeenCalledWith("key-b", undefined, "test-ua");
  });

  it("invalidates the model cache when model information changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return cachedModels;
      }
      if (key === "nvidia-nim.modelsCacheVersion") {
        return MODELS_CACHE_VERSION;
      }
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("key-a");
      }
      return undefined;
    });
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-pro", object: "model" },
    ]);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    const before = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-a" } } as any,
      token as any,
    );
    provider.fireModelInfoChanged();
    const after = await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-a" } } as any,
      token as any,
    );

    expect(before[0].id).toBe("deepseek-ai/deepseek-v4-flash");
    expect(after[0].id).toBe("deepseek-ai/deepseek-v4-pro");
    expect(fetchModels).toHaveBeenCalledWith("key-a", undefined, "test-ua");
  });

  it("bounds the runtime model-info cache and evicts the least-recently-used entry", () => {
    const cacheHarness = provider as unknown as {
      runtimeInfoCache: Map<string, unknown>;
      setRuntimeInfoCache(
        modelId: string,
        runtimeInfo: {
          supportsTools: boolean;
          supportsVision: boolean;
          contextWindow: number;
          runtimeMetadataSource: "selected-model";
        },
      ): void;
    };

    for (let index = 0; index <= 64; index += 1) {
      cacheHarness.setRuntimeInfoCache(`model-${index}`, {
        supportsTools: false,
        supportsVision: false,
        contextWindow: 1000,
        runtimeMetadataSource: "selected-model",
      });
    }

    expect(cacheHarness.runtimeInfoCache.size).toBe(64);
    expect(cacheHarness.runtimeInfoCache.has("model-0")).toBe(false);
    expect(cacheHarness.runtimeInfoCache.has("model-64")).toBe(true);
  });

  it("clears runtime model-info metadata after a successful model refresh event", () => {
    const cacheHarness = provider as unknown as {
      runtimeInfoCache: Map<string, unknown>;
      setRuntimeInfoCache(
        modelId: string,
        runtimeInfo: {
          supportsTools: boolean;
          supportsVision: boolean;
          contextWindow: number;
          runtimeMetadataSource: "cache";
        },
      ): void;
    };
    cacheHarness.setRuntimeInfoCache("moonshotai/kimi-k2.6", {
      supportsTools: true,
      supportsVision: true,
      contextWindow: 256000,
      runtimeMetadataSource: "cache",
    });

    provider.fireModelInfoChanged({ invalidateModelCache: false });

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });

  it("clears runtime model-info metadata at the start of a new resolution cycle", async () => {
    const cacheHarness = provider as unknown as {
      runtimeInfoCache: Map<string, unknown>;
      setRuntimeInfoCache(
        modelId: string,
        runtimeInfo: {
          supportsTools: boolean;
          supportsVision: boolean;
          contextWindow: number;
          runtimeMetadataSource: "selected-model";
        },
      ): void;
    };
    cacheHarness.setRuntimeInfoCache("moonshotai/kimi-k2.6", {
      supportsTools: true,
      supportsVision: true,
      contextWindow: 256000,
      runtimeMetadataSource: "selected-model",
    });

    await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
      } as any,
    );

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });

  it("clears runtime model-info metadata when a provider-group API key changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") return cachedModels;
      if (key === "nvidia-nim.modelsCacheVersion") return MODELS_CACHE_VERSION;
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("key-a");
      }
      return undefined;
    });
    (fetchModels as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-pro", object: "model" },
    ]);
    const cacheHarness = provider as unknown as {
      runtimeInfoCache: Map<string, unknown>;
      setRuntimeInfoCache(
        modelId: string,
        runtimeInfo: {
          supportsTools: boolean;
          supportsVision: boolean;
          contextWindow: number;
          runtimeMetadataSource: "cache";
        },
      ): void;
    };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-a" } } as any,
      token as any,
    );
    cacheHarness.setRuntimeInfoCache("deepseek-ai/deepseek-v4-flash", {
      supportsTools: true,
      supportsVision: false,
      contextWindow: 1048576,
      runtimeMetadataSource: "cache",
    });

    await provider.provideLanguageModelChatInformation(
      { group: "NVIDIA NIM", silent: true, configuration: { apiKey: "key-b" } } as any,
      token as any,
    );

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });
});
