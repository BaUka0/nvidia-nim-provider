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
});
