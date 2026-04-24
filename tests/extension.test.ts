import { fetchModels } from "../src/api";
import { OcGoChatModelProvider } from "../src/provider";

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
const mockRegisterLanguageModelChatProvider = jest.fn(() => ({ dispose: jest.fn() }));

jest.mock("../src/api", () => ({
  fetchModels: jest.fn(),
}));

jest.mock("../src/provider", () => ({
  OcGoChatModelProvider: jest.fn().mockImplementation(() => ({
    fireModelInfoChanged: jest.fn(),
  })),
}));

jest.mock("../src/tools", () => ({
  registerOcGoTools: jest.fn(() => ({ dispose: jest.fn() })),
}));

jest.mock("vscode", () => ({
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
  },
  lm: {
    registerLanguageModelChatProvider: mockRegisterLanguageModelChatProvider,
  },
}));

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
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

  it("refreshes cached models in the background on activation when an API key exists", async () => {
    const models = [{ id: "kimi-k2.6", name: "Kimi K2.6" }];
    (fetchModels as jest.Mock).mockResolvedValue(models);

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

    const providerInstance = (OcGoChatModelProvider as jest.Mock).mock.results[0]?.value;
    const { version } = require("../package.json");
    expect(fetchModels).toHaveBeenCalledWith(
      "test-key",
      undefined,
      `nvidia-nim-provider/${version} VSCode/1.104.0`,
    );
    expect(globalState.update).toHaveBeenCalledWith("nvidia-nim.models", models);
    expect(providerInstance.fireModelInfoChanged).toHaveBeenCalled();
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
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
});
