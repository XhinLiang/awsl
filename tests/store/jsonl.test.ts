import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  readJournalJsonl,
  readJournalJsonlBytes,
} from "../../src/store/jsonl.js";
import type {
  JournalAttemptRecordV1,
  JournalCallRecordV1,
} from "../../src/store/types.js";

const key = (digit: string) => `v2:${digit.repeat(64)}` as const;
const attempt = (
  overrides: Partial<JournalAttemptRecordV1> = {},
): JournalAttemptRecordV1 => ({
  version: 1,
  kind: "attempt",
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSeq: 0,
  recordSeq: 0,
  sourceSha256: "a".repeat(64),
  sourcePath: "scripts/a.js",
  recordedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
const call = (
  overrides: Partial<JournalCallRecordV1> = {},
): JournalCallRecordV1 => ({
  version: 1,
  kind: "call",
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSeq: 0,
  recordSeq: 1,
  callSeq: 0,
  callId: "call-1",
  key: key("a"),
  previousKey: "",
  state: "scheduled",
  recordedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

async function journal(bytes: Buffer | string): Promise<string> {
  const path = join(
    await mkdtemp(join(tmpdir(), "awsl-jsonl-")),
    "journal.jsonl",
  );
  await writeFile(path, bytes);
  return path;
}

describe("readJournalJsonl", () => {
  test("rejects schema-invalid completed AgentResult payloads during load", () => {
    const scheduled = call();
    const started = call({ recordSeq: 2, state: "started" });
    const completed = call({
      recordSeq: 3,
      state: "completed",
      completed: {
        outcome: "result",
        origin: "live",
        result: { text: "ok", extra: true } as never,
        value: "ok",
        usage: { complete: true, outputTokens: 1 },
      },
    });
    expect(() =>
      readJournalJsonlBytes(
        Buffer.from(
          `${JSON.stringify(attempt())}\n${JSON.stringify(scheduled)}\n${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`,
        ),
        "run-1",
      ),
    ).toThrowError(/invalid completed result payload/);
  });
  test("loads a complete final record without LF", async () => {
    const path = await journal(JSON.stringify(attempt()));
    await expect(readJournalJsonl(path, "run-1")).resolves.toMatchObject({
      records: [attempt()],
      tailKind: "valid-final-without-lf",
      validEndOffset: Buffer.byteLength(JSON.stringify(attempt())),
    });
  });

  test("ignores only an incomplete final JSON fragment", async () => {
    const first = `${JSON.stringify(attempt())}\n`;
    const path = await journal(`${first}{"version":`);
    await expect(readJournalJsonl(path, "run-1")).resolves.toMatchObject({
      records: [attempt()],
      tailKind: "invalid-final-fragment",
      validEndOffset: Buffer.byteLength(first),
    });
  });

  test("rejects invalid UTF-8 before LF and a syntactically invalid completed line", async () => {
    await expect(
      readJournalJsonl(await journal(Buffer.from([0xff, 0x0a])), "run-1"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      readJournalJsonl(
        await journal(`${JSON.stringify(attempt())}\n{bad}\n`),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("rejects empty, unknown and noncontiguous records", async () => {
    await expect(
      readJournalJsonl(
        await journal(`${JSON.stringify(attempt())}\n\n`),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      readJournalJsonl(
        await journal(`${JSON.stringify({ ...attempt(), version: 2 })}\n`),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      readJournalJsonl(
        await journal(`${JSON.stringify(attempt({ recordSeq: 2 }))}\n`),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("rejects broken call transitions, identity and keys", async () => {
    const rows = [attempt(), call({ state: "started" })];
    await expect(
      readJournalJsonl(
        await journal(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      readJournalJsonl(
        await journal(
          `${JSON.stringify(attempt())}\n${JSON.stringify(call({ runId: "other" }))}\n`,
        ),
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });
});
