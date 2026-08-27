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
});
