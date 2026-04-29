const mockShowInformationMessage = jest.fn();
const mockCreateStatusBarItem = jest.fn(() => ({
  text: "",
  tooltip: "",
  command: "",
  show: jest.fn(),
  dispose: jest.fn(),
}));
const mockExecuteCommand = jest.fn();

jest.mock("vscode", () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
    createStatusBarItem: mockCreateStatusBarItem,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: { executeCommand: mockExecuteCommand },
}));

describe("StatusBarManager", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("creates a status bar item on construction", async () => {
    const { StatusBarManager } = await import("../src/status-bar");
    new StatusBarManager();
    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("shows model count when set to ok state", async () => {
    const { StatusBarManager } = await import("../src/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showOk(5);
    expect(item.text).toBe("$(copilot) NVIDIA NIM: 5 models");
    expect(item.command).toBe("nvidia-nim.refreshModels");
    expect(item.show).toHaveBeenCalled();
  });

  it("shows spinning icon when set to refreshing state", async () => {
    const { StatusBarManager } = await import("../src/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showRefreshing();
    expect(item.text).toBe("$(loading~spin) NVIDIA NIM");
    expect(item.show).toHaveBeenCalled();
  });

  it("shows error icon and tooltip when set to error state", async () => {
    const { StatusBarManager } = await import("../src/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.showError("API key invalid");
    expect(item.text).toBe("$(error) NVIDIA NIM");
    expect(item.tooltip).toBe("NVIDIA NIM Error: API key invalid");
    expect(item.show).toHaveBeenCalled();
  });

  it("dispose removes the status bar item", async () => {
    const { StatusBarManager } = await import("../src/status-bar");
    const manager = new StatusBarManager();
    const item = mockCreateStatusBarItem.mock.results[0].value;
    manager.dispose();
    expect(item.dispose).toHaveBeenCalled();
  });
});
