import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileRunStore,
  boundedStreamLine,
  projectedJournalBytes,
} from "../../src/store/run-store.js";

const baseAttempt = {
  version: 1 as const,
  kind: "attempt" as const,
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSeq: 0,
  sourceSha256: "a".repeat(64),
  sourcePath: "/project/a.js",
};
const baseCall = {
  version: 1 as const,
  kind: "call" as const,
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSeq: 0,
  callSeq: 0,
  callId: "call-1",
  key: `v2:${"a".repeat(64)}` as const,
  previousKey: "",
  state: "scheduled" as const,
};

type TestRunLock = Awaited<ReturnType<FileRunStore["acquireRunLock"]>>;
const testRunLocks = new Set<TestRunLock>();

function tracked(lock: TestRunLock): TestRunLock {
  testRunLocks.add(lock);
  return lock;
}

afterEach(async () => {
  const locks = [...testRunLocks];
  testRunLocks.clear();
  await Promise.all(
    locks.map(async (lock) => {
      try {
        await lock.release();
      } catch {
        // Some tests intentionally remove or replace the lock path. release()
        // still closes the held file descriptor in its finally block.
      }
    }),
  );
});

async function opened(rawCapture = false) {
  const store = await FileRunStore.open({
    root: await mkdtemp(join(tmpdir(), "awsl-store-")),
    runId: "run-1",
    rawCapture,
  });
  tracked(
    await store.acquireRunLock({
      nonce: "test-lock",
      pid: 1,
      processStartIdentity: "test",
    }),
  );
  return store;
}

async function boundAttempt(store: FileRunStore, attempt = baseAttempt) {
  const snapshot = await store.writeSourceSnapshot({
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    attemptSeq: attempt.attemptSeq,
    sourcePath: attempt.sourcePath,
    source: `source-${attempt.attemptId}-${attempt.attemptSeq}`,
  });
  return { ...attempt, sourceSha256: snapshot.sha256 };
}

describe("FileRunStore", () => {
  test("loads valid events and ignores only an incomplete final fragment", async () => {
    const store = await opened();
    const first = {
      version: 1 as const,
      type: "run.started",
      runId: "run-1",
      data: { attemptSeq: 0 },
      timestamp: "2026-08-18T00:00:00.000Z",
    };
    const second = {
      version: 1 as const,
      type: "run.completed",
      runId: "run-1",
      data: { status: "completed" },
      timestamp: "2026-08-18T00:00:01.000Z",
    };
    await store.appendEvent(first);
    await store.appendEvent(second);
    await expect(store.loadEvents()).resolves.toEqual([first, second]);

    const valid = await readFile(store.paths.events);
    await writeFile(
      store.paths.events,
      Buffer.concat([valid, Buffer.from('{"version":1')]),
      { mode: 0o600 },
    );
    await expect(store.loadEvents()).resolves.toEqual([first, second]);

    await writeFile(
      store.paths.events,
      Buffer.concat([valid, Buffer.from("{}\n")]),
      { mode: 0o600 },
    );
    await expect(store.loadEvents()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "invalid run event",
    });
  });

  test("bounds stream lines before adding their delimiter", () => {
    expect(boundedStreamLine("12345678", 8)).toEqual(Buffer.from("12345678\n"));
    expect(() => boundedStreamLine("123456789", 8)).toThrow(
      /state stream line exceeds the byte limit/,
    );
  });

  test("accounts for journal tail repair before enforcing the append limit", () => {
    expect(
      projectedJournalBytes(
        {
          statSize: 90,
          validEndOffset: 90,
          tailKind: "clean",
          appendBytes: 10,
        },
        100,
      ),
    ).toBe(100);
    expect(() =>
      projectedJournalBytes(
        {
          statSize: 90,
          validEndOffset: 90,
          tailKind: "clean",
          appendBytes: 11,
        },
        100,
      ),
    ).toThrow(/state file exceeds the byte limit/);
    expect(
      projectedJournalBytes(
        {
          statSize: 89,
          validEndOffset: 89,
          tailKind: "valid-final-without-lf",
          appendBytes: 10,
        },
        100,
      ),
    ).toBe(100);
    expect(
      projectedJournalBytes(
        {
          statSize: 99,
          validEndOffset: 80,
          tailKind: "invalid-final-fragment",
          appendBytes: 20,
        },
        100,
      ),
    ).toBe(100);
  });

  test("separates exclusive creation from read-only existing-run open", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-store-"));
    const created = await FileRunStore.create({ root, runId: "run-1" });
    await expect(
      FileRunStore.create({ root, runId: "run-1" }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "run state already exists",
    });
    await expect(
      FileRunStore.openExisting({ root, runId: "missing" }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "run state does not exist",
    });
    await expect(access(join(root, "missing"))).rejects.toBeTruthy();
    await expect(
      FileRunStore.openExisting({ root, runId: "run-1" }),
    ).resolves.toMatchObject({ paths: created.paths });
  });

  test("strictly and boundedly reads run, result, and lock snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-store-"));
    const store = await FileRunStore.create({ root, runId: "run-1" });
    const lock = tracked(
      await store.acquireRunLock({
        nonce: "nonce-1",
        pid: 123,
        processStartIdentity: "start-1",
      }),
    );
    await store.writeRun({ version: 1, runId: "run-1", status: "running" });
    await store.writeResult({
      version: 1,
      runId: "run-1",
      status: "completed",
      result: { ok: true },
    });

    await expect(store.readRun()).resolves.toEqual({
      version: 1,
      runId: "run-1",
      status: "running",
    });
    await expect(store.readResult()).resolves.toMatchObject({
      result: { ok: true },
    });
    await expect(store.readLockOwner()).resolves.toMatchObject({
      version: 1,
      nonce: "nonce-1",
      pid: 123,
      processStartIdentity: "start-1",
      acquiredAt: expect.any(String),
      fileIdentity: {
        dev: expect.any(Number),
        ino: expect.any(Number),
      },
    });

    await writeFile(store.paths.run, '{"version":1,"version":2}', {
      mode: 0o600,
    });
    await expect(store.readRun()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "invalid run snapshot",
    });
    await writeFile(store.paths.run, Buffer.alloc(4 * 1024 * 1024 + 1), {
      mode: 0o600,
    });
    await expect(store.readRun()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "state file exceeds the byte limit",
    });
    await lock.release();
  });

  test("rejects run and result snapshots that could not be read back", async () => {
    const store = await opened();

    await expect(
      store.writeRun({
        version: 1,
        runId: "run-1",
        status: "running",
        detail: "x".repeat(4 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "state file exceeds the byte limit",
    });
    await expect(
      store.writeResult({
        version: 1,
        runId: "run-1",
        status: "completed",
        result: "x".repeat(4 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "state file exceeds the byte limit",
    });
    await expect(access(store.paths.run)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(store.paths.result)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("only removes the same verified stale lock identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-store-"));
    const store = await FileRunStore.create({ root, runId: "run-1" });
    tracked(
      await store.acquireRunLock({
        nonce: "nonce-1",
        pid: 123,
        processStartIdentity: "start-1",
      }),
    );
    const owner = await store.readLockOwner();
    const repair = await FileRunStore.openExisting({
      root,
      runId: "run-1",
    });

    await expect(
      repair.removeLockIfMatches({
        ...owner,
        nonce: "other",
      }),
    ).resolves.toBe(false);
    await expect(access(store.paths.lock)).resolves.toBeUndefined();
    await expect(repair.removeLockIfMatches(owner)).resolves.toBe(true);
    await expect(access(store.paths.lock)).rejects.toBeTruthy();
  });

  test("rejects malformed captured lock identities before touching the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-store-"));
    const store = await FileRunStore.create({ root, runId: "run-1" });
    tracked(
      await store.acquireRunLock({
        nonce: "nonce-1",
        pid: 123,
        processStartIdentity: "start-1",
      }),
    );
    const owner = await store.readLockOwner();
    const repair = await FileRunStore.openExisting({
      root,
      runId: "run-1",
    });

    await expect(
      repair.removeLockIfMatches({
        ...owner,
        acquiredAt: "not-a-date",
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "invalid verified run lock identity",
    });
    await expect(
      repair.removeLockIfMatches({
        ...owner,
        fileIdentity: { ...owner.fileIdentity, ino: -1 },
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "invalid verified run lock identity",
    });
    await expect(access(store.paths.lock)).resolves.toBeUndefined();
  });

  test("rejects every persistence write before this instance holds a lock", async () => {
    const store = await FileRunStore.open({
      root: await mkdtemp(join(tmpdir(), "awsl-store-")),
      runId: "run-1",
    });
    await expect(store.beginAttempt(baseAttempt)).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    await expect(readFile(store.paths.journal)).rejects.toBeTruthy();
  });

  test("allocates append sequence and only resolves after durable journal sync", async () => {
    const store = await opened();
    const attempt = await boundAttempt(store);
    await expect(store.beginAttempt(attempt)).resolves.toMatchObject({
      durable: true,
      record: { recordSeq: 0 },
    });
    await expect(store.appendCall(baseCall)).resolves.toMatchObject({
      durable: true,
      record: { recordSeq: 1, recordedAt: expect.any(String) },
    });
  });

  test("repairs a truncated final tail and no-LF final record before append", async () => {
    const store = await opened();
    await store.beginAttempt(await boundAttempt(store));
    const path = store.paths.journal;
    await writeFile(path, `${await readFile(path, "utf8")}{"bad`);
    await store.appendCall(baseCall);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("writes source snapshot and manifest before returning", async () => {
    const store = await opened();
    const snapshot = await store.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-source",
      attemptSeq: 99,
      sourcePath: "/project/flow.js",
      source: "export default 1",
    });
    expect(await readFile(snapshot.path, "utf8")).toBe("export default 1");
    await expect(readFile(snapshot.manifestPath, "utf8")).resolves.toContain(
      snapshot.sha256,
    );
  });

  test("binds one durable source manifest to exactly one matching attempt", async () => {
    const store = await opened();
    const snapshot = await store.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-1",
      attemptSeq: 0,
      sourcePath: "/project/flow.js",
      source: "export default 1",
    });
    await expect(
      store.beginAttempt({ ...baseAttempt, sourcePath: "/project/other.js" }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    const second = await opened();
    const secondSnapshot = await second.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-1",
      attemptSeq: 0,
      sourcePath: "/project/flow.js",
      source: "export default 1",
    });
    await expect(
      second.beginAttempt({
        ...baseAttempt,
        sourceSha256: secondSnapshot.sha256,
        sourcePath: secondSnapshot.sourcePath,
      }),
    ).resolves.toMatchObject({ durable: true });
    await expect(second.beginAttempt({ ...baseAttempt })).rejects.toMatchObject(
      { code: "PERSISTENCE_ERROR" },
    );
    expect(await readFile(snapshot.manifestPath, "utf8")).toContain(
      '"attemptId":"attempt-1"',
    );
  });

  test("reopens and rejects a tampered immutable source snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-store-"));
    const first = await FileRunStore.open({ root, runId: "run-1" });
    tracked(
      await first.acquireRunLock({
        nonce: "nonce-a",
        pid: 1,
        processStartIdentity: "a",
      }),
    );
    const snapshot = await first.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-1",
      attemptSeq: 0,
      sourcePath: "/project/a.js",
      source: "original",
    });
    await writeFile(snapshot.path, "tampered", { mode: 0o600 });
    await expect(
      first.beginAttempt({ ...baseAttempt, sourceSha256: snapshot.sha256 }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("returns one release promise and rejects new writes once release starts", async () => {
    const store = await FileRunStore.open({
      root: await mkdtemp(join(tmpdir(), "awsl-store-")),
      runId: "run-1",
    });
    const lock = tracked(
      await store.acquireRunLock({
        nonce: "nonce-1",
        pid: 1,
        processStartIdentity: "start",
      }),
    );
    const first = lock.release();
    expect(lock.release()).toBe(first);
    await expect(store.beginAttempt(baseAttempt)).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    await first;
  });

  test("does not expose raw sink or providers directory when capture is disabled", async () => {
    const store = await opened();
    expect(store.rawEventSink("codex")).toBeUndefined();
    await expect(
      readFile(join(store.paths.runDir, "providers", "codex.jsonl")),
    ).rejects.toBeTruthy();
  });

  test("holds an exclusive owner lock and never takes it over", async () => {
    const store = await FileRunStore.open({
      root: await mkdtemp(join(tmpdir(), "awsl-store-")),
      runId: "run-1",
    });
    const lock = tracked(
      await store.acquireRunLock({
        nonce: "nonce-1",
        pid: 1,
        processStartIdentity: "start",
      }),
    );
    await expect(
      store.acquireRunLock({
        nonce: "nonce-2",
        pid: 2,
        processStartIdentity: "other",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await lock.release();
  });
});
