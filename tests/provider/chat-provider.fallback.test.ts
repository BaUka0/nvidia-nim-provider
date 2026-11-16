import * as vscode from "vscode";
import { streamChatCompletion } from "../../src/api/client";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import { NvidiaApiError } from "../../src/api/errors";
import { getApiKeyFingerprint } from "../../src/api/key-resolver";
import {
  makeChatOptions,
  makeMemento,
  makeModel,
  makeSecrets,
  makeToken,
  makeUserMessages,
} from "../helpers/fakes";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
} from "../../src/shared/constants";
import * as cancellation from "../../src/shared/cancellation";
import { resetTurnReportsForTests } from "../../src/shared/turn-report";

jest.mock("../../src/api/client", () => ({
  fetchModelsOrThrow: jest.fn(),
  streamChatCompletion: jest.fn(),
}));

jest.mock("vscode", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../helpers/vscode-provider-mock").createProviderVscodeMock();
});

describe("NimChatModelProvider failover chain restart with retired models", () => {
  let secrets: vscode.SecretStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    resetTurnReportsForTests();
    secrets = makeSecrets();
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("restarts the failover chain from the first non-retired cached fallback instead of a 410-retired primary", async () => {
    jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") return ["nvidia/nemotron-3.5-lightning-30b-a3b"];
        if (key === "fallback.maxChainRestarts") return 1;
        return defaultValue;
      }),
    }));

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "z-ai/glm-5.3-flash",
            displayName: "GLM 5.3 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            displayName: "Nemotron 3.5 Lightning",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(
      (_apiKey: string, body: { model: string }) => {
        callCount += 1;
        if (callCount === 1) {
          expect(body.model).toBe("z-ai/glm-5.3-flash");
          return (async function* () {
            throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
          })();
        }
        if (callCount === 2) {
          expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
          return (async function* () {
            throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", {
              status: 429,
            });
          })();
        }
        expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
        return (async function* () {
          yield { choices: [{ delta: { content: "Recovered on non-retired fallback" } }] };
        })();
      },
    );

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hello"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[1] as { model: string }).model,
    );
    expect(requestedModels).toEqual([
      "z-ai/glm-5.3-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Recovered on non-retired fallback" }),
    );
  });

  it("aborts chain restart without sleeping backoff when original model is retired and no non-retired candidate remains", async () => {
    const backoffSpy = jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") return ["nvidia/nemotron-3.5-lightning-30b-a3b"];
        if (key === "fallback.maxChainRestarts") return 1;
        return defaultValue;
      }),
    }));

    let modelsInCache = [
      {
        id: "z-ai/glm-5.3-flash",
        displayName: "GLM 5.3 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        displayName: "Nemotron 3.5 Lightning",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: false,
      },
    ];

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return modelsInCache;
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
        })();
      }
      // Simulate no non-retired candidates remaining by the time restart evaluates cached models
      modelsInCache = [modelsInCache[0]!];
      return (async function* () {
        throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", { status: 429 });
      })();
    });

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "z-ai/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hello"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      ),
    ).rejects.toThrow(/All NVIDIA NIM failover candidates failed/);

    expect(backoffSpy).not.toHaveBeenCalled();
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("executes all maxChainRestarts passes on a sole priorityList fallback after a 410-retired primary", async () => {
    const backoffSpy = jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") return ["nvidia/nemotron-3.5-lightning-30b-a3b"];
        if (key === "fallback.maxChainRestarts") return 2;
        return defaultValue;
      }),
    }));

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "z-ai/glm-5.3-flash",
            displayName: "GLM 5.3 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            displayName: "Nemotron 3.5 Lightning",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(
      (_apiKey: string, body: { model: string }) => {
        callCount += 1;
        if (callCount === 1) {
          expect(body.model).toBe("z-ai/glm-5.3-flash");
          return (async function* () {
            throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
          })();
        }
        if (callCount <= 3) {
          expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
          return (async function* () {
            throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", {
              status: 429,
            });
          })();
        }
        expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
        return (async function* () {
          yield { choices: [{ delta: { content: "Recovered on restart pass 2" } }] };
        })();
      },
    );

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hello"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[1] as { model: string }).model,
    );
    expect(requestedModels).toEqual([
      "z-ai/glm-5.3-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(backoffSpy).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Recovered on restart pass 2" }),
    );
  });

  it("throws structured failover chain exhaustion error after all maxChainRestarts passes fail on sole fallback", async () => {
    const backoffSpy = jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") return ["nvidia/nemotron-3.5-lightning-30b-a3b"];
        if (key === "fallback.maxChainRestarts") return 2;
        return defaultValue;
      }),
    }));

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "z-ai/glm-5.3-flash",
            displayName: "GLM 5.3 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            displayName: "Nemotron 3.5 Lightning",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
        })();
      }
      return (async function* () {
        throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", { status: 429 });
      })();
    });

    await expect(
      provider.provideLanguageModelChatResponse(
        makeModel({
          id: "z-ai/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          maxInputTokens: 200000,
          maxOutputTokens: 65536,
        }),
        makeUserMessages("Hello"),
        makeChatOptions(),
        { report: jest.fn() },
        makeToken(),
      ),
    ).rejects.toThrow(
      /All NVIDIA NIM failover candidates failed after 1 step\(s\)\.\nTried chain: z-ai\/glm-5\.3-flash -> nvidia\/nemotron-3\.5-lightning-30b-a3b/,
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[1] as { model: string }).model,
    );
    expect(requestedModels).toEqual([
      "z-ai/glm-5.3-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(backoffSpy).toHaveBeenCalledTimes(2);
  });

  it("executes all maxChainRestarts passes with empty priorityList and default fallback.model after 410-retired primary", async () => {
    const backoffSpy = jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") return [];
        if (key === "fallback.maxChainRestarts") return 2;
        return defaultValue;
      }),
    }));

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "z-ai/glm-5.3-flash",
            displayName: "GLM 5.3 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            displayName: "Nemotron 3.5 Lightning",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
        })();
      }
      if (callCount <= 3) {
        return (async function* () {
          throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", { status: 429 });
        })();
      }
      return (async function* () {
        yield { choices: [{ delta: { content: "Recovered on default fallback pass 2" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hello"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[1] as { model: string }).model,
    );
    expect(requestedModels).toEqual([
      "z-ai/glm-5.3-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(backoffSpy).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Recovered on default fallback pass 2" }),
    );
  });

  it("executes all maxChainRestarts passes across a multi-fallback priorityList after 410-retired primary", async () => {
    const backoffSpy = jest.spyOn(cancellation, "waitForBackoff").mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "fallback.enabled") return true;
        if (key === "fallback.priorityList") {
          return ["meta/muse-glimmer-30b", "nvidia/nemotron-3.5-lightning-30b-a3b"];
        }
        if (key === "fallback.maxChainRestarts") return 2;
        return defaultValue;
      }),
    }));

    const globalState = makeMemento((key) => {
      if (key === "nvidia-nim.models") {
        return [
          {
            id: "z-ai/glm-5.3-flash",
            displayName: "GLM 5.3 Flash",
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "meta/muse-glimmer-30b",
            displayName: "Muse Glimmer",
            contextWindow: 131072,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            displayName: "Nemotron 3.5 Lightning",
            contextWindow: 1000000,
            maxOutputTokens: 65536,
            supportsTools: true,
            supportsVision: false,
          },
        ];
      }
      if (key === MODELS_CACHE_VERSION_STATE_KEY) return MODELS_CACHE_VERSION;
      if (key === MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY) {
        return getApiKeyFingerprint("test-key");
      }
      return undefined;
    });

    const provider = new NimChatModelProvider(secrets, "test-ua", globalState);

    let callCount = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          throw new NvidiaApiError("model_unavailable", "HTTP 410 Gone", { status: 410 });
        })();
      }
      if (callCount <= 6) {
        return (async function* () {
          throw new NvidiaApiError("rate_limited", "HTTP 429 Too Many Requests", { status: 429 });
        })();
      }
      return (async function* () {
        yield { choices: [{ delta: { content: "Recovered on multi-fallback pass 2" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    await provider.provideLanguageModelChatResponse(
      makeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        maxInputTokens: 200000,
        maxOutputTokens: 65536,
      }),
      makeUserMessages("Hello"),
      makeChatOptions(),
      progress,
      makeToken(),
    );

    const requestedModels = (streamChatCompletion as jest.Mock).mock.calls.map(
      (call: unknown[]) => (call[1] as { model: string }).model,
    );
    expect(requestedModels).toEqual([
      "z-ai/glm-5.3-flash",
      "meta/muse-glimmer-30b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "meta/muse-glimmer-30b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "meta/muse-glimmer-30b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
    expect(backoffSpy).toHaveBeenCalledTimes(2);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Recovered on multi-fallback pass 2" }),
    );
  });
});
