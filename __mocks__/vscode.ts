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
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
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

export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelThinkingPart {
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
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}

export class LanguageModelChatMessage {
  constructor(
    public role: number,
    public content: unknown[],
  ) {}
}

export class LanguageModelError extends Error {
  readonly code: string;

  constructor(message?: string, code = "Unknown") {
    super(message);
    this.name = "LanguageModelError";
    this.code = code;
  }

  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }

  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }

  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
}

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
    public readonly path: string = fsPath,
  ) {}

  static file(filePath: string): Uri {
    return new Uri("file", filePath, filePath.replace(/\\/g, "/"));
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(value);
    const scheme = match ? match[1] : "file";
    const uriPath = match ? match[2] : value;
    return new Uri(scheme, uriPath, uriPath);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
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

export const version = "1.125.0";
