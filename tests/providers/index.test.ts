import { describe, expect, test } from "vitest";

import { AwslError } from "../../src/core/errors.js";
import type { ProviderOutcome } from "../../src/core/types.js";
import { classifyEngineOutcome } from "../../src/providers/index.js";

describe("engine provider outcome classification", () => {
  test("maps only the engine synthetic user skip to compatibility null", () => {
    expect(classifyEngineOutcome({ kind: "user-skip" })).toEqual({
      kind: "compatibility-null",
      reason: "user-skip",
      usage: {
        complete: true,
        outputTokens: 0,
      },
    });
  });

  test("preserves provider outcomes without inventing compatibility results", () => {
    const error: ProviderOutcome = {
      error: new AwslError("PROVIDER_ERROR", "failed", {
        provider: "codex",
        recoverable: false,
      }),
      kind: "error",
      usage: { complete: false },
    };

    expect(classifyEngineOutcome(error)).toBe(error);
  });

  test("rejects unknown synthetic outcomes", () => {
    expect(() => classifyEngineOutcome({ kind: "future" } as never)).toThrow(
      /unknown engine outcome/,
    );
  });
});
