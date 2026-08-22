import * as vscode from "vscode";

type ChatToolInit = {
  name: string;
  description?: string;
  inputSchema?: object;
};

type ChatOptionsInit = Omit<Partial<vscode.ProvideLanguageModelChatResponseOptions>, "tools"> & {
  tools?: readonly ChatToolInit[];
  modelConfiguration?: { reasoningMode?: string };
};

type PrepareOptionsInit = Partial<vscode.PrepareLanguageModelChatModelOptions> & {
  group?: string;
  configuration?: { apiKey?: string } | Record<string, never>;
};

type ModelInit = Partial<vscode.LanguageModelChatInformation> & {
  apiKey?: string;
};

export type RuntimeInfoCacheHarness = {
  runtimeInfoCache: Map<string, unknown>;
  setRuntimeInfoCache(
    modelId: string,
    runtimeInfo: {
      supportsTools: boolean;
      supportsVision: boolean;
      contextWindow: number;
      runtimeMetadataSource: "selected-model" | "cache" | "fetched-model";
    },
  ): void;
};

type MessageInit = {
  role: number;
  content: readonly unknown[];
  name?: string;
};

export function makeToken(isCancellationRequested = false): vscode.CancellationToken {
  return {
    isCancellationRequested,
    onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
  } as vscode.CancellationToken;
}

export function asCancellationToken(token: object): vscode.CancellationToken {
  return token as vscode.CancellationToken;
}

export function makeProgress(): { report: jest.Mock } {
  return { report: jest.fn() };
}

export function makeSecrets(): vscode.SecretStorage & {
  get: jest.Mock;
  store: jest.Mock;
  delete: jest.Mock;
  onDidChange: jest.Mock;
  keys: jest.Mock;
} {
  return {
    get: jest.fn(),
    store: jest.fn(),
    delete: jest.fn(),
    onDidChange: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
  };
}

export function makeMemento(
  getImpl?: (key: string) => unknown,
): vscode.Memento & { get: jest.Mock; update: jest.Mock; keys: jest.Mock } {
  return {
    get: jest.fn().mockImplementation((key: string) => getImpl?.(key)),
    update: jest.fn(),
    keys: jest.fn().mockReturnValue([]),
  };
}

export function makeCachedModelsMemento(
  models: unknown[],
): vscode.Memento & { get: jest.Mock; update: jest.Mock; keys: jest.Mock } {
  return makeMemento((key) => (key === "nvidia-nim.models" ? models : undefined));
}

export function makeModel(overrides: ModelInit = {}): vscode.LanguageModelChatInformation {
  return {
    id: "kimi-k3",
    name: overrides.name ?? overrides.id ?? "Kimi K3",
    version: "1",
    maxInputTokens: 100000,
    maxOutputTokens: 65536,
    ...overrides,
  } as vscode.LanguageModelChatInformation;
}

export function makeMessages(...messages: MessageInit[]): vscode.LanguageModelChatMessage[] {
  return messages.map((message) => ({
    role: message.role as vscode.LanguageModelChatMessageRole,
    content: message.content as vscode.LanguageModelInputPart[],
    name: message.name,
  })) as vscode.LanguageModelChatMessage[];
}

export function makeUserMessages(...prompts: string[]): vscode.LanguageModelChatMessage[] {
  return makeMessages(...prompts.map((value) => ({ role: 1, content: [{ value }] })));
}

export function makeChatMessages(...messages: MessageInit[]): vscode.LanguageModelChatMessage[] {
  return makeMessages(...messages);
}

export function makeRequestMessage(message: MessageInit): vscode.LanguageModelChatRequestMessage {
  return {
    role: message.role as vscode.LanguageModelChatMessageRole,
    content: message.content,
    name: message.name,
  };
}

export function makeChatOptions(
  overrides: ChatOptionsInit = {},
): vscode.ProvideLanguageModelChatResponseOptions {
  return {
    toolMode: vscode.LanguageModelChatToolMode?.Auto ?? 1,
    modelOptions: {},
    ...overrides,
  } as vscode.ProvideLanguageModelChatResponseOptions;
}

export function makePrepareOptions(
  overrides: PrepareOptionsInit = {},
): vscode.PrepareLanguageModelChatModelOptions {
  return {
    silent: true,
    ...overrides,
  };
}

export function makeToolInvokeOptions<T>(input: T): vscode.LanguageModelToolInvocationOptions<T> {
  return {
    input,
    toolInvocationToken: undefined,
  };
}

export function makeToolPrepareOptions<T>(
  input: T,
): vscode.LanguageModelToolInvocationPrepareOptions<T> {
  return { input };
}

export function makeAbortSignal(options?: {
  getAborted?: (reads: number) => boolean;
}): AbortSignal & { addEventListener: jest.Mock; removeEventListener: jest.Mock } {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return options?.getAborted ? options.getAborted(reads) : false;
    },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as AbortSignal & { addEventListener: jest.Mock; removeEventListener: jest.Mock };
}

export function asRuntimeInfoCache(provider: object): RuntimeInfoCacheHarness {
  return provider as RuntimeInfoCacheHarness;
}

export function asRequestMessage(value: object): vscode.LanguageModelChatRequestMessage {
  return value as vscode.LanguageModelChatRequestMessage;
}

export function makeFetchResponse(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Headers | { get: (name: string) => string | null };
  body?: unknown;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Response {
  const status = init.status ?? (init.ok === false ? 500 : 200);
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: init.statusText ?? (status === 200 ? "OK" : ""),
    headers: init.headers ?? { get: () => null },
    body: init.body ?? null,
    json: init.json,
    text: init.text,
  } as Response;
}

export function getLanguageModelThinkingPart(
  vscodeModule: typeof vscode,
): new (value: string) => { value: string } {
  const ThinkingPart = (
    vscodeModule as unknown as {
      LanguageModelThinkingPart?: new (value: string) => { value: string };
    }
  ).LanguageModelThinkingPart;
  if (!ThinkingPart) {
    throw new Error("LanguageModelThinkingPart is not available on the vscode mock");
  }
  return ThinkingPart;
}

export const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;
