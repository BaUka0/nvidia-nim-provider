export class CancellationError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

export const CancellationToken = {
  None: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
};

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export class Disposable {
  static from(...disposables: { dispose: () => void }[]): { dispose: () => void } {
    return {
      dispose: () => {
        for (const d of disposables) d.dispose();
      },
    };
  }
  constructor(public dispose: () => void) {}
}

export const LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 3 };

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: Record<string, unknown>,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}

export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
}

export class LanguageModelChatMessage {
  constructor(
    public role: number,
    public content: unknown[],
  ) {}
}

export class MarkdownString {
  value = "";
  isTrusted = false;
  supportThemeIcons = false;
  appendMarkdown(text: string): MarkdownString {
    this.value += text;
    return this;
  }
  appendText(text: string): MarkdownString {
    this.value += text;
    return this;
  }
  appendCodeblock(value: string, _language?: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export class ThemeColor {
  constructor(public id: string) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}

export class PreparedToolInvocation {
  constructor(public invocationMessage: string) {}
}

export const lm = {
  registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
  registerTool: () => ({ dispose: () => {} }),
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showInputBox: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const commands = {
  registerCommand: (_id: string, _callback: (...args: unknown[]) => unknown) => ({
    dispose: () => {},
  }),
  executeCommand: async (_command: string, ..._args: unknown[]) => {},
};

export const workspace = {
  getConfiguration: jest.fn((_section?: string) => ({
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    update: jest.fn(async (_key: string, _value: unknown, _target?: unknown) => {}),
    has: jest.fn((_key: string) => false),
    inspect: jest.fn((_key: string) => undefined),
  })),
};

export const version = "1.104.0";

