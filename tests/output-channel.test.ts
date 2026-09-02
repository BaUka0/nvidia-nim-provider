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

    const { debugEnabled, debugLog, getOutputChannel } = await import("../src/shared/logging");

    expect(debugEnabled()).toBe(true);

    getOutputChannel();
    debugLog("activate", "ready");

    expect(mockCreateOutputChannel).toHaveBeenCalledWith("NVIDIA NIM");
    expect(mockAppendLine).toHaveBeenCalledWith("[NVIDIA NIM Debug] activate: ready");
  });

  it("warnLog always writes to channel regardless of debug flag", async () => {
    delete process.env.NVIDIA_NIM_DEBUG;

    const { warnLog, getOutputChannel } = await import("../src/shared/logging");
    getOutputChannel();
    warnLog("timeout", "Stream approaching idle timeout");

    expect(mockAppendLine).toHaveBeenCalledWith(
      "[NVIDIA NIM Warning] timeout: Stream approaching idle timeout",
    );
  });

  it("debugLog survives circular payloads without throwing", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const { debugLog, getOutputChannel } = await import("../src/shared/logging");
    getOutputChannel();

    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => debugLog("circular", circular)).not.toThrow();
    expect(mockAppendLine).toHaveBeenCalledWith(
      expect.stringContaining("[NVIDIA NIM Debug] circular:"),
    );
  });

  it("redacts short Bearer tokens and non-Bearer Authorization headers", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const { debugLog, getOutputChannel, redactSecrets } = await import("../src/shared/logging");
    getOutputChannel();

    expect(redactSecrets("Bearer abcd")).toBe("Bearer [REDACTED]");
    expect(redactSecrets("Authorization: super-secret-token")).toBe("Authorization: [REDACTED]");

    debugLog("auth", "Bearer abcd");
    expect(mockAppendLine).toHaveBeenCalledWith(expect.stringContaining("Bearer [REDACTED]"));
  });

  it("warnLog still works when debug is enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const { warnLog, getOutputChannel } = await import("../src/shared/logging");
    getOutputChannel();
    mockAppendLine.mockClear();
    warnLog("test", "warn msg");

    expect(mockAppendLine).toHaveBeenCalledTimes(1);
  });

  it("records technical debug events in the session ring when debug output is off", async () => {
    delete process.env.NVIDIA_NIM_DEBUG;

    const { debugLog, getSessionEvents, getOutputChannel } = await import("../src/shared/logging");
    getOutputChannel();
    mockAppendLine.mockClear();
    debugLog("budget", { remaining: 12 });

    expect(mockAppendLine).not.toHaveBeenCalled();
    expect(getSessionEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "debug",
          kind: "tech",
          label: "budget",
        }),
      ]),
    );
  });

  it("keeps stream chunks and user messages out of the log unless enabled", async () => {
    process.env.NVIDIA_NIM_DEBUG = "1";

    const {
      debugLog,
      getSessionEvents,
      getOutputChannel,
      resetSessionLogsForTests,
      setDeveloperLogOptions,
    } = await import("../src/shared/logging");
    getOutputChannel();
    resetSessionLogsForTests();
    mockAppendLine.mockClear();

    debugLog("stream chunk", { contentHead: "secret" }, "chunk");
    debugLog("Outgoing request messages", [{ role: "user", content: "prompt" }], "messages");
    expect(mockAppendLine).not.toHaveBeenCalled();
    expect(getSessionEvents()).toHaveLength(0);

    setDeveloperLogOptions({ logStreamChunks: true, logUserMessages: true });
    debugLog("stream chunk", { contentHead: "secret" }, "chunk");
    debugLog("Outgoing request messages", [{ role: "user", content: "prompt" }], "messages");
    expect(mockAppendLine).toHaveBeenCalledTimes(2);
    expect(getSessionEvents()).toHaveLength(2);
  });
});
