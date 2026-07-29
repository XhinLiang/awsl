import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type { ProviderUsage } from "../core/types.js";
import type { BudgetSnapshot } from "../worker/protocol.js";

export interface UsageMetrics {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function providerError(message: string): never {
  throw new AwslError("PROVIDER_ERROR", message, { recoverable: false });
}

export class RunBudget {
  readonly #total: number | null;
  #spent: number;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #reasoningTokens = 0;

  constructor(total: number | null, spent = 0) {
    if (
      (total !== null && !validCounter(total)) ||
      !validCounter(spent) ||
      (total !== null && spent > total)
    )
      configError("invalid run budget");
    this.#total = total;
    this.#spent = spent;
  }

  gate(): void {
    if (this.#total !== null && this.#spent >= this.#total)
      throw new AwslError(
        "BUDGET_EXCEEDED",
        "run output token budget exhausted",
        {
          recoverable: true,
        },
      );
  }

  addUsage(usage: ProviderUsage): BudgetSnapshot {
    let captured: unknown;
    try {
      captured = strictJsonClone(usage, "provider usage");
    } catch {
      providerError("provider usage is invalid");
    }
    if (
      captured === null ||
      typeof captured !== "object" ||
      Array.isArray(captured)
    )
      providerError("provider usage is invalid");
    const value = captured as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "inputTokens",
            "cachedInputTokens",
            "outputTokens",
            "reasoningTokens",
            "complete",
          ].includes(key),
      )
    )
      providerError("provider usage is invalid");
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
    ] as const) {
      const counter = value[field];
      if (counter !== undefined && !validCounter(counter))
        providerError("provider usage is invalid");
    }
    if (typeof value.complete !== "boolean")
      providerError("provider usage is invalid");

    const inputTokens = this.#inputTokens + Number(value.inputTokens ?? 0);
    const cachedInputTokens =
      this.#cachedInputTokens + Number(value.cachedInputTokens ?? 0);
    const spent = this.#spent + Number(value.outputTokens ?? 0);
    const reasoningTokens =
      this.#reasoningTokens + Number(value.reasoningTokens ?? 0);
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(cachedInputTokens) ||
      !Number.isSafeInteger(spent) ||
      !Number.isSafeInteger(reasoningTokens)
    )
      providerError("provider usage totals exceed the safe integer range");
    this.#inputTokens = inputTokens;
    this.#cachedInputTokens = cachedInputTokens;
    this.#spent = spent;
    this.#reasoningTokens = reasoningTokens;
    return this.snapshot();
  }

  snapshot(): BudgetSnapshot {
    return Object.freeze({ total: this.#total, spent: this.#spent });
  }

  metrics(): UsageMetrics {
    return Object.freeze({
      inputTokens: this.#inputTokens,
      cachedInputTokens: this.#cachedInputTokens,
      outputTokens: this.#spent,
      reasoningTokens: this.#reasoningTokens,
    });
  }
}
