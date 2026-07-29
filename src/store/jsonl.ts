import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { AwslError } from "../core/errors.js";
import { canonicalJson } from "./canonical-json.js";
import type {
  JournalAttemptRecordV1,
  JournalCallRecordV1,
  JournalRecordV1,
} from "./types.js";

export type JournalTailKind =
  | "clean"
  | "valid-final-without-lf"
  | "invalid-final-fragment";
export interface JournalReadResult {
  records: readonly JournalRecordV1[];
  validEndOffset: number;
  tailKind: JournalTailKind;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const keyPattern = /^v2:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const persistence = (message: string, cause?: unknown) =>
  new AwslError("PERSISTENCE_ERROR", message, { recoverable: false, cause });
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safe = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && idPattern.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw persistence("unknown journal field");
}

function validateUsage(value: unknown): void {
  if (!isObject(value) || typeof value.complete !== "boolean")
    throw persistence("invalid provider usage");
  exactKeys(value, [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "complete",
  ]);
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
  ]) {
    if (
      value[field] !== undefined &&
      (!safe(value[field]) || (value[field] as number) < 0)
    )
      throw persistence("invalid provider usage");
  }
}
function validateCallPayload(value: unknown): void {
  if (
    !isObject(value) ||
    typeof value.outcome !== "string" ||
    typeof value.origin !== "string"
  )
    throw persistence("invalid completed payload");
  exactKeys(value, ["outcome", "origin", "result", "value", "usage"]);
  validateUsage(value.usage);
  if (value.outcome === "result") {
    const result = value.result;
    if (
      (value.origin !== "live" && value.origin !== "reused") ||
      !isObject(result) ||
      Object.keys(result).some(
        (key) => !["text", "data", "model", "effort"].includes(key),
      ) ||
      typeof result.text !== "string" ||
      (result.model !== undefined && typeof result.model !== "string") ||
      (result.effort !== undefined &&
        !["low", "medium", "high", "xhigh", "max"].includes(
          String(result.effort),
        )) ||
      value.value === undefined
    )
      throw persistence("invalid completed result payload");
    try {
      if (result.data !== undefined) canonicalJson(result.data);
      canonicalJson(value.value);
    } catch (error) {
      throw persistence("invalid completed result payload", error);
    }
  } else if (
    (value.outcome !== "compatibility-null" && value.outcome !== "user-skip") ||
    value.origin !== "live" ||
    value.result !== null ||
    value.value !== null
  )
    throw persistence("invalid completed null payload");
}

function parseRecord(value: unknown, expectedRunId: string): JournalRecordV1 {
  try {
    canonicalJson(value);
  } catch (error) {
    throw persistence("invalid journal record value", error);
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    (value.kind !== "attempt" && value.kind !== "call")
  )
    throw persistence("unknown journal record");
  if (
    value.runId !== expectedRunId ||
    !identifier(value.runId) ||
    !safe(value.recordSeq) ||
    !timestamp(value.recordedAt)
  )
    throw persistence("invalid journal record identity");
  if (value.kind === "attempt") {
    exactKeys(value, [
      "version",
      "kind",
      "runId",
      "attemptId",
      "attemptSeq",
      "recordSeq",
      "sourceSha256",
      "sourcePath",
      "recordedAt",
    ]);
    if (
      !identifier(value.attemptId) ||
      !safe(value.attemptSeq) ||
      typeof value.sourcePath !== "string" ||
      !value.sourcePath ||
      typeof value.sourceSha256 !== "string" ||
      !shaPattern.test(value.sourceSha256)
    )
      throw persistence("invalid attempt record");
    return value as unknown as JournalAttemptRecordV1;
  }
  if (
    !identifier(value.attemptId) ||
    !safe(value.attemptSeq) ||
    !safe(value.callSeq) ||
    !identifier(value.callId) ||
    typeof value.key !== "string" ||
    !keyPattern.test(value.key) ||
    typeof value.previousKey !== "string" ||
    (value.previousKey !== "" && !keyPattern.test(value.previousKey)) ||
    !["scheduled", "started", "completed", "failed", "indeterminate"].includes(
      String(value.state),
    )
  )
    throw persistence("invalid call record");
  exactKeys(value, [
    "version",
    "kind",
    "runId",
    "attemptId",
    "attemptSeq",
    "recordSeq",
    "callSeq",
    "callId",
    "key",
    "previousKey",
    "state",
    "completed",
    "usage",
    "recordedAt",
  ]);
  if (value.state === "completed") {
    if (!("completed" in value)) throw persistence("missing completed payload");
    validateCallPayload(value.completed);
  } else if ("completed" in value)
    throw persistence("non-completed record has completed payload");
  if (value.usage !== undefined) validateUsage(value.usage);
  return value as unknown as JournalCallRecordV1;
}

/** Strictly validates one runtime journal value before it reaches durable bytes. */
export function validateJournalRecord(
  value: unknown,
  expectedRunId: string,
): JournalRecordV1 {
  return parseRecord(value, expectedRunId);
}

export function validateJournalRecords(
  records: readonly JournalRecordV1[],
): void {
  let attemptSeq = 0;
  let current: JournalAttemptRecordV1 | undefined;
  const attemptIds = new Set<string>();
  let nextCallSeq = 0;
  let chainKey = "";
  const calls = new Map<
    string,
    { record: JournalCallRecordV1; terminal: boolean }
  >();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.recordSeq !== index)
      throw persistence("non-contiguous journal record sequence");
    if (record.kind === "attempt") {
      if (record.attemptSeq !== attemptSeq)
        throw persistence("non-contiguous attempt sequence");
      if (attemptIds.has(record.attemptId))
        throw persistence("attempt identifier reappeared");
      attemptIds.add(record.attemptId);
      attemptSeq += 1;
      current = record;
      calls.clear();
      nextCallSeq = 0;
      chainKey = "";
      continue;
    }
    if (
      current === undefined ||
      record.attemptSeq !== current.attemptSeq ||
      record.attemptId !== current.attemptId
    )
      throw persistence("call outside its attempt segment");
    const existing = calls.get(record.callId);
    if (!existing) {
      if (record.state !== "scheduled")
        throw persistence("call must start scheduled");
      if (record.callSeq !== nextCallSeq || record.previousKey !== chainKey)
        throw persistence("broken logical call sequence");
      nextCallSeq += 1;
      chainKey = record.key;
      calls.set(record.callId, { record, terminal: false });
      continue;
    }
    if (
      existing.terminal ||
      existing.record.callSeq !== record.callSeq ||
      existing.record.key !== record.key ||
      existing.record.previousKey !== record.previousKey
    )
      throw persistence("invalid call transition or identity");
    const prior = existing.record.state;
    const valid =
      (prior === "scheduled" &&
        (record.state === "started" ||
          (record.state === "completed" &&
            record.completed?.outcome === "result" &&
            record.completed.origin === "reused") ||
          record.state === "failed")) ||
      (prior === "started" &&
        ((record.state === "completed" &&
          record.completed?.origin === "live") ||
          record.state === "failed" ||
          record.state === "indeterminate"));
    if (!valid) throw persistence("invalid call transition");
    existing.record = record;
    existing.terminal =
      record.state === "completed" ||
      record.state === "failed" ||
      record.state === "indeterminate";
  }
}

export async function readJournalJsonl(
  path: string,
  runId: string,
): Promise<JournalReadResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw persistence("could not read journal", error);
  }
  return readJournalJsonlBytes(bytes, runId);
}

export function readJournalJsonlBytes(
  bytes: Buffer,
  runId: string,
): JournalReadResult {
  const records: JournalRecordV1[] = [];
  let offset = 0;
  let validEndOffset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const final = newline === -1;
    const end = final ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    const next = final ? bytes.length : newline + 1;
    if (line.length === 0) {
      if (final) break;
      throw persistence("empty journal record");
    }
    let text: string;
    try {
      text = utf8.decode(line);
    } catch (error) {
      if (final) {
        validateJournalRecords(records);
        return { records, validEndOffset, tailKind: "invalid-final-fragment" };
      }
      throw persistence("invalid UTF-8 journal record", error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (final) {
        validateJournalRecords(records);
        return { records, validEndOffset, tailKind: "invalid-final-fragment" };
      }
      throw persistence("malformed journal record", error);
    }
    records.push(parseRecord(parsed, runId));
    validEndOffset = next;
    offset = next;
    if (final) {
      validateJournalRecords(records);
      return { records, validEndOffset, tailKind: "valid-final-without-lf" };
    }
  }
  validateJournalRecords(records);
  return { records, validEndOffset: bytes.length, tailKind: "clean" };
}
