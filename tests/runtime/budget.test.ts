import { describe, expect, test } from "vitest";

import { RunBudget } from "../../src/runtime/budget.js";

describe("RunBudget", () => {
  test("charges only output tokens while tracking all usage classes", () => {
    const budget = new RunBudget(10);

    expect(
      budget.addUsage({
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningTokens: 2,
        complete: true,
      }),
    ).toEqual({ total: 10, spent: 4 });
    expect(budget.metrics()).toEqual({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 4,
      reasoningTokens: 2,
    });
  });

  test("allows an active completion to overshoot and gates only later work", () => {
    const budget = new RunBudget(3);

    budget.gate();
    budget.addUsage({ outputTokens: 5, complete: true });

    expect(budget.snapshot()).toEqual({ total: 3, spent: 5 });
    expect(() => budget.gate()).toThrow(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
  });

  test("rejects a zero budget before any work and supports an unlimited budget", () => {
    expect(() => new RunBudget(0).gate()).toThrow(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );

    const unlimited = new RunBudget(null);
    unlimited.gate();
    unlimited.addUsage({ outputTokens: 1_000, complete: true });
    expect(unlimited.snapshot()).toEqual({ total: null, spent: 1_000 });
  });

  test("rejects invalid totals, prior spend, and usage counters", () => {
    for (const total of [-1, 1.5, Number.NaN] as const)
      expect(() => new RunBudget(total)).toThrow(
        expect.objectContaining({ code: "CONFIG_ERROR" }),
      );
    expect(() => new RunBudget(1, 2)).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );

    const budget = new RunBudget(null);
    for (const outputTokens of [-1, 1.5, Number.POSITIVE_INFINITY])
      expect(() => budget.addUsage({ outputTokens, complete: true })).toThrow(
        expect.objectContaining({ code: "PROVIDER_ERROR" }),
      );
  });
});
