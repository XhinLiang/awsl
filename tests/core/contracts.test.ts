import { describe, expect, test } from "vitest";

import {
  AwslError,
  COMPAT_PROFILE,
  WORKFLOW_ABI,
  createEvent,
} from "../../src/index.js";

describe("public contracts", () => {
  test("adds the stable Workflow ABI without changing the legacy public profile", () => {
    expect(COMPAT_PROFILE).toMatchObject({
      id: "claude-code@2.1.218",
      agentCap: 1000,
      structuredOutputAttempts: 5,
      providerProcess: {
        maxNdjsonLineBytes: 8 * 1024 * 1024,
        stderrTailBytes: 64 * 1024,
        killGraceMs: 1_000,
      },
    });
    expect(WORKFLOW_ABI).toMatchObject({
      id: "awsl-workflow@1",
      agentCap: COMPAT_PROFILE.agentCap,
      structuredOutputAttempts: COMPAT_PROFILE.structuredOutputAttempts,
    });
  });

  test("creates stable versioned events", () => {
    const event = createEvent("run.started", "wf_test", { attempt: 1 });

    expect(event).toMatchObject({
      version: 1,
      type: "run.started",
      runId: "wf_test",
      data: { attempt: 1 },
    });
    expect(event.timestamp).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  });

  test("serializes stable errors without leaking stack by default", () => {
    const error = new AwslError("CONFIG_ERROR", "bad config", {
      recoverable: false,
    });

    expect(error.toJSON()).toEqual({
      name: "AwslError",
      code: "CONFIG_ERROR",
      message: "bad config",
      recoverable: false,
    });
  });
});
