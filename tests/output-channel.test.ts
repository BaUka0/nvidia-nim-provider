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

  it("counts logged message bodies at their real size against the session cap", async () => {
    const { debugLog, getSessionEvents, resetSessionLogsForTests, setDeveloperLogOptions } =
      await import("../src/shared/logging");
    resetSessionLogsForTests();
    setDeveloperLogOptions({ logUserMessages: true });

    const body = [{ role: "user", content: "x".repeat(50 * 1024) }];
    for (let i = 0; i < 8; i += 1) {
      debugLog("Outgoing request messages", body, "messages");
    }

    // 256 KB holds five 50 KB bodies; the oldest are evicted.
    expect(getSessionEvents()).toHaveLength(5);
  });

  it("keeps the tail of an oversized body instead of flushing the log", async () => {
    const { debugLog, getSessionEvents, resetSessionLogsForTests, setDeveloperLogOptions } =
      await import("../src/shared/logging");
    resetSessionLogsForTests();
    setDeveloperLogOptions({ logUserMessages: true });

    debugLog("budget", { estimatedInputTokens: 1 });
    debugLog(
      "Outgoing request messages",
      [{ role: "user", content: `${"x".repeat(600 * 1024)}newest message` }],
      "messages",
    );

    const events = getSessionEvents();
    expect(events.map((event) => event.label)).toEqual(["budget", "Outgoing request messages"]);
    const value = events[1].value as string;
    expect(value.length).toBeLessThanOrEqual(64 * 1024);
    expect(value).toMatch(/^…\[\d+ chars omitted\] /);
    expect(value).toContain("newest message");
  });

  it("evicts request bodies before technical events", async () => {
    const { debugLog, getSessionEvents, resetSessionLogsForTests, setDeveloperLogOptions } =
      await import("../src/shared/logging");
    resetSessionLogsForTests();
    setDeveloperLogOptions({ logUserMessages: true });

    debugLog("activate", "Extension activated.");
    for (let i = 0; i < 6; i += 1) {
      debugLog("Outgoing request messages", "y".repeat(60 * 1024), "messages");
      debugLog("stream timing", { attempt: i });
    }

    const labels = getSessionEvents().map((event) => event.label);
    expect(labels[0]).toBe("activate");
    expect(labels.filter((label) => label === "stream timing")).toHaveLength(6);
    expect(labels.filter((label) => label === "Outgoing request messages").length).toBeLessThan(6);
  });
});
