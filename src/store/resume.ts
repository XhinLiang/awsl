import { canonicalJson } from "./canonical-json.js";
import { validateJournalRecords } from "./jsonl.js";
import type {
  CompletedPayload,
  JournalCallRecordV1,
  JournalRecordV1,
} from "./types.js";

export interface ReusedCompletion {
  result: (CompletedPayload & { outcome: "result" })["result"];
  value: unknown;
  usage: (CompletedPayload & { outcome: "result" })["usage"];
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function reusable(
  record: JournalCallRecordV1,
): record is JournalCallRecordV1 & {
  completed: CompletedPayload & { outcome: "result" };
} {
  const payload = record.completed;
  if (
    record.state !== "completed" ||
    payload?.outcome !== "result" ||
    payload.value === null ||
    payload.usage.complete !== true ||
    !Number.isSafeInteger(payload.usage.outputTokens) ||
    (payload.usage.outputTokens ?? -1) < 0 ||
    typeof payload.result.text !== "string"
  )
    return false;
  try {
    clone(payload.result);
    clone(payload.value);
  } catch {
    return false;
  }
  return true;
}

/** Longest-prefix replay cursor for the completed attempt directly before this one. */
export class ResumeCursor {
  #calls: readonly JournalCallRecordV1[];
  #disabled = false;
  #nextCallSeq = 0;
  private constructor(calls: readonly JournalCallRecordV1[]) {
    this.#calls = calls;
  }

  static fromJournal(records: readonly JournalRecordV1[]): ResumeCursor {
    validateJournalRecords(records);
    const attempts = records.filter(
      (record): record is Extract<JournalRecordV1, { kind: "attempt" }> =>
        record.kind === "attempt",
    );
    const current = attempts.at(-1);
    if (current === undefined || current.attemptSeq === 0)
      return new ResumeCursor([]);
    const prior = attempts.find(
      (record) => record.attemptSeq === current.attemptSeq - 1,
    );
    if (prior === undefined) return new ResumeCursor([]);
    const calls = records
      .filter(
        (record): record is JournalCallRecordV1 =>
          record.kind === "call" &&
          record.attemptSeq === prior.attemptSeq &&
          record.attemptId === prior.attemptId,
      )
      .sort((left, right) => left.callSeq - right.callSeq);
    const terminals = new Map<number, JournalCallRecordV1>();
    for (const call of calls)
      if (
        call.state === "completed" ||
        call.state === "failed" ||
        call.state === "indeterminate"
      )
        terminals.set(call.callSeq, clone(call));
    return new ResumeCursor(
      [...terminals.values()].sort(
        (left, right) => left.callSeq - right.callSeq,
      ),
    );
  }

  take(
    callSeq: number,
    key: string,
    previousKey: string,
  ): ReusedCompletion | undefined {
    if (this.#disabled) return undefined;
    if (callSeq !== this.#nextCallSeq) {
      this.#disabled = true;
      return undefined;
    }
    const record = this.#calls[callSeq];
    if (
      record === undefined ||
      record.callSeq !== callSeq ||
      record.key !== key ||
      record.previousKey !== previousKey ||
      !reusable(record)
    ) {
      this.#disabled = true;
      return undefined;
    }
    this.#nextCallSeq += 1;
    return {
      result: clone(record.completed.result),
      value: clone(record.completed.value),
      usage: clone(record.completed.usage),
    };
  }
}
