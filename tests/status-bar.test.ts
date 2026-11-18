import { textWidthEm } from "../src/shared/live-status";

const mockShowInformationMessage = jest.fn();
const mockHide = jest.fn();
const mockShow = jest.fn();
const mockCreateStatusBarItem = jest.fn(() => ({
  text: "",
  tooltip: "",
  command: "",
  color: undefined,
  backgroundColor: undefined,
  show: mockShow,
  hide: mockHide,
  dispose: jest.fn(),
}));
const mockExecuteCommand = jest.fn();
const mockGetConfig = jest.fn((_key: string, defaultValue: unknown) => defaultValue);

jest.mock("vscode", () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
    createStatusBarItem: mockCreateStatusBarItem,
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: mockGetConfig,
    })),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: { executeCommand: mockExecuteCommand },
  MarkdownString: class {
    value = "";
    isTrusted = false;
    supportThemeIcons = false;
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
    appendCodeblock(value: string) {
      this.value += value;
      return this;
    }
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
}));

describe("formatTokenCount", () => {
  it.each([
    [512, "512"],
    [18_300, "18.3k"],
    [128_000, "128k"],
    [262_144, "262.1k"],
    [999_949, "999.9k"],
    [999_950, "1M"],
    [1_048_576, "1M"],
    [1_250_000, "1.3M"],
  ])("formats %i as %s", async (tokens, expected) => {
    const { formatTokenCount } = await import("../src/shared/status-bar");
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe("StatusBarManager", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("creates a status bar item on construction", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    new StatusBarManager();
    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
  });

  it("shows model count with zap icon when set to ok state", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showOk(5);
    expect(item.text).toBe("$(zap) NVIDIA NIM: 5 models");
    expect(item.command).toBe("nvidia-nim.refreshModels");
    expect(item.show).toHaveBeenCalled();
  });

  it("shows spinning icon when set to refreshing state", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showRefreshing();
    expect(item.text).toBe("$(loading~spin) NVIDIA NIM");
    expect(item.show).toHaveBeenCalled();
  });

  it("shows error icon and tooltip when set to error state", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showError("API key invalid");
    expect(item.text).toBe("$(zap) NVIDIA NIM");
    expect(item.tooltip).toBe("NVIDIA NIM Error: API key invalid");
    expect(item.show).toHaveBeenCalled();
  });

  it("redacts API keys and bearer tokens in showError tooltip", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showError(
      "Auth failed for nvapi-secretKey1234567890 with header Bearer eyJhbGciOiJIUzI1NiJ9.token",
    );
    expect(item.tooltip).toBe(
      "NVIDIA NIM Error: Auth failed for nvapi-[REDACTED] with header Bearer [REDACTED]",
    );
    expect(item.tooltip).not.toContain("secretKey1234567890");
    expect(item.tooltip).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("dispose removes the status bar item", async () => {
    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.dispose();
    expect(item.dispose).toHaveBeenCalled();
  });

  it("hides the status bar item when ui.showStatusBarItem is false", async () => {
    mockGetConfig.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === "ui.showStatusBarItem") return false;
      return defaultValue;
    });

    const { StatusBarManager } = await import("../src/shared/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showOk(5);
    expect(item.hide).toHaveBeenCalled();
  });

  describe("showTokenBreakdown", () => {
    it("displays X/Y format in status bar text", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Step 3.7 Flash",
        systemPrompt: 120,
        tools: 2100,
        userMessages: 8300,
        assistantMessages: 3200,
        toolCalls: 450,
        toolResults: 11400,
        images: 79,
        actualPromptTokens: 25549,
        output: 40,
        contextWindow: 262144,
      });
      expect(item.text).toBe("$(zap) Step 3.7 Flash: 25.5k/262.1k");
    });

    it("sets tooltip as MarkdownString with breakdown table", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Step 3.7 Flash",
        systemPrompt: 120,
        tools: 2100,
        userMessages: 8300,
        assistantMessages: 3200,
        toolCalls: 450,
        toolResults: 11400,
        images: 79,
        actualPromptTokens: 25549,
        output: 40,
        contextWindow: 262144,
      });
      expect(item.tooltip).toBeDefined();
      const md = item.tooltip as { value: string };
      expect(md.value).toContain("Step 3.7 Flash");
      expect(md.value).toContain("System Prompt");
      expect(md.value).toContain("Tool Results");
      expect(md.value).toContain("Output (completion)");
      expect(md.value).toMatch(/25.?549/);
      expect(md.value).toMatch(/262.?144/);
    });

    it("keeps the refresh command active after showing the token breakdown", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Kimi K2.6",
        systemPrompt: 0,
        tools: 0,
        userMessages: 100,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        actualPromptTokens: undefined,
        output: 0,
        contextWindow: 262144,
      });
      expect(item.command).toBe("nvidia-nim.refreshModels");
    });

    it("sets warning background at >80% context usage", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Kimi K2.6",
        systemPrompt: 0,
        tools: 0,
        userMessages: 210000,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        actualPromptTokens: 210000,
        output: 0,
        contextWindow: 262144,
      });
      expect(item.backgroundColor).toBeDefined();
      expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.warningBackground");
    });

    it("sets error background at >95% context usage", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Kimi K2.6",
        systemPrompt: 0,
        tools: 0,
        userMessages: 250000,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        actualPromptTokens: 250000,
        output: 0,
        contextWindow: 262144,
      });
      expect(item.backgroundColor).toBeDefined();
      expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.errorBackground");
    });

    it("scales category estimates proportionally to actual prompt tokens", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Kimi K2.6",
        systemPrompt: 100,
        tools: 200,
        userMessages: 300,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        actualPromptTokens: 600,
        output: 0,
        contextWindow: 262144,
      });
      const md = item.tooltip as { value: string };
      expect(md.value).toContain("*(actual)*");
    });

    it("does not scale categories when actual prompt tokens are unavailable", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "GLM 5.1",
        systemPrompt: 100,
        tools: 200,
        userMessages: 300,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        actualPromptTokens: undefined,
        output: 0,
        contextWindow: 131072,
      });
      expect(item.text).toContain("600");
      const md = item.tooltip as { value: string };
      expect(md.value).not.toContain("*(actual)*");
    });

    it("marks completion usage as unavailable when the API does not report it", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showTokenBreakdown({
        modelName: "Inkling",
        systemPrompt: 100,
        tools: 0,
        userMessages: 200,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        contextWindow: 1000000,
      });

      const md = item.tooltip as { value: string };
      expect(md.value).toContain("Output (completion) | Not reported");
      expect(md.value).toContain("Total Used** | **Not available");
    });
  });
  describe("live activity", () => {
    const breakdown = {
      modelName: "Kimi K3",
      systemPrompt: 100,
      tools: 0,
      userMessages: 400,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      images: 0,
      actualPromptTokens: 12300,
      actualCompletionTokens: 480,
      contextWindow: 262144,
    };

    beforeEach(() => {
      jest.useFakeTimers({ now: 10_000 });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Live text without the fixed-width padding. */
    const label = (text: string): string => text.replace(/[\u2007\u2009]+$/u, "");

    it("shows waiting time, the latest reasoning phrase, and writing speed", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      const activity = manager.beginActivity("Kimi K3");
      activity.attemptStarted();
      const widths: number[] = [];
      jest.advanceTimersByTime(900);
      expect(label(item.text)).toBe("$(loading~spin) Kimi K3: waiting 0s");
      widths.push(textWidthEm(item.text));
      jest.advanceTimersByTime(1100);
      expect(label(item.text)).toBe("$(loading~spin) Kimi K3: waiting 2s");
      widths.push(textWidthEm(item.text));

      activity.reasoning("The user wants live stats. Let me check the stream pump");
      jest.advanceTimersByTime(250);
      expect(label(item.text)).toBe("$(loading~spin) The user wants live stats.");
      widths.push(textWidthEm(item.text));
      const thinkingTooltip = item.tooltip as { value: string };
      expect(thinkingTooltip.value).toContain("| Time to first token | 2.0s |");
      expect(thinkingTooltip.value).toContain("| Phase | Thinking |");
      expect(thinkingTooltip.value).not.toContain("live stats");

      activity.answer("x".repeat(400));
      jest.advanceTimersByTime(1000);
      expect(label(item.text)).toMatch(/^\$\(loading~spin\) Kimi K3: writing · ~\d+ tok\/s$/);
      widths.push(textWidthEm(item.text));

      activity.reasoning(
        "A much longer reasoning sentence that would never fit into the status bar item at all.\n",
      );
      jest.advanceTimersByTime(250);
      expect(label(item.text)).toMatch(/…$/u);
      widths.push(textWidthEm(item.text));

      for (const width of widths) {
        expect(Math.abs(width - widths[0]!)).toBeLessThan(0.2);
      }
      manager.dispose();
    });

    it("keeps the live tooltip object while only ticking values change", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      const activity = manager.beginActivity("Kimi K3");
      activity.attemptStarted();
      const waitingTooltip = item.tooltip;
      jest.advanceTimersByTime(3000);
      expect(label(item.text)).toBe("$(loading~spin) Kimi K3: waiting 3s");
      expect(item.tooltip).toBe(waitingTooltip);

      activity.answer("Hello");
      jest.advanceTimersByTime(250);
      const writingTooltip = item.tooltip as { value: string };
      expect(writingTooltip).not.toBe(waitingTooltip);
      expect(writingTooltip.value).toContain("| Phase | Writing the answer |");
      expect(writingTooltip.value).toContain("| Time to first token | 3.0s |");
      expect(writingTooltip.value).toContain("| Started |");
      expect(writingTooltip.value).not.toContain("tok/s");

      for (let i = 0; i < 8; i += 1) {
        activity.answer(" more words streaming in");
        jest.advanceTimersByTime(250);
      }
      expect(label(item.text)).toMatch(/writing · ~\d+ tok\/s$/u);
      expect(item.tooltip).toBe(writingTooltip);
      activity.end();
    });

    it("restores the summary with time to first token and speed when the call finishes", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      const activity = manager.beginActivity("Kimi K3");
      activity.attemptStarted();
      jest.advanceTimersByTime(1200);
      activity.answer("Hello");
      jest.advanceTimersByTime(4000);
      activity.answer(" world");

      manager.showTokenBreakdown(breakdown, activity.finish(480));
      expect(item.text).toBe("$(zap) Kimi K3: 12.3k/262.1k · 1.2s · 120 tok/s");
      const md = item.tooltip as { value: string };
      expect(md.value).toContain("| Time to first token | 1.2s |");
      expect(md.value).toContain("| Generation speed | 120 tok/s |");
      expect(md.value).toContain("| Generation time | 4.0s |");

      jest.advanceTimersByTime(1000);
      expect(item.text).toBe("$(zap) Kimi K3: 12.3k/262.1k · 1.2s · 120 tok/s");
      expect(jest.getTimerCount()).toBe(0);
    });

    it("defers static states while a call runs and restores them when it ends", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      manager.showOk(7);
      const activity = manager.beginActivity("Kimi K3");
      manager.showOk(8);
      expect(item.text).toContain("waiting");

      activity.end();
      activity.end();
      expect(item.text).toBe("$(zap) NVIDIA NIM: 8 models");
      expect(jest.getTimerCount()).toBe(0);
    });

    it("keeps showing the newest running call when an older one ends", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      const older = manager.beginActivity("Older");
      const newer = manager.beginActivity("Newer");
      expect(item.text).toContain("Newer");

      newer.end();
      expect(item.text).toContain("Older");
      manager.showTokenBreakdown(breakdown, older.finish(10));
      expect(item.text).toContain("$(zap) Kimi K3");
    });

    it("keeps model text from rendering as status bar icons", async () => {
      const { StatusBarManager } = await import("../src/shared/status-bar");
      const manager = new StatusBarManager();
      const item = mockCreateStatusBarItem.mock.results[0].value;
      const activity = manager.beginActivity("Model");
      activity.attemptStarted();
      activity.reasoning("Use $(alert) here.");
      jest.advanceTimersByTime(250);
      const zeroWidthSpace = String.fromCharCode(0x200b);
      expect(label(item.text)).toBe(`$(loading~spin) Use $${zeroWidthSpace}(alert) here.`);
      activity.end();
    });
  });
});
