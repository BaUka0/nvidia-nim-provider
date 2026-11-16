import {
  approximateOutputTokens,
  fitToWidth,
  formatDuration,
  formatElapsedSeconds,
  formatRate,
  splitReasoningPhrases,
  StreamActivityTracker,
  textWidthEm,
} from "../src/shared/live-status";

function makeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("splitReasoningPhrases", () => {
  it("splits sentences and lines and keeps the unfinished phrase apart", () => {
    expect(
      splitReasoningPhrases("The user wants a fix. Let me read the parser.\nThen check the te"),
    ).toEqual({
      complete: ["The user wants a fix.", "Let me read the parser."],
      partial: "Then check the te",
    });
  });

  it("treats a finished line or terminator as a complete phrase", () => {
    expect(splitReasoningPhrases("Plan the change\n")).toEqual({
      complete: ["Plan the change"],
      partial: "",
    });
    expect(splitReasoningPhrases("Looks good!")).toEqual({
      complete: ["Looks good!"],
      partial: "",
    });
  });

  it("drops Markdown list, heading, and emphasis markers", () => {
    expect(
      splitReasoningPhrases("## Plan\n- **Read** `stream-pump.ts`\n1. Add the hook\n"),
    ).toEqual({
      complete: ["Plan", "Read stream-pump.ts", "Add the hook"],
      partial: "",
    });
  });
});

describe("splitReasoningPhrases identifiers", () => {
  it("keeps underscores and asterisks inside identifiers", () => {
    expect(
      splitReasoningPhrases("patterns.ts: NON_CHAT_MODEL_ID_PATTERNS uses a*b and __init__\n")
        .complete,
    ).toEqual(["patterns.ts: NON_CHAT_MODEL_ID_PATTERNS uses a*b and init"]);
    expect(splitReasoningPhrases("Use _emphasis_ and ~~old~~ text\n").complete).toEqual([
      "Use emphasis and old text",
    ]);
  });
});

describe("fitToWidth", () => {
  const samples = [
    "",
    "Ok.",
    "waiting 3s",
    "overrides.ts: KNOWN_MODEL_OVERRIDES (lines 30-406)",
    "illicit little lilies fill it",
    "MMMMWWWW mammoth wombat",
    "中文的推理过程正在进行",
    "Let me use PowerShell to extract by line ranges and compare the outputs",
  ];

  it("renders every label at about the same width", () => {
    for (const sample of samples) {
      expect(Math.abs(textWidthEm(fitToWidth(sample, 21)) - 21)).toBeLessThanOrEqual(0.1);
    }
  });

  it("truncates long labels with an ellipsis and keeps short ones intact", () => {
    expect(fitToWidth("Ok.", 21).startsWith("Ok.")).toBe(true);
    const long = fitToWidth(samples[7]!, 21).trimEnd();
    expect(long).toMatch(/^Let me use PowerShell to extract.*…/u);
    expect(long).not.toContain("compare");
  });
});

describe("formatting helpers", () => {
  it("formats waiting time in whole seconds", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(1999)).toBe("1s");
    expect(formatElapsedSeconds(75_400)).toBe("1m 15s");
  });

  it("formats durations and rates compactly", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatRate(4.25)).toBe("4.3");
    expect(formatRate(48.4)).toBe("48");
    expect(formatRate(312.6)).toBe("313");
  });

  it("approximates Latin and CJK output tokens", () => {
    expect(approximateOutputTokens("abcdefgh")).toBe(2);
    expect(approximateOutputTokens("中文字")).toBe(2);
    expect(approximateOutputTokens("")).toBe(0);
  });
});

describe("StreamActivityTracker", () => {
  it("moves through phases and measures time to first token per attempt", () => {
    const clock = makeClock();
    const tracker = new StreamActivityTracker(clock.now);
    tracker.attemptStarted();
    expect(tracker.phase).toBe("waiting");
    expect(tracker.ttftMs()).toBeUndefined();

    clock.advance(800);
    tracker.reasoning("Checking the parser. ");
    expect(tracker.phase).toBe("thinking");
    expect(tracker.ttftMs()).toBe(800);

    tracker.answer("\n\n");
    expect(tracker.phase).toBe("thinking");
    tracker.answer("Here is the fix.");
    expect(tracker.phase).toBe("writing");
    tracker.toolCall('read_file{"filePath":');
    expect(tracker.phase).toBe("tool");

    tracker.attemptStarted();
    expect(tracker.attemptCount).toBe(2);
    expect(tracker.phase).toBe("waiting");
    expect(tracker.ttftMs()).toBeUndefined();
    clock.advance(300);
    tracker.answer("Retry answer");
    expect(tracker.ttftMs()).toBe(300);
  });

  it("shows the last finished phrase while the next one streams", () => {
    const tracker = new StreamActivityTracker(makeClock().now);
    tracker.attemptStarted();
    tracker.reasoning("Let me read");
    expect(tracker.currentPhrase()).toBe("Let me read");
    tracker.reasoning(" the file. Now compare the");
    expect(tracker.currentPhrase()).toBe("Let me read the file.");
    tracker.reasoning(" two branches.\nOk.");
    expect(tracker.currentPhrase()).toBe("Ok.");
  });

  it("never shows the cut-off fragment at the start of a trimmed reasoning tail", () => {
    const tracker = new StreamActivityTracker(makeClock().now);
    tracker.attemptStarted();
    // The first sentence is longer than the kept tail, so its start is cut off.
    tracker.reasoning(`Start ${"a".repeat(4100)} end. Next step`);
    expect(tracker.currentPhrase()).toBe("Next step");
  });

  it("reports a live rate only after a minimal window", () => {
    const clock = makeClock();
    const tracker = new StreamActivityTracker(clock.now);
    tracker.attemptStarted();
    tracker.answer("a".repeat(40));
    expect(tracker.liveTokensPerSecond()).toBeUndefined();
    clock.advance(1000);
    expect(tracker.liveTokensPerSecond()).toBeCloseTo(10);
  });

  it("prefers the backend completion count for final speed", () => {
    const clock = makeClock();
    const tracker = new StreamActivityTracker(clock.now);
    tracker.attemptStarted();
    clock.advance(500);
    tracker.reasoning("a".repeat(400));
    clock.advance(2000);
    tracker.answer("b".repeat(400));

    expect(tracker.stats(150)).toEqual({
      ttftMs: 500,
      generationMs: 2000,
      outputTokens: 150,
      outputTokensActual: true,
      tokensPerSecond: 75,
    });
    expect(tracker.stats()).toEqual({
      ttftMs: 500,
      generationMs: 2000,
      outputTokens: 200,
      outputTokensActual: false,
      tokensPerSecond: 100,
    });
  });

  it("omits speed when the call produced nothing or finished in one burst", () => {
    const clock = makeClock();
    const tracker = new StreamActivityTracker(clock.now);
    tracker.attemptStarted();
    expect(tracker.stats()).toEqual({ outputTokensActual: false });

    clock.advance(200);
    tracker.answer("one chunk");
    expect(tracker.stats(3)).toEqual({
      ttftMs: 200,
      generationMs: 0,
      outputTokens: 3,
      outputTokensActual: true,
    });
  });
});
