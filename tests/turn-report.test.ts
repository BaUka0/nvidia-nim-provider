import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXTENSION_VERSION } from "../src/shared/constants";
import { detectCycleHint } from "../src/shared/cycle-detection";
import { debugLog, resetSessionLogsForTests } from "../src/shared/logging";
import {
  MAX_TURN_REPORTS,
  buildSessionLogFilename,
  buildTurnReportFilename,
  clipHeadTail,
  findReusedToolCallIds,
  formatSessionLogsPayload,
  formatTurnReportsPayload,
  inferHarness,
  inferReasoningModeFromRequest,
  recordTurnReport,
  resetTurnReportsForTests,
  resolveDownloadsDir,
  writeTurnReportFile,
} from "../src/shared/turn-report";
import { NimChatRequest } from "../src/types";

jest.mock("vscode", () => ({
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    })),
  },
}));

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
}));

const ISSUE_7_SUPER_CYCLE = [
  "Probably it's done. Let's check subfolders. We need to see if it succeeded. Let's check a sample file. We need to check if the script is still running or finished. Let's see output more. ",
]
  .join("")
  .repeat(8);

describe("turn-report", () => {
  beforeEach(() => {
    resetTurnReportsForTests();
    resetSessionLogsForTests();
    jest.clearAllMocks();
  });

  it("clips short text to head only and redacts secrets in snippets", () => {
    expect(clipHeadTail("hello")).toEqual({ head: "hello", tail: "" });
    const long = `start ${"x".repeat(300)} nvapi-ABCDEFGHIJKLMNOP end`;
    const clipped = clipHeadTail(long, 40);
    expect(clipped.head.length).toBe(40);
    expect(clipped.tail.length).toBe(40);
    expect(clipped.head.startsWith("start ")).toBe(true);
    expect(clipped.tail).toContain("nvapi-[REDACTED]");
    expect(clipped.tail).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("detects the Super 120B paragraph cycle from issue #7 and ignores a normal answer", () => {
    expect(detectCycleHint(ISSUE_7_SUPER_CYCLE)).toBe(true);
    expect(
      detectCycleHint("Here is the refactored function. It now returns the parsed JSON payload."),
    ).toBe(false);
    expect(detectCycleHint("")).toBe(false);
  });

  it("infers reasoning mode from request fields", () => {
    expect(inferReasoningModeFromRequest({ model: "x", messages: [] })).toBeUndefined();
    expect(
      inferReasoningModeFromRequest({
        model: "x",
        messages: [],
        reasoning_effort: "high",
      }),
    ).toBe("high");
    expect(
      inferReasoningModeFromRequest({
        model: "x",
        messages: [],
        chat_template_kwargs: { enable_thinking: true, low_effort: true },
      }),
    ).toBe("low");
    expect(
      inferReasoningModeFromRequest({
        model: "x",
        messages: [],
        chat_template_kwargs: { enable_thinking: false },
      }),
    ).toBe("none");
    expect(
      inferReasoningModeFromRequest({
        model: "x",
        messages: [],
        chat_template_kwargs: { enable_thinking: true, reasoning_budget: 16384 },
      }),
    ).toBe("budget:16384");
  });

  it("records a ring of the last five reports and omits payload when empty", () => {
    expect(formatTurnReportsPayload()).toBeUndefined();

    for (let i = 0; i < MAX_TURN_REPORTS + 2; i += 1) {
      recordTurnReport({
        outcome: "ok",
        modelId: `model-${i}`,
        lastVisibleText: `answer ${i}`,
        recordedAt: "2026-08-29T00:00:00.000Z",
      });
    }

    const payload = formatTurnReportsPayload();
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload ?? "{}") as {
      extension: string;
      version: string;
      turns: { modelId: string }[];
    };
    expect(parsed.extension).toBe("nvidia-nim-provider");
    expect(parsed.version).toBe(EXTENSION_VERSION);
    expect(parsed.turns).toHaveLength(MAX_TURN_REPORTS);
    expect(parsed.turns[0]?.modelId).toBe("model-2");
    expect(parsed.turns.at(-1)?.modelId).toBe("model-6");
  });

  it("captures sampling, tools, skipped calls, and redacts error text", () => {
    const request: NimChatRequest = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [],
      temperature: 1,
      top_p: 0.95,
      tool_choice: "auto",
      chat_template_kwargs: { enable_thinking: true, low_effort: true },
      tools: [{ type: "function", function: { name: "read_file" } }],
    };
    const report = recordTurnReport({
      outcome: "error",
      modelId: request.model,
      requestBody: request,
      sawToolCall: true,
      emittedToolCall: false,
      skippedToolCalls: [{ name: "read_file", reason: "truncated" }],
      finishReason: "stop",
      streamChunkCount: 12,
      lastVisibleText: "Let me check the file.",
      durationMs: 1500,
      repetitionTripped: false,
      autoContinueFired: false,
      retryReasonHistory: ["invalid_tool_call"],
      errorKind: "invalid_request",
      errorMessage: "Bearer super-secret-token-value rejected",
      recordedAt: "2026-08-29T12:00:00.000Z",
    });

    expect(report.toolsEnabled).toBe(true);
    expect(report.toolNames).toEqual(["read_file"]);
    expect(report.reasoningMode).toBe("low");
    expect(report.temperature).toBe(1);
    expect(report.skippedToolCalls).toEqual([{ name: "read_file", reason: "truncated" }]);
    expect(report.errorMessage).toContain("Bearer [REDACTED]");
    expect(report.errorMessage).not.toContain("super-secret-token-value");
    expect(report.cycleHint).toBe(false);
  });

  it("keeps the tripped detector field for guard audit trails", () => {
    const report = recordTurnReport({
      outcome: "retry",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      lastVisibleText: "- **Specific Issues**:\n",
      repetitionTripped: true,
      trippedDetector: "lineCounter",
      autoContinueFired: true,
      recordedAt: "2026-08-29T12:00:00.000Z",
    });
    expect(report.repetitionTripped).toBe(true);
    expect(report.trippedDetector).toBe("lineCounter");

    const payload = JSON.parse(formatTurnReportsPayload() ?? "{}") as {
      turns: { repetitionTripped: boolean; trippedDetector?: string }[];
    };
    const saved = payload.turns.at(-1);
    expect(saved?.repetitionTripped).toBe(true);
    expect(saved?.trippedDetector).toBe("lineCounter");

    // A clean turn without a trip must not carry the field.
    const clean = recordTurnReport({
      outcome: "ok",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      lastVisibleText: "Done.",
      repetitionTripped: false,
      recordedAt: "2026-08-29T12:00:01.000Z",
    });
    expect(clean.trippedDetector).toBeUndefined();
  });

  it("records emitted tool calls, the request tail and the Copilot harness (issue #29)", () => {
    const request: NimChatRequest = {
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      messages: [
        { role: "user", content: "add logging" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_view", type: "function", function: { name: "view", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "file body", tool_call_id: "call_view" },
      ],
      tools: ["bash", "view", "edit", "task"].map((name) => ({
        type: "function" as const,
        function: { name },
      })),
    };
    const report = recordTurnReport({
      outcome: "ok",
      modelId: request.model,
      requestBody: request,
      requestTail: "tool_result",
      sawToolCall: true,
      emittedToolCall: true,
      emittedToolCalls: [{ id: "call_edit", name: "edit" }],
      finishReason: "tool_calls",
      recordedAt: "2026-10-05T22:24:33.301Z",
    });

    expect(report.harness).toBe("copilot");
    expect(report.requestTail).toBe("tool_result");
    expect(report.emittedToolCalls).toEqual([{ id: "call_edit", name: "edit" }]);
    expect(report.reusedToolCallIds).toBeUndefined();

    const payload = JSON.parse(formatTurnReportsPayload() ?? "{}") as {
      turns: { harness?: string; emittedToolCalls: { id: string; name: string }[] }[];
    };
    expect(payload.turns.at(-1)?.harness).toBe("copilot");
    expect(payload.turns.at(-1)?.emittedToolCalls).toEqual([{ id: "call_edit", name: "edit" }]);

    // A turn without tools carries an empty list and no harness or tail.
    const bare = recordTurnReport({ outcome: "ok", modelId: request.model });
    expect(bare.emittedToolCalls).toEqual([]);
    expect(bare.harness).toBeUndefined();
    expect(bare.requestTail).toBeUndefined();
  });

  it("flags tool call ids reused from history or repeated within one reply", () => {
    const request: NimChatRequest = {
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_0", type: "function", function: { name: "view", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "ok", tool_call_id: "call_0" },
      ],
    };
    expect(
      findReusedToolCallIds(
        [
          { id: "call_0", name: "view" },
          { id: "call_1", name: "edit" },
          { id: "call_1", name: "edit" },
          { id: "call_2", name: "bash" },
        ],
        request,
      ),
    ).toEqual(["call_0", "call_1"]);
    expect(findReusedToolCallIds([{ id: "call_9", name: "view" }], request)).toEqual([]);
    expect(findReusedToolCallIds([{ id: "call_9", name: "view" }], undefined)).toEqual([]);
  });

  it("infers the harness from the offered tool set", () => {
    expect(inferHarness(["bash", "read_bash", "view", "create", "edit", "task"])).toBe("copilot");
    expect(inferHarness(["powershell", "view", "edit", "usages", "problems"])).toBe("copilot");
    expect(inferHarness(["read_file", "replace_string_in_file", "run_in_terminal"])).toBe("local");
    expect(inferHarness(["edit", "view"])).toBeUndefined();
    expect(inferHarness([])).toBeUndefined();
  });

  it("builds a Downloads path and timestamped filename", () => {
    expect(resolveDownloadsDir("/home/dev")).toBe(path.join("/home/dev", "Downloads"));
    expect(buildTurnReportFilename(new Date(2026, 7, 29, 15, 4, 9))).toBe(
      "nvidia-nim-turn-report-20260829-150409.json",
    );
    expect(buildSessionLogFilename(new Date(2026, 7, 29, 15, 4, 9))).toBe(
      "nvidia-nim-session-20260829-150409.json",
    );
  });

  it("packs turns and session events into one payload", () => {
    expect(formatSessionLogsPayload()).toBeUndefined();
    debugLog("budget", { remaining: 3 });
    recordTurnReport({
      outcome: "ok",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      lastVisibleText: "hello",
      recordedAt: "2026-08-29T00:00:00.000Z",
    });
    const payload = formatSessionLogsPayload();
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload ?? "{}") as {
      settings: {
        logStreamChunks: boolean;
        logUserMessages: boolean;
        streamIdleTimeout: number;
        firstTokenTimeoutSeconds: number | null;
        fallbackOnFirstTokenTimeout: boolean;
      };
      turns: { modelId: string }[];
      events: { label: string }[];
    };
    expect(parsed.settings.logStreamChunks).toBe(false);
    expect(parsed.settings.logUserMessages).toBe(false);
    expect(parsed.settings.streamIdleTimeout).toBe(120);
    expect(parsed.settings.firstTokenTimeoutSeconds).toBeNull();
    expect(parsed.settings.fallbackOnFirstTokenTimeout).toBe(true);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.events.some((event) => event.label === "budget")).toBe(true);
  });

  it("creates the parent directory before writing the report file", async () => {
    const dest = path.join("/tmp", "Downloads", "nvidia-nim-turn-report.json");
    await writeTurnReportFile(dest, '{"turns":[]}');
    expect(fs.mkdir).toHaveBeenCalledWith(path.join("/tmp", "Downloads"), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(dest, '{"turns":[]}', "utf8");
  });
});
