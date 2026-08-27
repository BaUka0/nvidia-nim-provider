import { FetchAttemptBudget, httpAttemptsFromConfig } from "../src/shared/fetch-attempt-budget";

describe("FetchAttemptBudget", () => {
  it("never goes negative and returns 0 when exhausted", () => {
    const budget = new FetchAttemptBudget(2);
    expect(budget.consume(3)).toBe(2);
    expect(budget.remaining).toBe(1);
    expect(budget.consume(3)).toBe(1);
    expect(budget.remaining).toBe(0);
    expect(budget.consume(3)).toBe(0);
    expect(budget.remaining).toBe(0);
    expect(budget.exhausted).toBe(true);
  });

  it("shares remaining across simulated fallback hops", () => {
    const budget = new FetchAttemptBudget(6);
    const hopAttempts: number[] = [];
    for (let hop = 0; hop < 8; hop += 1) {
      const granted = budget.consume();
      if (granted <= 0) {
        break;
      }
      hopAttempts.push(granted);
    }
    expect(hopAttempts).toHaveLength(6);
    expect(budget.exhausted).toBe(true);
  });

  it("treats a configured retry count of 0 as a single attempt", () => {
    expect(httpAttemptsFromConfig(0)).toBe(1);
    expect(httpAttemptsFromConfig(3)).toBe(3);
  });
});
