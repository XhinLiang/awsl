import { access, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ensureProjectState,
  parseStoredRunResultSnapshot,
  parseStoredRunSnapshot,
  projectId,
  reconcileRun,
} from "../../src/cli/state.js";
import { canonicalJson } from "../../src/core/canonical-json.js";
import { FileRunStore } from "../../src/store/run-store.js";
import type { RunSnapshot } from "../../src/store/types.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

function runningSnapshot(runId: string): RunSnapshot {
  return {
    version: 1,
    runId,
    status: "running",
    attempt: { id: "attempt-0", seq: 0 },
    root: {
      reference: "workflow.js",
      realpath: "/project/workflow.js",
      sha256: DIGEST_A,
    },
    canonicalCwd: "/project",
    providerPin: {
      version: 1,
      provider: "codex",
      compatibilityProfile: "claude-code@2.1.218",
      executableRealpath: "/opt/codex",
      executableVersion: "0.145.0",
      explicitDefaultModel: null,
      resolvedDefaultModel: null,
      providerProfile: null,
      canonicalCwd: "/project",
      sources: [
        {
          kind: "workflow-path",
          reference: "workflow.js",
          realpath: "/project/workflow.js",
        },
      ],
      awslBehaviorFingerprint: DIGEST_A,
      modelMapFingerprint: DIGEST_B,
      nativeRoutingFingerprint: DIGEST_C,
    },
    worktreeBase: null,
    argsPresent: false,
    args: null,
    budget: { total: null, spent: 0 },
    metrics: {
      agentCount: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      attemptOutputTokens: 0,
      usageComplete: false,
    },
    process: {
      pid: 999_999,
      processStartIdentity: "stale-start",
      nonce: "stale-lock",
    },
    worktrees: [],
  };
}

describe("CLI run catalog and orphan reconciliation", () => {
  test("round-trips Provider Pin V2 through run and result snapshots", () => {
    const input = runningSnapshot("wf_pin_v2");
    const run = parseStoredRunSnapshot(
      JSON.parse(
        canonicalJson({
          ...input,
          providerPin: {
            ...(input.providerPin as Record<string, unknown>),
            version: 2,
            resolvedDefaultModel: "private-native-default",
            configuredNativeModels: ["private-native-default"],
          },
        }),
      ),
    );
    expect(run.providerPin).toMatchObject({
      version: 2,
      resolvedDefaultModel: "private-native-default",
      configuredNativeModels: ["private-native-default"],
    });
    if (run.providerPin.version !== 2)
      throw new Error("expected Provider Pin V2");
    expect(Object.isFrozen(run.providerPin.configuredNativeModels)).toBe(true);

    const result = parseStoredRunResultSnapshot(
      JSON.parse(
        canonicalJson({
          version: 1,
          runId: run.runId,
          status: "completed",
          providerPin: run.providerPin,
          budget: run.budget,
          metrics: run.metrics,
          worktreeBase: run.worktreeBase,
          result: { ok: true },
        }),
      ),
      { ...run, status: "completed" },
    );
    expect(result.providerPin).toEqual(run.providerPin);
  });

  test("strictly validates terminal result snapshots against their run", () => {
    const run = parseStoredRunSnapshot({
      ...runningSnapshot("wf_result"),
      status: "completed",
    });
    const result = {
      version: 1,
      runId: run.runId,
      status: "completed",
      providerPin: run.providerPin,
      budget: run.budget,
      metrics: run.metrics,
      worktreeBase: run.worktreeBase,
      result: { ok: true },
    };
    expect(parseStoredRunResultSnapshot(result, run)).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    expect(() =>
      parseStoredRunResultSnapshot({ ...result, status: "failed" }, run),
    ).toThrowError(
      expect.objectContaining({
        code: "PERSISTENCE_ERROR",
        message: "invalid result snapshot",
      }),
    );
    expect(() =>
      parseStoredRunResultSnapshot(
        { ...result, metrics: { arbitrary: true } },
        run,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PERSISTENCE_ERROR",
        message: "invalid result snapshot",
      }),
    );
  });

  test("uses a stable collision-resistant project namespace and private hierarchy", async () => {
    expect(projectId("/one/project")).not.toBe(projectId("/two/project"));
    expect(projectId("/one/project")).toBe(projectId("/one/project"));

    const base = await mkdtemp(join(tmpdir(), "awsl-state-"));
    const state = await ensureProjectState(
      join(await realpath(base), "nested", "awsl"),
      {
        projectRoot: "/one/project",
      },
    );
    expect(state.projectId).toBe(projectId("/one/project"));
    for (const path of [
      state.stateDir,
      state.projectsDir,
      state.projectDir,
      state.runsRoot,
    ])
      expect((await stat(path)).mode & 0o777).toBe(0o700);
  });

  test("repairs a proven orphan and makes started work at-least-once", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "awsl-runs-"));
    const runId = "wf_orphan";
    const crashed = await FileRunStore.create({ root: runsRoot, runId });
    const writer = await crashed.acquireRunLock({
      nonce: "stale-lock",
      pid: 999_999,
      processStartIdentity: "stale-start",
    });
    const source = await crashed.writeSourceSnapshot({
      runId,
      attemptId: "attempt-0",
      attemptSeq: 0,
      sourcePath: "/project/workflow.js",
      source: "export default 1",
    });
    await crashed.writeRun(runningSnapshot(runId));
    await crashed.beginAttempt({
      version: 1,
      kind: "attempt",
      runId,
      attemptId: "attempt-0",
      attemptSeq: 0,
      sourceSha256: source.sha256,
      sourcePath: source.sourcePath,
    });
    const call = {
      version: 1 as const,
      kind: "call" as const,
      runId,
      attemptId: "attempt-0",
      attemptSeq: 0,
      callSeq: 0,
      callId: "call-0",
      key: `v2:${"d".repeat(64)}` as const,
      previousKey: "",
    };
    await crashed.appendCall({ ...call, state: "scheduled" });
    await crashed.appendCall({ ...call, state: "started" });
    await writer.release();
    await writeFile(
      crashed.paths.lock,
      canonicalJson({
        version: 1,
        nonce: "stale-lock",
        pid: 999_999,
        processStartIdentity: "stale-start",
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );

    const repair = await FileRunStore.openExisting({ root: runsRoot, runId });
    const result = await reconcileRun(repair, {
      inspectProcess: async () => ({ kind: "dead" }),
      repairOwner: {
        nonce: "repair-lock",
        pid: process.pid,
        processStartIdentity: "repair-start",
      },
    });

    expect(result).toMatchObject({
      active: false,
      repaired: true,
      atLeastOnce: true,
      snapshot: {
        status: "killed",
        statusReason: "host_crash_detected",
      },
    });
    expect((await repair.loadJournal()).at(-1)).toMatchObject({
      kind: "call",
      callId: "call-0",
      state: "indeterminate",
    });
    await expect(repair.readResult()).resolves.toMatchObject({
      status: "killed",
      error: {
        code: "CANCELLED",
        message: "host_crash_detected",
      },
    });
    await expect(access(repair.paths.lock)).rejects.toBeTruthy();
    await expect(
      reconcileRun(repair, {
        inspectProcess: async () => {
          throw new Error("terminal state must not probe without a lock");
        },
        repairOwner: {
          nonce: "second-repair-lock",
          pid: process.pid,
          processStartIdentity: "second-repair-start",
        },
      }),
    ).resolves.toMatchObject({
      active: false,
      repaired: false,
      atLeastOnce: true,
      snapshot: { status: "killed" },
    });
  });

  test("never repairs or signals an active matching process", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "awsl-runs-"));
    const runId = "wf_active";
    const active = await FileRunStore.create({ root: runsRoot, runId });
    const writer = await active.acquireRunLock({
      nonce: "stale-lock",
      pid: 999_999,
      processStartIdentity: "stale-start",
    });
    await active.writeRun(runningSnapshot(runId));
    await writer.release();
    await writeFile(
      active.paths.lock,
      canonicalJson({
        version: 1,
        nonce: "stale-lock",
        pid: 999_999,
        processStartIdentity: "stale-start",
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const opened = await FileRunStore.openExisting({ root: runsRoot, runId });

    await expect(
      reconcileRun(opened, {
        inspectProcess: async () => ({
          kind: "alive",
          processStartIdentity: "stale-start",
        }),
        repairOwner: {
          nonce: "repair-lock",
          pid: process.pid,
          processStartIdentity: "repair-start",
        },
      }),
    ).resolves.toMatchObject({
      active: true,
      repaired: false,
      snapshot: { status: "running" },
    });
    await expect(access(opened.paths.lock)).resolves.toBeUndefined();
  });

  test("refuses to repair a run whose owner changes during reconciliation", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "awsl-runs-"));
    const runId = "wf_race";
    const crashed = await FileRunStore.create({ root: runsRoot, runId });
    const writer = await crashed.acquireRunLock({
      nonce: "stale-lock",
      pid: 999_999,
      processStartIdentity: "stale-start",
    });
    await crashed.writeRun(runningSnapshot(runId));
    await writer.release();
    await writeFile(
      crashed.paths.lock,
      canonicalJson({
        version: 1,
        nonce: "stale-lock",
        pid: 999_999,
        processStartIdentity: "stale-start",
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const opened = await FileRunStore.openExisting({ root: runsRoot, runId });

    await expect(
      reconcileRun(opened, {
        inspectProcess: async () => {
          await writeFile(
            opened.paths.run,
            canonicalJson({
              ...runningSnapshot(runId),
              process: {
                pid: 888_888,
                processStartIdentity: "replacement-start",
                nonce: "replacement-lock",
              },
            }),
            { mode: 0o600 },
          );
          return { kind: "dead" };
        },
        repairOwner: {
          nonce: "repair-lock",
          pid: process.pid,
          processStartIdentity: "repair-start",
        },
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "run owner changed during orphan recovery",
    });
    await expect(opened.readRun()).resolves.toMatchObject({
      status: "running",
      process: { nonce: "replacement-lock" },
    });
  });

  test("removes a verified dead terminal lock so a paused run can resume", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "awsl-runs-"));
    const runId = "wf_paused_dead";
    const crashed = await FileRunStore.create({ root: runsRoot, runId });
    const writer = await crashed.acquireRunLock({
      nonce: "paused-lock",
      pid: 999_999,
      processStartIdentity: "paused-start",
    });
    await crashed.writeRun({
      ...runningSnapshot(runId),
      status: "paused",
      process: {
        pid: 999_999,
        processStartIdentity: "paused-start",
        nonce: "paused-lock",
      },
    });
    await writer.release();
    await writeFile(
      crashed.paths.lock,
      canonicalJson({
        version: 1,
        nonce: "paused-lock",
        pid: 999_999,
        processStartIdentity: "paused-start",
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const opened = await FileRunStore.openExisting({ root: runsRoot, runId });

    await expect(
      reconcileRun(opened, {
        inspectProcess: async () => ({ kind: "dead" }),
        repairOwner: {
          nonce: "repair-lock",
          pid: process.pid,
          processStartIdentity: "repair-start",
        },
      }),
    ).resolves.toMatchObject({
      active: false,
      repaired: true,
      snapshot: { status: "paused" },
    });
    await expect(access(opened.paths.lock)).rejects.toBeTruthy();
    const resumed = await opened.acquireRunLock({
      nonce: "resume-lock",
      pid: process.pid,
      processStartIdentity: "resume-start",
    });
    await resumed.release();
  });

  test("does not remove a terminal lock whose matching owner is alive", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "awsl-runs-"));
    const runId = "wf_paused_alive";
    const active = await FileRunStore.create({ root: runsRoot, runId });
    const writer = await active.acquireRunLock({
      nonce: "paused-lock",
      pid: 999_999,
      processStartIdentity: "paused-start",
    });
    await active.writeRun({
      ...runningSnapshot(runId),
      status: "paused",
      process: {
        pid: 999_999,
        processStartIdentity: "paused-start",
        nonce: "paused-lock",
      },
    });
    await writer.release();
    await writeFile(
      active.paths.lock,
      canonicalJson({
        version: 1,
        nonce: "paused-lock",
        pid: 999_999,
        processStartIdentity: "paused-start",
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const opened = await FileRunStore.openExisting({ root: runsRoot, runId });

    await expect(
      reconcileRun(opened, {
        inspectProcess: async () => ({
          kind: "alive",
          processStartIdentity: "paused-start",
        }),
        repairOwner: {
          nonce: "repair-lock",
          pid: process.pid,
          processStartIdentity: "repair-start",
        },
      }),
    ).resolves.toMatchObject({
      active: true,
      repaired: false,
      snapshot: { status: "paused" },
    });
    await expect(access(opened.paths.lock)).resolves.toBeUndefined();
  });
});
