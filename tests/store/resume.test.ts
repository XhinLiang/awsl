import { describe, expect, test } from "vitest";

import { ResumeCursor } from "../../src/store/resume.js";
import type {
  JournalAttemptRecordV1,
  JournalCallRecordV1,
} from "../../src/store/types.js";

const key = (digit: string) => `v2:${digit.repeat(64)}` as const;
const attempt = (
  attemptSeq: number,
  id = `attempt-${attemptSeq}`,
): JournalAttemptRecordV1 => ({
  version: 1,
  kind: "attempt",
  runId: "run-1",
  attemptId: id,
  attemptSeq,
  recordSeq: attemptSeq,
  sourceSha256: "a".repeat(64),
  sourcePath: "scripts/a.js",
  recordedAt: "2026-01-01T00:00:00.000Z",
});
const completed = (
  attemptSeq: number,
  callSeq: number,
  overrides: Partial<JournalCallRecordV1> = {},
): JournalCallRecordV1 => ({
  version: 1,
  kind: "call",
  runId: "run-1",
  attemptId: `attempt-${attemptSeq}`,
  attemptSeq,
  recordSeq: 10 + callSeq,
  callSeq,
  callId: `call-${callSeq}`,
  key: key(callSeq ? "b" : "a"),
  previousKey: callSeq ? key("a") : "",
  state: "completed",
  completed: {
    outcome: "result",
    origin: "live",
    result: { text: `result-${callSeq}`, data: { nested: callSeq } },
    value: { nested: callSeq },
    usage: { complete: true, outputTokens: 1 },
  },
  recordedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});
function history(calls: readonly JournalCallRecordV1[], currentAttempt = 1) {
  let sequence = 0;
  const prior = { ...attempt(0), recordSeq: sequence++ };
  const records: (JournalAttemptRecordV1 | JournalCallRecordV1)[] = [prior];
  for (const terminal of calls) {
    const identity = { ...terminal, recordSeq: sequence++ };
    records.push({
      ...identity,
      state: "scheduled",
      completed: undefined,
      usage: undefined,
    });
    records.push({
      ...identity,
      recordSeq: sequence++,
      state: "started",
      completed: undefined,
      usage: undefined,
    });
    records.push({ ...identity, recordSeq: sequence++, state: "completed" });
  }
  records.push({ ...attempt(currentAttempt), recordSeq: sequence++ });
  return records;
}

describe("ResumeCursor", () => {
  test("replays sequentially and returns deep clones", () => {
    const cursor = ResumeCursor.fromJournal(history([completed(0, 0)]));
    const first = cursor.take(0, key("a"), "");
    expect(first).toMatchObject({
      result: { text: "result-0" },
      value: { nested: 0 },
    });
    (first?.value as { nested: number }).nested = 99;
    expect(cursor.take(0, key("a"), "")).toBeUndefined();
  });

  test("gives independent fresh cursors the same sequential replay", () => {
    const records = history([completed(0, 0), completed(0, 1)]);
    for (const cursor of [
      ResumeCursor.fromJournal(records),
      ResumeCursor.fromJournal(records),
    ]) {
      expect(cursor.take(0, key("a"), "")).toBeDefined();
      expect(cursor.take(1, key("b"), key("a"))).toBeDefined();
    }
  });

  test("uses an empty cursor after a zero-call immediate predecessor", () => {
    const cursor = ResumeCursor.fromJournal(
      history([], 1).concat({ ...attempt(2), recordSeq: 2 }),
    );
    expect(cursor.take(0, key("a"), "")).toBeUndefined();
  });

  test("a mismatch or incomplete usage permanently disables later reuse", () => {
    const cursor = ResumeCursor.fromJournal(
      history([completed(0, 0), completed(0, 1)]),
    );
    expect(cursor.take(0, key("b"), "")).toBeUndefined();
    expect(cursor.take(1, key("b"), key("a"))).toBeUndefined();
    const incomplete = ResumeCursor.fromJournal(
      history([
        completed(0, 0, {
          completed: {
            outcome: "result",
            origin: "live",
            result: { text: "x" },
            value: 1,
            usage: { complete: true },
          },
        }),
      ]),
    );
    expect(incomplete.take(0, key("a"), "")).toBeUndefined();
  });

  test("out-of-order take permanently disables replay", () => {
    const cursor = ResumeCursor.fromJournal(
      history([completed(0, 0), completed(0, 1)]),
    );
    expect(cursor.take(1, key("b"), key("a"))).toBeUndefined();
    expect(cursor.take(0, key("a"), "")).toBeUndefined();
  });
});
