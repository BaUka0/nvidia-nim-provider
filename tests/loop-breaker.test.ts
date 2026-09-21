import { buildLoopBreakerNudge, LoopBreakerNudgeReason } from "../src/provider/loop-breaker";

describe("buildLoopBreakerNudge", () => {
  const reasons: LoopBreakerNudgeReason[] = [
    "repetition_loop",
    "tool_call_loop",
    "output_truncated",
    "content_filter",
    "stream_timeout",
  ];

  it.each(reasons)("builds a user role nudge for reason %s", (reason) => {
    const nudge = buildLoopBreakerNudge(reason);
    expect(nudge.role).toBe("user");
    expect(typeof nudge.content).toBe("string");
    expect(nudge.content.length).toBeGreaterThan(10);
  });

  it("nudges a stalled stream to continue from where it left off", () => {
    const nudge = buildLoopBreakerNudge("stream_timeout");
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("stalled");
  });

  it("nudges on repetition loop without adversarial tags", () => {
    const nudge = buildLoopBreakerNudge("repetition_loop");
    expect(nudge.role).toBe("user");
    expect(nudge.content).not.toContain("[NIM_LOOP_BREAKER]");
    expect(nudge.content).toContain("without repeating");
  });
});
