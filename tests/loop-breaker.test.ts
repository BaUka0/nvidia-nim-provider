import {
  LOOP_BREAKER_ESCALATION_MARKER,
  LOOP_BREAKER_MARKER,
  injectHistoryLoopBreaker,
} from "../src/provider/loop-breaker";
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

  it("injects a breaker after four repeated preambles instead of aborting the turn", () => {
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [{ value: "Let me fix the formatting issue:" }],
    }));

    const result = injectHistoryLoopBreaker({
      requestBody,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: (body) => body,
    });
    expect(result.messages.at(-1)?.content).toEqual(expect.stringContaining(LOOP_BREAKER_MARKER));
  });

  it("injects a breaker after four repeated tool calls instead of aborting the turn", () => {
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [
        {
          name: "run_in_terminal",
          input: { command: "npm run compile", mode: "sync" },
        },
      ],
    }));

    const result = injectHistoryLoopBreaker({
      requestBody,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: (body) => body,
    });
    expect(result.messages.at(-1)?.content).toEqual(expect.stringContaining(LOOP_BREAKER_MARKER));
  });

  it("escalates when a breaker is already present after a hard loop", () => {
    const requestBodyWithBreaker: NimChatRequest = {
      model: "test",
      messages: [{ role: "user", content: `${LOOP_BREAKER_MARKER} already` }],
    };
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [{ value: "Let me fix the formatting issue:" }],
    }));

    const result = injectHistoryLoopBreaker({
      requestBody: requestBodyWithBreaker,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: (body) => body,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.at(-1)?.content).toEqual(
      expect.stringContaining(LOOP_BREAKER_ESCALATION_MARKER),
    );
  });

  it("does not stack a third breaker after escalation", () => {
    const requestBodyWithEscalation: NimChatRequest = {
      model: "test",
      messages: [
        {
          role: "user",
          content: `${LOOP_BREAKER_MARKER} ${LOOP_BREAKER_ESCALATION_MARKER} already`,
        },
      ],
    };
    const history = Array.from({ length: 4 }, () => ({
      role: 2,
      content: [{ value: "Let me fix the formatting issue:" }],
    }));

    const result = injectHistoryLoopBreaker({
      requestBody: requestBodyWithEscalation,
      historyMessages: history,
      modelId: "test-model",
      applyBudget: (body) => body,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe(
      `${LOOP_BREAKER_MARKER} ${LOOP_BREAKER_ESCALATION_MARKER} already`,
    );
  });
});
