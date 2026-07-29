import { constants } from "node:fs";

import { describe, expect, test } from "vitest";

import { FileRunStore } from "../../src/store/run-store.js";
import { MemoryAtomicFileOps } from "./support/memory-file-ops.js";

const attempt = {
  version: 1 as const,
  kind: "attempt" as const,
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSeq: 0,
  sourceSha256: "a".repeat(64),
  sourcePath: "/project/a.js",
};

async function locked() {
  const ops = new MemoryAtomicFileOps();
  const store = await FileRunStore.open({
    root: "/state",
    runId: "run-1",
    ops,
  });
  const lock = await store.acquireRunLock({
    nonce: "nonce-1",
    pid: 1,
    processStartIdentity: "start",
  });
  return { ops, store, lock };
}

describe("FileRunStore injected filesystem lifecycle", () => {
  test("drains an accepted append before release unlinks and rejects writes after release starts", async () => {
    const { ops, store, lock } = await locked();
    let openGate!: () => void;
    ops.syncGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const append = store.appendEvent({
      version: 1,
      type: "run.started",
      runId: "run-1",
      data: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await Promise.resolve();
    const releasing = lock.release();
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
    openGate();
    await append;
    await releasing;
    expect(ops.log.lastIndexOf("sync:/state/run-1/events.jsonl")).toBeLessThan(
      ops.log.lastIndexOf("unlink:/state/run-1/.lock"),
    );
  });
  test("syncs the parent directory after creating an append stream", async () => {
    const { ops, store } = await locked();
    await store.appendEvent({
      version: 1,
      type: "run.started",
      runId: "run-1",
      data: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const write = ops.log.findIndex((entry) =>
      entry.startsWith("write:/state/run-1/events.jsonl:"),
    );
    const sync = ops.log.findIndex(
      (entry) => entry === "sync:/state/run-1/events.jsonl",
    );
    const dirSync = ops.log.lastIndexOf("syncDir:/state/run-1");
    expect(write).toBeLessThan(sync);
    expect(sync).toBeLessThan(dirSync);
  });

  test("repairs each clean event stream once per store instance before later appends", async () => {
    const { ops, store } = await locked();
    for (const timestamp of [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    ])
      await store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp,
      });
    const repairOpen = `open:/state/run-1/events.jsonl:${constants.O_RDWR | constants.O_NOFOLLOW}:`;
    expect(
      ops.log.filter((entry) => entry.startsWith(repairOpen)),
    ).toHaveLength(1);
  });

  test("repairs an existing stream with bounded reads", async () => {
    const { ops, store } = await locked();
    const path = "/state/run-1/events.jsonl";
    ops.addFile(path, Buffer.from("{}\n".repeat(100_000)));

    await store.appendEvent({
      version: 1,
      type: "run.started",
      runId: "run-1",
      data: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const readLengths = ops.log
      .filter((entry) => entry.startsWith(`read:${path}:`))
      .map((entry) => Number(entry.split(":").at(-1)));
    expect(readLengths.length).toBeGreaterThan(1);
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(ops.entry(path).bytes.toString().trimEnd().split("\n")).toHaveLength(
      100_001,
    );
  });

  test("repairs partial and no-LF event/raw stream tails before appending independently parseable records", async () => {
    for (const [path, raw] of [
      ["/state/run-1/events.jsonl", false],
      ["/state/run-1/providers/codex.jsonl", true],
    ] as const) {
      for (const tail of ["{", JSON.stringify({ old: true })]) {
        const ops = new MemoryAtomicFileOps();
        const store = await FileRunStore.open({
          root: "/state",
          runId: "run-1",
          ops,
          rawCapture: raw,
        });
        await store.acquireRunLock({
          nonce: "nonce",
          pid: 1,
          processStartIdentity: "x",
        });
        ops.addFile(path, Buffer.from(tail));
        if (raw) await store.rawEventSink("codex")?.({ next: true });
        else
          await store.appendEvent({
            version: 1,
            type: "run.started",
            runId: "run-1",
            data: {},
            timestamp: "2026-01-01T00:00:00.000Z",
          });
        const lines = ops.entry(path).bytes.toString().trimEnd().split("\n");
        expect(lines.map((line) => JSON.parse(line))).toHaveLength(
          tail === "{" ? 1 : 2,
        );
      }
    }
  });

  test("never truncates a valid final stream record after LF repair I/O fails", async () => {
    const path = "/state/run-1/events.jsonl";
    const original = Buffer.from(JSON.stringify({ old: true }));
    for (const operation of ["write", "sync"]) {
      const { ops, store } = await locked();
      ops.addFile(path, original);
      ops.failOn(operation, 1, new Error(`${operation} failed`), path);

      await expect(
        store.appendEvent({
          version: 1,
          type: "run.started",
          runId: "run-1",
          data: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });

      expect(ops.entry(path).bytes.subarray(0, original.length)).toEqual(
        original,
      );
      expect(
        ops.log.filter((entry) => entry.startsWith(`ftruncate:${path}:`)),
      ).toEqual([]);
    }
  });

  test("refuses interior-corrupt event streams without appending", async () => {
    const { ops, store } = await locked();
    ops.addFile("/state/run-1/events.jsonl", Buffer.from("{bad}\n"));
    const before = Buffer.from(ops.entry("/state/run-1/events.jsonl").bytes);
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.entry("/state/run-1/events.jsonl").bytes).toEqual(before);
  });

  test("poisons the store after append sync failure and rejects the next append before I/O", async () => {
    const { ops, store } = await locked();
    ops.fail.sync = new Error("disk failure");
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    ops.fail.sync = undefined;
    const before = ops.log.length;
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(before);
  });

  test("releases a poisoned store after its accepted append drains, and never permits another write", async () => {
    const { ops, store, lock } = await locked();
    ops.failSyncPath = "/state/run-1/events.jsonl";
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    ops.failSyncPath = undefined;
    const before = ops.log.length;
    const release = lock.release();
    expect(lock.release()).toBe(release);
    await release;
    const suffix = ops.log.slice(before);
    const lstat = suffix.indexOf("lstat:/state/run-1/.lock");
    const stat = suffix.indexOf("stat:/state/run-1/.lock");
    const read = suffix.findIndex((entry) =>
      entry.startsWith("read:/state/run-1/.lock:"),
    );
    const unlink = suffix.indexOf("unlink:/state/run-1/.lock");
    const sync = suffix.indexOf("syncDir:/state/run-1");
    const close = suffix.indexOf("close:/state/run-1/.lock");
    expect(lstat).toBeLessThan(stat);
    expect(stat).toBeLessThan(read);
    expect(read).toBeLessThan(unlink);
    expect(unlink).toBeLessThan(sync);
    expect(sync).toBeLessThan(close);
    const after = ops.log.length;
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(after);
  });

  test("poisons the store after a zero-byte append write before another filesystem operation", async () => {
    const { ops, store } = await locked();
    ops.writeLimit = 0;
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    const before = ops.log.length;
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(before);
  });
  test("creates the lock with exact nofollow exclusive read-write flags and mode", async () => {
    const { ops } = await locked();
    const lockOpen = ops.log.find((entry) =>
      entry.startsWith("open:/state/run-1/.lock:"),
    );
    expect(lockOpen).toContain(
      String(
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
      ),
    );
    expect(lockOpen).toContain(":600");
  });

  test("cleans up a proven lock after its file sync fails", async () => {
    const ops = new MemoryAtomicFileOps();
    const store = await FileRunStore.open({
      root: "/state",
      runId: "run-1",
      ops,
    });
    ops.failSyncPath = "/state/run-1/.lock";
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 1,
        processStartIdentity: "x",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    const unlink = ops.log.lastIndexOf("unlink:/state/run-1/.lock");
    const sync = ops.log.lastIndexOf("syncDir:/state/run-1");
    const close = ops.log.lastIndexOf("close:/state/run-1/.lock");
    expect(unlink).toBeLessThan(sync);
    expect(sync).toBeLessThan(close);
  });

  test("does not unlink a partially written lock when acquire write fails before nonce proof", async () => {
    const ops = new MemoryAtomicFileOps();
    const store = await FileRunStore.open({
      root: "/state",
      runId: "run-1",
      ops,
    });
    ops.fail.write = new Error("write failure");
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 1,
        processStartIdentity: "x",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
    expect(ops.log).toContain("close:/state/run-1/.lock");
  });

  test("closes but never unlinks a lock after a partial write then failure", async () => {
    const ops = new MemoryAtomicFileOps();
    const store = await FileRunStore.open({
      root: "/state",
      runId: "run-1",
      ops,
    });
    ops.writeLimit = 1;
    ops.failOn(
      "write",
      2,
      new Error("second write failed"),
      "/state/run-1/.lock",
    );
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 1,
        processStartIdentity: "x",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
    expect(ops.log).toContain("close:/state/run-1/.lock");
  });

  test("cleans up a fully written lock when run-directory sync or post-sync stat fails", async () => {
    for (const operation of ["syncDir", "stat"] as const) {
      const ops = new MemoryAtomicFileOps();
      const store = await FileRunStore.open({
        root: "/state",
        runId: "run-1",
        ops,
      });
      const path = operation === "stat" ? "/state/run-1/.lock" : "/state/run-1";
      const next =
        (ops.counts.get(`${operation}:${path}`) ?? 0) +
        (operation === "syncDir" ? 1 : 1);
      ops.failOn(operation, next, new Error(`${operation} failed`), path);
      await expect(
        store.acquireRunLock({
          nonce: "nonce",
          pid: 1,
          processStartIdentity: "x",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(ops.log).toContain("unlink:/state/run-1/.lock");
      expect(ops.log).toContain("close:/state/run-1/.lock");
    }
  });

  test("acquire cleanup refuses unverified held/path identities and malformed owner bodies", async () => {
    for (const mutate of [
      (ops: MemoryAtomicFileOps) =>
        ops.addFile("/state/run-1/.lock", Buffer.from('{"nonce":"nonce"}')),
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").bytes = Buffer.from("{");
      },
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").bytes =
          Buffer.from('{"nonce":"other"}');
      },
    ]) {
      const ops = new MemoryAtomicFileOps();
      const store = await FileRunStore.open({
        root: "/state",
        runId: "run-1",
        ops,
      });
      const next = (ops.counts.get("sync:/state/run-1/.lock") ?? 0) + 1;
      ops.hookOn("sync", next, () => mutate(ops), "/state/run-1/.lock");
      ops.failOn(
        "sync",
        next,
        new Error("force cleanup"),
        "/state/run-1/.lock",
      );
      await expect(
        store.acquireRunLock({
          nonce: "nonce",
          pid: 1,
          processStartIdentity: "x",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
      expect(ops.log).toContain("close:/state/run-1/.lock");
    }
  });

  test("release uses held descriptor verification then unlink, directory sync, and close", async () => {
    const { ops, lock } = await locked();
    await lock.release();
    const unlink = ops.log.lastIndexOf("unlink:/state/run-1/.lock");
    const sync = ops.log.lastIndexOf("syncDir:/state/run-1");
    const close = ops.log.lastIndexOf("close:/state/run-1/.lock");
    expect(unlink).toBeLessThan(sync);
    expect(sync).toBeLessThan(close);
  });

  test("fails closed without unlinking when the lock path is replaced by a symlink", async () => {
    const { ops, lock } = await locked();
    ops.addSymlink("/state/run-1/.lock");
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
  });

  test("fails closed without unlinking when the lock path inode changes", async () => {
    const { ops, lock } = await locked();
    ops.addFile("/state/run-1/.lock", Buffer.from('{"nonce":"nonce-1"}'));
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
  });

  test("fails closed without unlinking when the held lock nonce changes", async () => {
    const { ops, lock } = await locked();
    ops.entry("/state/run-1/.lock").bytes = Buffer.from('{"nonce":"other"}');
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
  });

  test("fails closed and closes when held lock verification reads fail or return zero bytes", async () => {
    for (const mode of ["throw", "zero"] as const) {
      const { ops, lock } = await locked();
      if (mode === "throw")
        ops.failOn(
          "read",
          (ops.counts.get("read:/state/run-1/.lock") ?? 0) + 1,
          new Error("read"),
          "/state/run-1/.lock",
        );
      else ops.readLimit = 0;
      await expect(lock.release()).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
      expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
      expect(ops.log).toContain("close:/state/run-1/.lock");
    }
  });

  test("fails closed when path device/inode identity changes", async () => {
    for (const mutate of [
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").dev = 2;
      },
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").ino = 99;
      },
    ]) {
      const { ops, lock } = await locked();
      mutate(ops);
      await expect(lock.release()).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
      expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
    }
  });

  test("fails closed when held descriptor device/inode changes after path verification", async () => {
    for (const mutate of [
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").dev = 2;
      },
      (ops: MemoryAtomicFileOps) => {
        ops.entry("/state/run-1/.lock").ino = 99;
      },
    ]) {
      const { ops, lock } = await locked();
      const next = (ops.counts.get("stat:/state/run-1/.lock") ?? 0) + 1;
      ops.hookOn("stat", next, () => mutate(ops), "/state/run-1/.lock");
      await expect(lock.release()).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
      expect(ops.log).not.toContain("unlink:/state/run-1/.lock");
    }
  });

  test("does not sync the directory when lock unlink itself fails", async () => {
    const { ops, lock } = await locked();
    ops.fail.unlink = new Error("unlink failed");
    const before = ops.log.length;
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.log.slice(before)).not.toContain("syncDir:/state/run-1");
  });

  test("returns one concurrent release promise", async () => {
    const { lock } = await locked();
    const first = lock.release();
    expect(lock.release()).toBe(first);
    await first;
  });

  test("marks release indeterminate after unlink then directory sync failure and never recreates the lock", async () => {
    const { ops, store, lock } = await locked();
    ops.fail.syncDir = new Error("directory sync failed");
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.entries.has("/state/run-1/.lock")).toBe(false);
    const before = ops.log.length;
    await expect(
      store.acquireRunLock({
        nonce: "next",
        pid: 2,
        processStartIdentity: "next",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(before);
  });

  test("closes after directory-sync release failure and a rejected release never touches a replacement lock", async () => {
    const { ops, lock } = await locked();
    const next = (ops.counts.get("syncDir:/state/run-1") ?? 0) + 1;
    ops.failOn("syncDir", next, new Error("after unlink"), "/state/run-1");
    const rejected = lock.release();
    await expect(rejected).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toContain("close:/state/run-1/.lock");
    ops.fail.syncDir = undefined;
    ops.addFile("/state/run-1/.lock", Buffer.from("new"));
    const before = ops.log.length;
    expect(lock.release()).toBe(rejected);
    await expect(lock.release()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    expect(ops.log).toHaveLength(before);
    expect(ops.entries.get("/state/run-1/.lock")?.bytes.toString()).toBe("new");
  });

  test("poisons after partial append bytes then a write failure, and refuses a symlink journal", async () => {
    const { ops, store } = await locked();
    ops.writeLimit = 1;
    ops.failOn(
      "write",
      2,
      new Error("write failed"),
      "/state/run-1/events.jsonl",
    );
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    const before = ops.log.length;
    await expect(
      store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(before);
    const second = await locked();
    second.ops.addSymlink("/state/run-1/events.jsonl");
    await expect(
      second.store.appendEvent({
        version: 1,
        type: "run.started",
        runId: "run-1",
        data: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("rejects an invalid prospective call before writing journal bytes", async () => {
    const { ops, store } = await locked();
    await expect(
      store.appendCall({
        version: 1,
        kind: "call",
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        callSeq: 0,
        callId: "call-1",
        key: `v2:${"a".repeat(64)}`,
        previousKey: "",
        state: "completed",
        completed: {
          outcome: "result",
          origin: "live",
          result: { text: "ok" },
          value: "\ud800",
          usage: { complete: true, outputTokens: 1 },
        },
      } as never),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(
      ops.log.filter((entry) =>
        entry.startsWith("write:/state/run-1/journal.jsonl"),
      ),
    ).toHaveLength(0);
  });

  test("strictly rejects malformed append records before journal repair or mutation", async () => {
    async function seeded() {
      const lockedStore = await locked();
      const source = await lockedStore.store.writeSourceSnapshot({
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        sourcePath: "/project/a.js",
        source: "console.log(1)",
      });
      await lockedStore.store.beginAttempt({
        ...attempt,
        sourceSha256: source.sha256,
      });
      return lockedStore;
    }
    const base = {
      version: 1 as const,
      kind: "call" as const,
      runId: "run-1",
      attemptId: "attempt-1",
      attemptSeq: 0,
      callSeq: 0,
      callId: "call-1",
      key: `v2:${"a".repeat(64)}`,
      previousKey: "",
      state: "scheduled" as const,
    };
    const invalid = [
      { ...base, runId: "other" },
      { ...base, key: "v2:not-a-key" },
      { ...base, extra: true },
      {
        ...base,
        state: "completed" as const,
        completed: {
          outcome: "result" as const,
          origin: "live" as const,
          result: { text: 1 },
          value: "x",
          usage: { complete: true, outputTokens: 1 },
        },
      },
    ];
    for (const candidate of invalid) {
      const { ops, store } = await seeded();
      const beforeBytes = Buffer.from(
        ops.entry("/state/run-1/journal.jsonl").bytes,
      );
      const beforeLog = ops.log.length;
      await expect(store.appendCall(candidate as never)).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
      expect(ops.entry("/state/run-1/journal.jsonl").bytes).toEqual(
        beforeBytes,
      );
      expect(
        ops.log
          .slice(beforeLog)
          .filter((entry) =>
            /^(write|ftruncate|sync):\/state\/run-1\/journal\.jsonl/.test(
              entry,
            ),
          ),
      ).toHaveLength(0);
      await expect(store.loadJournal()).resolves.toHaveLength(1);
    }
  });

  test("rejects malformed attempts before touching source binding paths", async () => {
    for (const candidate of [
      { ...attempt, attemptId: "a/../../../escape" },
      { ...attempt, sourceSha256: "bad" },
      { ...attempt, attemptSeq: -1 },
      { ...attempt, runId: "other" },
      { ...attempt, extra: true },
    ]) {
      const { ops, store } = await locked();
      const before = ops.log.length;
      await expect(
        store.beginAttempt(candidate as never),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(
        ops.log.slice(before).filter((entry) => entry.includes("/scripts/")),
      ).toHaveLength(0);
      expect(
        ops.log
          .slice(before)
          .filter((entry) =>
            /^(write|ftruncate|sync):\/state\/run-1\/journal/.test(entry),
          ),
      ).toHaveLength(0);
    }
  });

  test("appends a strict valid record that reloads unchanged", async () => {
    const { store } = await (async () => {
      const lockedStore = await locked();
      const source = await lockedStore.store.writeSourceSnapshot({
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        sourcePath: "/project/a.js",
        source: "console.log(1)",
      });
      await lockedStore.store.beginAttempt({
        ...attempt,
        sourceSha256: source.sha256,
      });
      return lockedStore;
    })();
    const appended = await store.appendCall({
      version: 1,
      kind: "call",
      runId: "run-1",
      attemptId: "attempt-1",
      attemptSeq: 0,
      callSeq: 0,
      callId: "call-1",
      key: `v2:${"a".repeat(64)}`,
      previousKey: "",
      state: "scheduled",
    });
    await expect(store.loadJournal()).resolves.toEqual([
      expect.objectContaining({ kind: "attempt", recordSeq: 0 }),
      appended.record,
    ]);
  });

  test("does not repair a valid no-LF tail for an invalid prospective call", async () => {
    const { ops, store } = await locked();
    ops.addFile(
      "/state/run-1/journal.jsonl",
      Buffer.from(
        JSON.stringify({
          ...attempt,
          recordSeq: 0,
          recordedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const bytesBefore = Buffer.from(
      ops.entry("/state/run-1/journal.jsonl").bytes,
    );
    const before = ops.log.length;
    await expect(
      store.appendCall({
        version: 1,
        kind: "call",
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        callSeq: 0,
        callId: "call-1",
        key: `v2:${"a".repeat(64)}`,
        previousKey: "",
        state: "scheduled",
        extra: true,
      } as never),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.entry("/state/run-1/journal.jsonl").bytes).toEqual(bytesBefore);
    expect(
      ops.log
        .slice(before)
        .filter((entry) =>
          /^(write|ftruncate|sync):\/state\/run-1\/journal\.jsonl/.test(entry),
        ),
    ).toHaveLength(0);
  });

  test("does not truncate an invalid tail for an invalid prospective call", async () => {
    const { ops, store } = await locked();
    const valid = `${JSON.stringify({
      ...attempt,
      recordSeq: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    ops.addFile("/state/run-1/journal.jsonl", Buffer.from(`${valid}{`));
    const bytesBefore = Buffer.from(
      ops.entry("/state/run-1/journal.jsonl").bytes,
    );
    const before = ops.log.length;
    await expect(
      store.appendCall({
        version: 1,
        kind: "call",
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        callSeq: 0,
        callId: "call-1",
        key: `v2:${"a".repeat(64)}`,
        previousKey: "",
        state: "started",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.entry("/state/run-1/journal.jsonl").bytes).toEqual(bytesBefore);
    expect(
      ops.log
        .slice(before)
        .filter((entry) =>
          /^(write|ftruncate|sync):\/state\/run-1\/journal\.jsonl/.test(entry),
        ),
    ).toHaveLength(0);
  });

  test("rejects a journal path symlink before any journal bytes are written", async () => {
    const { ops, store } = await locked();
    ops.addSymlink("/state/run-1/journal.jsonl");
    await expect(
      store.appendCall({
        version: 1,
        kind: "call",
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        callSeq: 0,
        callId: "call-1",
        key: `v2:${"a".repeat(64)}`,
        previousKey: "",
        state: "scheduled",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(
      ops.log.filter((entry) =>
        entry.startsWith("write:/state/run-1/journal.jsonl"),
      ),
    ).toHaveLength(0);
  });

  test("rejects an oversized journal before allocation, parsing, or append", async () => {
    const { ops, store } = await locked();
    ops.addSparseFile("/state/run-1/journal.jsonl", 64 * 1024 * 1024 + 1);
    const before = ops.log.length;

    await expect(
      store.appendCall({
        version: 1,
        kind: "call",
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSeq: 0,
        callSeq: 0,
        callId: "call-1",
        key: `v2:${"a".repeat(64)}`,
        previousKey: "",
        state: "scheduled",
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "state file exceeds the byte limit",
    });
    expect(
      ops.log
        .slice(before)
        .some((entry) => entry.startsWith("read:/state/run-1/journal.jsonl:")),
    ).toBe(false);
    expect(
      ops.log
        .slice(before)
        .some((entry) => entry.startsWith("write:/state/run-1/journal.jsonl:")),
    ).toBe(false);
  });

  test("repairs a valid final journal record without LF by appending exactly one LF before the next record", async () => {
    const { ops, store } = await locked();
    const prior = JSON.stringify({
      ...attempt,
      recordSeq: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    ops.addFile("/state/run-1/journal.jsonl", Buffer.from(prior));
    const source = await store.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-2",
      attemptSeq: 1,
      sourcePath: "/project/b.js",
      source: "console.log(1)",
    });
    const before = ops.log.length;
    await store.beginAttempt({
      version: 1,
      kind: "attempt",
      runId: "run-1",
      attemptId: "attempt-2",
      attemptSeq: 1,
      sourceSha256: source.sha256,
      sourcePath: source.sourcePath,
    });
    const tail = ops.log.slice(before);
    expect(tail).not.toContain(
      `ftruncate:/state/run-1/journal.jsonl:${Buffer.byteLength(prior)}`,
    );
    const newline = tail.findIndex(
      (entry) => entry === "write:/state/run-1/journal.jsonl:0:1",
    );
    const sync = tail.findIndex(
      (entry) => entry === "sync:/state/run-1/journal.jsonl",
    );
    const next = tail.findIndex(
      (entry) =>
        entry.startsWith("write:/state/run-1/journal.jsonl:0:") &&
        entry !== "write:/state/run-1/journal.jsonl:0:1",
    );
    expect(newline).toBeGreaterThanOrEqual(0);
    expect(newline).toBeLessThan(sync);
    expect(sync).toBeLessThan(next);
    const records = await store.loadJournal();
    expect(records.map((record) => record.recordSeq)).toEqual([0, 1]);
    expect(ops.entry("/state/run-1/journal.jsonl").bytes.toString()).toContain(
      "\n{",
    );
  });

  test("truncates an invalid final journal tail to validEndOffset, syncs, then appends an unglued record", async () => {
    const { ops, store } = await locked();
    const valid = `${JSON.stringify({ ...attempt, recordSeq: 0, recordedAt: "2026-01-01T00:00:00.000Z" })}\n`;
    ops.addFile("/state/run-1/journal.jsonl", Buffer.from(`${valid}{`));
    const source = await store.writeSourceSnapshot({
      runId: "run-1",
      attemptId: "attempt-2",
      attemptSeq: 1,
      sourcePath: "/project/b.js",
      source: "console.log(1)",
    });
    const before = ops.log.length;
    await store.beginAttempt({
      version: 1,
      kind: "attempt",
      runId: "run-1",
      attemptId: "attempt-2",
      attemptSeq: 1,
      sourceSha256: source.sha256,
      sourcePath: source.sourcePath,
    });
    const tail = ops.log.slice(before);
    const truncation = tail.indexOf(
      `ftruncate:/state/run-1/journal.jsonl:${Buffer.byteLength(valid)}`,
    );
    const sync = tail.indexOf("sync:/state/run-1/journal.jsonl");
    const append = tail.findIndex((entry) =>
      entry.startsWith("write:/state/run-1/journal.jsonl:"),
    );
    expect(truncation).toBeGreaterThanOrEqual(0);
    expect(truncation).toBeLessThan(sync);
    expect(sync).toBeLessThan(append);
    const records = await store.loadJournal();
    expect(records.map((record) => record.recordSeq)).toEqual([0, 1]);
    expect(ops.entry("/state/run-1/journal.jsonl").bytes.toString()).toContain(
      "\n{",
    );
  });

  test("rejects invalid pid before filesystem operations", async () => {
    const ops = new MemoryAtomicFileOps();
    const store = await FileRunStore.open({
      root: "/state",
      runId: "run-1",
      ops,
    });
    const before = ops.log.length;
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 0,
        processStartIdentity: "x",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(ops.log).toHaveLength(before);
  });

  test("rejects non-exact or non-canonical lock owners before filesystem operations", async () => {
    for (const owner of [
      { nonce: "nonce", pid: 1, processStartIdentity: "\ud800" },
      { nonce: "nonce", pid: 1, processStartIdentity: "x", extra: true },
      Object.assign(
        { nonce: "nonce", pid: 1, processStartIdentity: "x" },
        {
          [Symbol("extra")]: true,
        },
      ),
      new Proxy({ nonce: "nonce", pid: 1, processStartIdentity: "x" }, {}),
    ]) {
      const ops = new MemoryAtomicFileOps();
      const store = await FileRunStore.open({
        root: "/state",
        runId: "run-1",
        ops,
      });
      const before = ops.log.length;
      await expect(store.acquireRunLock(owner as never)).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
      expect(ops.log).toHaveLength(before);
    }
  });

  test("rejects invalid or throwing lock clocks before opening and persists only projected owner fields", async () => {
    for (const now of [
      () => new Date("invalid"),
      () => {
        throw new Error("clock");
      },
    ]) {
      const ops = new MemoryAtomicFileOps();
      const store = await FileRunStore.open({
        root: "/state",
        runId: "run-1",
        ops,
        now,
      });
      const before = ops.log.length;
      await expect(
        store.acquireRunLock({
          nonce: "nonce",
          pid: 1,
          processStartIdentity: "x",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(ops.log).toHaveLength(before);
    }
    const { ops } = await locked();
    expect(
      JSON.parse(ops.entry("/state/run-1/.lock").bytes.toString()),
    ).toEqual({
      version: 1,
      nonce: "nonce-1",
      pid: 1,
      processStartIdentity: "start",
      acquiredAt: expect.any(String),
    });
  });

  test("distinguishes an existing lock from another create failure", async () => {
    const ops = new MemoryAtomicFileOps();
    const store = await FileRunStore.open({
      root: "/state",
      runId: "run-1",
      ops,
    });
    ops.addFile("/state/run-1/.lock");
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 1,
        processStartIdentity: "x",
      }),
    ).rejects.toThrow(/already exists/);
    ops.entries.delete("/state/run-1/.lock");
    ops.fail.open = Object.assign(new Error("io"), { code: "EIO" });
    await expect(
      store.acquireRunLock({
        nonce: "nonce",
        pid: 1,
        processStartIdentity: "x",
      }),
    ).rejects.toThrow(/could not create/);
  });
});
