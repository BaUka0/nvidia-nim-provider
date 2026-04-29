const mockAppendLine = jest.fn();
const mockCreateOutputChannel = jest.fn(() => ({
  appendLine: mockAppendLine,
  show: jest.fn(),
  dispose: jest.fn(),
}));

jest.mock("vscode", () => ({
  window: {
    createOutputChannel: mockCreateOutputChannel,
  },
}));

describe("output-channel", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.NVIDIA_NIM_DEBUG;
  });

  it("creates a NVIDIA NIM output channel and reads the NVIDIA debug env var", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const { debugEnabled, debugLog, getOutputChannel } = await import("../src/output-channel");

    expect(debugEnabled()).toBe(true);

    getOutputChannel();
    debugLog("activate", "ready");

    expect(mockCreateOutputChannel).toHaveBeenCalledWith("NVIDIA NIM");
    expect(mockAppendLine).toHaveBeenCalledWith("[NVIDIA NIM Debug] activate: ready");
  });

  it("errorLog always writes to channel regardless of debug flag", async () => {
    delete process.env.NVIDIA_NIM_DEBUG;

    const { errorLog, getOutputChannel } = await import("../src/output-channel");
    getOutputChannel();
    errorLog("request", "API key not found");

    expect(mockAppendLine).toHaveBeenCalledWith("[NVIDIA NIM Error] request: API key not found");
  });

  it("warnLog always writes to channel regardless of debug flag", async () => {
    delete process.env.NVIDIA_NIM_DEBUG;

    const { warnLog, getOutputChannel } = await import("../src/output-channel");
    getOutputChannel();
    warnLog("timeout", "Stream approaching idle timeout");

    expect(mockAppendLine).toHaveBeenCalledWith(
      "[NVIDIA NIM Warning] timeout: Stream approaching idle timeout",
    );
  });

  it("errorLog and warnLog still work when debug is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const { errorLog, warnLog, getOutputChannel } = await import("../src/output-channel");
    getOutputChannel();
    mockAppendLine.mockClear();
    errorLog("test", "error msg");
    warnLog("test", "warn msg");

    expect(mockAppendLine).toHaveBeenCalledTimes(2);
  });
});
