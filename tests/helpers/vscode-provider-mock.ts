/**
 * Shared VS Code double for provider tests. LanguageModelChatMessageRole.System
 * must be 3 to match the real VS Code enum.
 */
export function createProviderVscodeMock(): Record<string, unknown> {
  class LanguageModelDataPart {
    constructor(
      public data: Uint8Array,
      public mimeType?: string,
    ) {}
    static json(value: unknown, mime?: string) {
      return new LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(value)),
        mime ?? "application/json",
      );
    }
  }

  return {
    SecretStorage: class {},
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
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
    LanguageModelDataPart,
    LanguageModelThinkingPart: class {
      constructor(public value: string) {}
    },
    window: {
      createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn(),
      })),
      showInputBox: jest.fn(),
      showInformationMessage: jest.fn().mockResolvedValue(undefined),
      showWarningMessage: jest.fn().mockResolvedValue("Save"),
    },
    workspace: {
      getConfiguration: jest.fn(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => defaultValue),
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
    ThemeIcon: class {
      constructor(public id: string) {}
    },
  };
}
