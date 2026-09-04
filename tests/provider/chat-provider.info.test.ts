import * as vscode from "vscode";
import { fetchModelsOrThrow, streamChatCompletion } from "../../src/api/client";
import { getApiKeyFingerprint } from "../../src/api/key-resolver";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { MODELS_CACHE_VERSION } from "../../src/shared/constants";
import {
  asRuntimeInfoCache,
  makeChatOptions,
  makeMemento,
  makePrepareOptions,
  makeSecrets,
  makeToken,
  makeUserMessages,
} from "../helpers/fakes";

jest.mock("../../src/api/client", () => ({
  fetchModelsOrThrow: jest.fn(),
  streamChatCompletion: jest.fn(),
}));

jest.mock("vscode", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../helpers/vscode-provider-mock").createProviderVscodeMock();
});

describe("NimChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let globalState: vscode.Memento;
  let provider: NimChatModelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = makeSecrets();
    globalState = makeMemento((key) =>
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
              id: "deepseek-ai/deepseek-v4-flash-0731",
              displayName: "DeepSeek V4 Flash",
              contextWindow: 131072,
              maxOutputTokens: 16384,
              supportsTools: true,
              supportsVision: false,
            },
          ]
        : undefined,
    );
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
  });

  it("provideLanguageModelChatInformation returns no models when no provider group API key exists", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    const token = makeToken();
    const infos = await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    expect(infos).toEqual([]);
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("provideLanguageModelChatInformation fetches models on demand when cache is empty and a provider group API key exists", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(fetchModelsOrThrow).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash 0731",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash 0731",
        detail: "NVIDIA NIM",
      }),
    ]);
    expect(infos[0]).not.toHaveProperty("apiKey");
  });

  it("provideLanguageModelChatInformation uses the VS Code model configuration API key", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(fetchModelsOrThrow).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(secrets.get).not.toHaveBeenCalledWith("nvidia-nim.apiKey");
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash-0731",
      }),
    ]);
    expect(infos[0]).not.toHaveProperty("apiKey");
  });

  it("does not return legacy cached models for groupless resolution", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);

    expect(infos).toEqual([]);
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("treats an undefined configuration property as groupless resolution", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: undefined,
      }),
      token,
    );

    expect(infos).toEqual([]);
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("uses the legacy API key fallback for a configuration-only provider group missing an api key", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        object: "model",
        owned_by: "deepseek-ai",
      },
    ]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({ configuration: {} }),
      token,
    );

    expect(fetchModelsOrThrow).toHaveBeenCalledWith("legacy-key", undefined, "test-ua");
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash 0731",
        isUserSelectable: true,
      }),
    ]);
  });

  it("keeps a configuration-only provider group selectable after a groupless reset", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
      if (key === "nvidia-nim.modelsCacheKeyFingerprint") {
        return getApiKeyFingerprint("legacy-key");
      }
      return undefined;
    });
    (secrets.get as jest.Mock).mockResolvedValue("legacy-key");
    const token = makeToken();

    const grouplessInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions(),
      token,
    );
    const groupInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({ configuration: {} }),
      token,
    );

    expect(grouplessInfos).toEqual([]);
    expect(groupInfos).toHaveLength(1);
    expect(groupInfos[0]).toEqual(
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash-0731",
        isUserSelectable: true,
      }),
    );
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("keeps duplicate configured provider group models resolvable but hides them from the picker", async () => {
    (globalState.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
    const token = makeToken();

    await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    const firstInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );
    const duplicateInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM 2",
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
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
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
    const token = makeToken();

    await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    const firstInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-aaa" },
      }),
      token,
    );
    const differentKeyInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM 2",
        silent: true,
        configuration: { apiKey: "key-bbb" },
      }),
      token,
    );

    expect(firstInfos).toHaveLength(1);
    expect(firstInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(differentKeyInfos).toHaveLength(1);
    expect(differentKeyInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: false }));
  });

  it("keeps cloned models from duplicate provider groups bound to their own API keys", async () => {
    (globalState.get as jest.Mock).mockReturnValue(undefined);
    (globalState.update as jest.Mock).mockResolvedValue(undefined);
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-flash-0731", object: "model" },
    ]);
    (streamChatCompletion as jest.Mock).mockImplementation(() =>
      (async function* () {
        yield { choices: [{ delta: { content: "done" } }] };
      })(),
    );
    const token = makeToken();

    await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    const [modelA] = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM A",
        silent: true,
        configuration: { apiKey: "key-a" },
      }),
      token,
    );
    const [modelB] = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM B",
        silent: true,
        configuration: { apiKey: "key-b" },
      }),
      token,
    );

    const progress = { report: jest.fn() };
    for (const model of [modelA, modelB]) {
      await provider.provideLanguageModelChatResponse(
        model,
        makeUserMessages("Hi"),
        makeChatOptions(),
        progress,
        token,
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
            id: "deepseek-ai/deepseek-v4-flash-0731",
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
    const token = makeToken();

    await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );
    await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
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
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        object: "model",
        owned_by: "integrate.api.nvidia.com",
      },
    ]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(fetchModelsOrThrow).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(infos[0]).toEqual(
      expect.objectContaining({
        id: "deepseek-ai/deepseek-v4-flash-0731",
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
    (fetchModelsOrThrow as jest.Mock).mockRejectedValue(new Error("network down"));
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(fetchModelsOrThrow).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
    expect(infos).toEqual([]);
  });

  it("provideLanguageModelChatInformation returns cached normalized models for a configured provider group", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
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
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );
    expect(infos.length).toBe(1);
    expect(infos[0].id).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(infos[0].detail).toBe("NVIDIA NIM");
    expect(infos[0].tooltip).toBe("NVIDIA NIM DeepSeek V4 Flash");
    expect(infos[0].family).toBe("nvidia-nim");
    expect(infos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(globalState.get).toHaveBeenCalledWith("nvidia-nim.models");
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("lists Lightning as a normal selectable model in the Copilot picker", async () => {
    const cachedModels = [
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        displayName: "Nemotron 3.5 Lightning 30B",
        contextWindow: 1000000,
        maxOutputTokens: 32768,
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

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      makeToken(),
    );

    expect(infos).toEqual([
      expect.objectContaining({
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        name: "Nemotron 3.5 Lightning 30B",
        detail: "NVIDIA NIM",
        isUserSelectable: true,
      }),
    ]);
    expect(infos[0].tooltip).toBe("NVIDIA NIM Nemotron 3.5 Lightning 30B");
    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("does not refetch a fresh cache on repeated provider-group resolution", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
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
    const token = makeToken();
    const options = makePrepareOptions({
      group: "NVIDIA NIM",
      configuration: { apiKey: "configured-key" },
    });

    await expect(
      provider.provideLanguageModelChatInformation(options, token),
    ).resolves.toHaveLength(1);
    await expect(
      provider.provideLanguageModelChatInformation(options, token),
    ).resolves.toHaveLength(1);

    expect(fetchModelsOrThrow).not.toHaveBeenCalled();
  });

  it("migrates an older cache version during provider-group resolution", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
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
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-flash-0731", object: "model" },
    ]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(infos).toEqual([expect.objectContaining({ id: "deepseek-ai/deepseek-v4-flash-0731" })]);
    expect(fetchModelsOrThrow).toHaveBeenCalledWith("configured-key", undefined, "test-ua");
  });

  it("provideLanguageModelChatInformation returns no models when the cache is not normalized", async () => {
    (globalState.get as jest.Mock).mockReturnValue([{ id: "cached-model", name: "Cached Model" }]);
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);

    expect(infos).toEqual([]);
  });

  it.each([{}, "bad-cache", 123])(
    "provideLanguageModelChatInformation returns no models when cache is malformed non-array: %p",
    async (malformedCache) => {
      (globalState.get as jest.Mock).mockReturnValue(malformedCache);
      const token = makeToken();

      const infos = await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);

      expect(infos).toEqual([]);
    },
  );

  it("does not advertise image input for non-vision normalized models", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
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
    const token = makeToken();

    const infos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        silent: true,
        configuration: { apiKey: "configured-key" },
      }),
      token,
    );

    expect(infos).toHaveLength(1);
    expect(infos[0].capabilities?.imageInput).toBe(false);
    expect(infos[0].capabilities?.toolCalling).toBe(128);
  });

  it("provideLanguageModelChatInformation returns empty array on cancellation", async () => {
    const token = makeToken(true);
    const infos = await provider.provideLanguageModelChatInformation(makePrepareOptions(), token);
    expect(infos).toEqual([]);
  });

  it("refreshes cached models when the provider-group key changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
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
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", object: "model" },
    ]);
    const token = makeToken();

    const firstInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-a" },
      }),
      token,
    );
    const secondInfos = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-b" },
      }),
      token,
    );

    expect(firstInfos[0].id).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(secondInfos[0].id).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(secondInfos[0]).toEqual(expect.objectContaining({ isUserSelectable: true }));
    expect(fetchModelsOrThrow).toHaveBeenCalledWith("key-b", undefined, "test-ua");
  });

  it("invalidates the model cache when model information changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
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
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", object: "model" },
    ]);
    const token = makeToken();

    const before = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-a" },
      }),
      token,
    );
    provider.fireModelInfoChanged();
    const after = await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-a" },
      }),
      token,
    );

    expect(before[0].id).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(after[0].id).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(fetchModelsOrThrow).toHaveBeenCalledWith("key-a", undefined, "test-ua");
  });

  it("bounds the runtime model-info cache and evicts the least-recently-used entry", () => {
    const cacheHarness = asRuntimeInfoCache(provider);

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
    const cacheHarness = asRuntimeInfoCache(provider);
    cacheHarness.setRuntimeInfoCache("moonshotai/kimi-k3", {
      supportsTools: true,
      supportsVision: true,
      contextWindow: 1048576,
      runtimeMetadataSource: "cache",
    });

    provider.fireModelInfoChanged({ invalidateModelCache: false });

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });

  it("clears runtime model-info metadata at the start of a new resolution cycle", async () => {
    const cacheHarness = asRuntimeInfoCache(provider);
    cacheHarness.setRuntimeInfoCache("moonshotai/kimi-k3", {
      supportsTools: true,
      supportsVision: true,
      contextWindow: 1048576,
      runtimeMetadataSource: "selected-model",
    });

    await provider.provideLanguageModelChatInformation(makePrepareOptions(), makeToken());

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });

  it("clears runtime model-info metadata when a provider-group API key changes", async () => {
    const cachedModels = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 131072,
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
    (fetchModelsOrThrow as jest.Mock).mockResolvedValue([
      { id: "deepseek-ai/deepseek-v4-flash-0731", object: "model" },
    ]);
    const cacheHarness = asRuntimeInfoCache(provider);
    const token = makeToken();

    await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-a" },
      }),
      token,
    );
    cacheHarness.setRuntimeInfoCache("deepseek-ai/deepseek-v4-flash-0731", {
      supportsTools: true,
      supportsVision: false,
      contextWindow: 1048576,
      runtimeMetadataSource: "cache",
    });

    await provider.provideLanguageModelChatInformation(
      makePrepareOptions({
        group: "NVIDIA NIM",
        silent: true,
        configuration: { apiKey: "key-b" },
      }),
      token,
    );

    expect(cacheHarness.runtimeInfoCache.size).toBe(0);
  });
});
