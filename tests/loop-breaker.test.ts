import { LOOP_BREAKER_MARKER, injectHistoryLoopBreaker } from "../src/provider/loop-breaker";
import { NimChatRequest } from "../src/types";
import { createStructuredError } from "../src/api/errors";

describe("injectHistoryLoopBreaker", () => {
  const requestBody: NimChatRequest = {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  };

  it("injects a breaker when assistant preambles repeat", () => {
    const history = [
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
    ];
    const result = injectHistoryLoopBreaker({
      requestBody,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: (body) => body,
    });
    expect(result.messages.at(-1)?.content).toEqual(expect.stringContaining(LOOP_BREAKER_MARKER));
  });

  it("drops the breaker only on token_limit", () => {
    const history = [
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
      { role: 2, content: [{ value: "Let me fix the formatting issue:" }] },
    ];
    const result = injectHistoryLoopBreaker({
      requestBody,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: () => {
        throw createStructuredError("token_limit", "too big");
      },
    });
    expect(result.messages).toHaveLength(1);
  });

  it("stops after four repeated preambles instead of sending another request", () => {
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [{ value: "Let me fix the formatting issue:" }],
    }));

    expect(() =>
      injectHistoryLoopBreaker({
        requestBody,
        historyMessages: history,
        modelId: "test-model",
        applyBudget: (body) => body,
      }),
    ).toThrow(/loop was stopped/i);
  });

  it("stops after four repeated tool calls instead of sending another request", () => {
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [
        {
          name: "run_in_terminal",
          input: { command: "npm run compile", mode: "sync" },
        },
      ],
    }));

    expect(() =>
      injectHistoryLoopBreaker({
        requestBody,
        historyMessages: history,
        modelId: "test-model",
        applyBudget: (body) => body,
      }),
    ).toThrow(/loop was stopped/i);
  });
});
