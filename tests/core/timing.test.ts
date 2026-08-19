import { describe, expect, test } from "vitest";

import type { AwslEvent } from "../../src/core/events.js";
import { summarizeRunTiming } from "../../src/core/timing.js";

const RUN_ID = "wf-timing";
const at = (milliseconds: number) =>
  new Date(Date.UTC(2026, 7, 18, 0, 0, 0, milliseconds)).toISOString();
const event = (
  type: string,
  milliseconds: number,
  data: Record<string, unknown>,
): AwslEvent => ({
  version: 1,
  type,
  timestamp: at(milliseconds),
  runId: RUN_ID,
  data,
});

describe("run timing summaries", () => {
  test("reports wall time, parallel phase activity, and call bottlenecks", () => {
    const timing = summarizeRunTiming([
      event("run.started", 0, {
        attemptId: "attempt-0",
        attemptSeq: 0,
        resumed: false,
      }),
      event("call.scheduled", 1_000, {
        callId: "call-0",
        callSeq: 0,
        label: "setup",
        phase: "setup",
      }),
      event("call.started", 2_000, { callId: "call-0", callSeq: 0 }),
      event("call.completed", 5_000, {
        callId: "call-0",
        callSeq: 0,
        outcome: "result",
      }),
      event("call.scheduled", 6_000, {
        callId: "call-1",
        callSeq: 1,
        label: "fast",
        phase: "summarize",
      }),
      event("call.scheduled", 6_000, {
        callId: "call-2",
        callSeq: 2,
        label: "slow",
        phase: "summarize",
      }),
      event("call.started", 7_000, { callId: "call-1", callSeq: 1 }),
      event("call.started", 7_000, { callId: "call-2", callSeq: 2 }),
      event("call.completed", 10_000, {
        callId: "call-1",
        callSeq: 1,
        outcome: "result",
      }),
      event("call.completed", 15_000, {
        callId: "call-2",
        callSeq: 2,
        outcome: "result",
      }),
      event("run.completed", 17_000, { status: "completed" }),
    ]);

    expect(timing).toMatchObject({
      version: 1,
      status: "completed",
      startedAt: at(0),
      endedAt: at(17_000),
      elapsedMs: 17_000,
      activeMs: 17_000,
      idleMs: 0,
      callActiveMs: 11_000,
      attempts: [
        {
          attemptId: "attempt-0",
          attemptSeq: 0,
          status: "completed",
          durationMs: 17_000,
        },
      ],
    });
    expect(timing?.phases).toEqual([
      {
        attemptSeq: 0,
        name: "setup",
        startedAt: at(1_000),
        endedAt: at(5_000),
        elapsedMs: 4_000,
        activeMs: 3_000,
        callMs: 3_000,
        callCount: 1,
        maxParallelism: 1,
        longestCall: {
          callId: "call-0",
          label: "setup",
          durationMs: 3_000,
        },
        lastCall: {
          callId: "call-0",
          label: "setup",
          endedAt: at(5_000),
        },
      },
      {
        attemptSeq: 0,
        name: "summarize",
        startedAt: at(6_000),
        endedAt: at(15_000),
        elapsedMs: 9_000,
        activeMs: 8_000,
        callMs: 11_000,
        callCount: 2,
        maxParallelism: 2,
        longestCall: {
          callId: "call-2",
          label: "slow",
          durationMs: 8_000,
        },
        lastCall: {
          callId: "call-2",
          label: "slow",
          endedAt: at(15_000),
        },
      },
    ]);
    expect(timing?.calls).toEqual([
      expect.objectContaining({
        attemptSeq: 0,
        callId: "call-0",
        status: "completed",
        queueMs: 1_000,
        durationMs: 3_000,
        elapsedMs: 4_000,
      }),
      expect.objectContaining({
        callId: "call-1",
        durationMs: 3_000,
      }),
      expect.objectContaining({
        callId: "call-2",
        durationMs: 8_000,
      }),
    ]);
  });

  test("separates active attempt time from idle time across resume", () => {
    const timing = summarizeRunTiming([
      event("run.started", 0, {
        attemptId: "attempt-0",
        attemptSeq: 0,
        resumed: false,
      }),
      event("call.scheduled", 1_000, {
        callId: "call-0",
        callSeq: 0,
        phase: "collect",
      }),
      event("call.started", 2_000, { callId: "call-0", callSeq: 0 }),
      event("call.failed", 4_000, { callId: "call-0", callSeq: 0 }),
      event("run.failed", 5_000, { status: "failed", code: "PROVIDER_ERROR" }),
      event("run.started", 15_000, {
        attemptId: "attempt-1",
        attemptSeq: 1,
        resumed: true,
      }),
      event("call.scheduled", 16_000, {
        callId: "call-0",
        callSeq: 0,
        phase: "collect",
      }),
      event("call.reused", 16_100, { callId: "call-0", callSeq: 0 }),
      event("call.scheduled", 17_000, {
        callId: "call-1",
        callSeq: 1,
        phase: "finalize",
      }),
      event("call.started", 17_500, { callId: "call-1", callSeq: 1 }),
      event("call.completed", 20_000, {
        callId: "call-1",
        callSeq: 1,
        outcome: "result",
      }),
      event("run.completed", 21_000, { status: "completed" }),
    ]);

    expect(timing).toMatchObject({
      status: "completed",
      elapsedMs: 21_000,
      activeMs: 11_000,
      idleMs: 10_000,
      callActiveMs: 4_500,
      attempts: [
        {
          attemptSeq: 0,
          status: "failed",
          durationMs: 5_000,
        },
        {
          attemptSeq: 1,
          status: "completed",
          durationMs: 6_000,
        },
      ],
    });
    expect(timing?.calls[1]).toMatchObject({
      attemptSeq: 1,
      callId: "call-0",
      status: "reused",
      elapsedMs: 100,
    });
    expect(timing?.calls[1]).not.toHaveProperty("durationMs");
  });

  test("returns null when no run lifecycle has started", () => {
    expect(summarizeRunTiming([])).toBeNull();
  });
});
