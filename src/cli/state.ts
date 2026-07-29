import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";

import { type ProviderPin, parseProviderPin } from "../config/provider-pin.js";
import { canonicalJson } from "../core/canonical-json.js";
import { AwslError, type AwslErrorCode } from "../core/errors.js";
import { createEvent } from "../core/events.js";
import type { JsonValue, RunStatus } from "../core/types.js";
import {
  type GitWorktreeBase,
  parseGitWorktreeBase,
} from "../runtime/worktree.js";
import {
  existingPrivateDirectory,
  nodeFileOps,
  privateDirectory,
} from "../store/file-ops.js";
import { FileRunStore } from "../store/run-store.js";
import type {
  JournalCallRecordV1,
  JournalRecordV1,
  LockOwner,
  RunSnapshot,
  StoredLockOwner,
} from "../store/types.js";
import type { ProcessInspection } from "./signals.js";

const runToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const errorCodes = new Set<AwslErrorCode>([
  "USAGE_ERROR",
  "CONFIG_ERROR",
  "COMPATIBILITY_ERROR",
  "WORKFLOW_ERROR",
  "PROVIDER_ERROR",
  "SCHEMA_ERROR",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "PERSISTENCE_ERROR",
  "WORKTREE_ERROR",
]);

function persistence(message: string, cause?: unknown): AwslError {
  return new AwslError("PERSISTENCE_ERROR", message, {
    recoverable: false,
    cause,
  });
}

function isMissing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    (Object.hasOwn(error, "cause") &&
      isMissing((error as { cause?: unknown }).cause))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validBudget(value: unknown): value is {
  readonly total: number | null;
  readonly spent: number;
} {
  return (
    record(value) &&
    exact(value, ["total", "spent"]) &&
    (value.total === null || counter(value.total)) &&
    counter(value.spent)
  );
}

function validMetrics(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  if (
    !record(value) ||
    !exact(value, [
      "agentCount",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "attemptOutputTokens",
      "usageComplete",
    ]) ||
    typeof value.usageComplete !== "boolean"
  )
    return false;
  return [
    "agentCount",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "attemptOutputTokens",
  ].every((field) => counter(value[field]));
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

export function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !runToken.test(value))
    throw new AwslError("USAGE_ERROR", "invalid run identifier", {
      recoverable: false,
    });
}

export function projectId(projectRoot: string): string {
  if (!absolutePath(projectRoot))
    throw new AwslError("CONFIG_ERROR", "project root is invalid", {
      recoverable: false,
    });
  return `project-${createHash("sha256")
    .update("awsl-project-v1\0")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 32)}`;
}

async function ensurePrivatePath(path: string): Promise<string> {
  if (!absolutePath(path))
    throw new AwslError("CONFIG_ERROR", "state directory is invalid", {
      recoverable: false,
    });
  const root = parsePath(path).root;
  let current = root;
  const segments = path.slice(root.length).split(sep).filter(Boolean);
  for (const segment of segments) {
    const next = join(current, segment);
    try {
      const state = await nodeFileOps.lstat(next);
      if (state.isSymbolicLink() || !state.isDirectory())
        throw persistence("state path contains a non-directory component");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await privateDirectory(nodeFileOps, next);
    }
    current = next;
  }
  await privateDirectory(nodeFileOps, path);
  return path;
}

export interface ProjectState {
  readonly stateDir: string;
  readonly projectsDir: string;
  readonly projectId: string;
  readonly projectDir: string;
  readonly runsRoot: string;
}

export function projectStatePaths(
  stateDir: string,
  projectRoot: string,
): ProjectState {
  const root = resolve(stateDir);
  if (!absolutePath(root))
    throw new AwslError("CONFIG_ERROR", "state directory is invalid", {
      recoverable: false,
    });
  const id = projectId(projectRoot);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, id);
  return Object.freeze({
    stateDir: root,
    projectsDir,
    projectId: id,
    projectDir,
    runsRoot: join(projectDir, "runs"),
  });
}

export async function ensureProjectState(
  stateDir: string,
  options: { readonly projectRoot: string },
): Promise<ProjectState> {
  const root = await ensurePrivatePath(resolve(stateDir));
  const paths = projectStatePaths(root, options.projectRoot);
  await privateDirectory(nodeFileOps, paths.projectsDir);
  await privateDirectory(nodeFileOps, paths.projectDir);
  await privateDirectory(nodeFileOps, paths.runsRoot);
  return paths;
}

export async function openProjectState(
  stateDir: string,
  options: { readonly projectRoot: string },
): Promise<ProjectState | undefined> {
  const paths = projectStatePaths(stateDir, options.projectRoot);
  try {
    for (const path of [
      paths.stateDir,
      paths.projectsDir,
      paths.projectDir,
      paths.runsRoot,
    ])
      await existingPrivateDirectory(nodeFileOps, path);
    return paths;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function listRunIds(runsRoot: string): Promise<readonly string[]> {
  let entries: Dirent<Buffer>[];
  try {
    entries = await readdir(runsRoot, {
      encoding: "buffer",
      withFileTypes: true,
    });
  } catch (error) {
    throw persistence("could not enumerate run state", error);
  }
  const ids: string[] = [];
  for (const entry of entries) {
    let name: string;
    try {
      name = fatalUtf8.decode(entry.name);
    } catch (error) {
      throw persistence("run catalog contains an invalid entry", error);
    }
    if (!runToken.test(name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw persistence("run catalog contains an invalid entry");
    await FileRunStore.openExisting({ root: runsRoot, runId: name });
    ids.push(name);
  }
  return Object.freeze(ids.sort());
}

export interface StoredRunSnapshot {
  readonly version: 1;
  readonly runId: string;
  readonly status: RunStatus;
  readonly statusReason?: "host_crash_detected";
  readonly attempt: { readonly id: string; readonly seq: number };
  readonly root: {
    readonly reference: string;
    readonly realpath: string;
    readonly sha256: `sha256:${string}`;
  };
  readonly canonicalCwd: string;
  readonly providerPin: ProviderPin;
  readonly worktreeBase: GitWorktreeBase | null;
  readonly argsPresent: boolean;
  readonly args: JsonValue | null;
  readonly budget: { readonly total: number | null; readonly spent: number };
  readonly metrics: Readonly<Record<string, JsonValue>>;
  readonly process: {
    readonly pid: number;
    readonly processStartIdentity: string;
    readonly nonce: string;
  };
  readonly worktrees: readonly JsonValue[];
}

export function parseStoredRunSnapshot(value: unknown): StoredRunSnapshot {
  try {
    canonicalJson(value);
    if (
      !record(value) ||
      !exact(
        value,
        [
          "version",
          "runId",
          "status",
          "attempt",
          "root",
          "canonicalCwd",
          "providerPin",
          "worktreeBase",
          "argsPresent",
          "args",
          "budget",
          "metrics",
          "process",
          "worktrees",
        ],
        ["statusReason"],
      ) ||
      value.version !== 1 ||
      typeof value.runId !== "string" ||
      !runToken.test(value.runId) ||
      !["running", "paused", "completed", "failed", "killed"].includes(
        String(value.status),
      ) ||
      (value.statusReason !== undefined &&
        value.statusReason !== "host_crash_detected")
    )
      throw new TypeError();
    const attempt = value.attempt;
    const root = value.root;
    const budget = value.budget;
    const metrics = value.metrics;
    const processState = value.process;
    if (
      !record(attempt) ||
      !exact(attempt, ["id", "seq"]) ||
      typeof attempt.id !== "string" ||
      !runToken.test(attempt.id) ||
      !counter(attempt.seq) ||
      !record(root) ||
      !exact(root, ["reference", "realpath", "sha256"]) ||
      typeof root.reference !== "string" ||
      root.reference.length === 0 ||
      root.reference.includes("\0") ||
      !absolutePath(root.realpath) ||
      typeof root.sha256 !== "string" ||
      !digest.test(root.sha256) ||
      !absolutePath(value.canonicalCwd) ||
      typeof value.argsPresent !== "boolean" ||
      (!value.argsPresent && value.args !== null) ||
      !validBudget(budget) ||
      !validMetrics(metrics) ||
      !record(processState) ||
      !exact(processState, ["pid", "processStartIdentity", "nonce"]) ||
      !Number.isSafeInteger(processState.pid) ||
      (processState.pid as number) <= 0 ||
      typeof processState.processStartIdentity !== "string" ||
      processState.processStartIdentity.length === 0 ||
      processState.processStartIdentity.includes("\0") ||
      typeof processState.nonce !== "string" ||
      !runToken.test(processState.nonce) ||
      !Array.isArray(value.worktrees)
    )
      throw new TypeError();
    const pin = parseProviderPin(value.providerPin);
    if (
      pin.canonicalCwd !== value.canonicalCwd ||
      pin.sources.every(
        (source) =>
          source.kind !== "workflow-path" ||
          source.reference !== root.reference ||
          source.realpath !== root.realpath,
      )
    )
      throw new TypeError();
    const worktreeBase = parseGitWorktreeBase(value.worktreeBase);
    return Object.freeze({
      ...(value as unknown as StoredRunSnapshot),
      providerPin: pin,
      worktreeBase,
    });
  } catch (error) {
    throw persistence("invalid run snapshot", error);
  }
}

export interface StoredRunResultSnapshot {
  readonly version: 1;
  readonly runId: string;
  readonly status: Exclude<RunStatus, "running">;
  readonly statusReason?: "host_crash_detected";
  readonly providerPin: ProviderPin;
  readonly budget: { readonly total: number | null; readonly spent: number };
  readonly metrics: Readonly<Record<string, JsonValue>>;
  readonly worktreeBase: GitWorktreeBase | null;
  readonly result?: JsonValue;
  readonly error?: {
    readonly name: "AwslError";
    readonly code: AwslErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
    readonly runId?: string;
    readonly callId?: string;
    readonly phase?: string;
    readonly provider?: string;
  };
}

function validError(
  value: unknown,
  runId: string,
): value is NonNullable<StoredRunResultSnapshot["error"]> {
  if (
    !record(value) ||
    !exact(
      value,
      ["name", "code", "message", "recoverable"],
      ["runId", "callId", "phase", "provider"],
    ) ||
    value.name !== "AwslError" ||
    typeof value.code !== "string" ||
    !errorCodes.has(value.code as AwslErrorCode) ||
    typeof value.message !== "string" ||
    typeof value.recoverable !== "boolean"
  )
    return false;
  for (const field of ["runId", "callId", "phase", "provider"] as const)
    if (value[field] !== undefined && typeof value[field] !== "string")
      return false;
  return value.runId === undefined || value.runId === runId;
}

export function parseStoredRunResultSnapshot(
  value: unknown,
  expected?: StoredRunSnapshot,
): StoredRunResultSnapshot {
  try {
    canonicalJson(value);
    if (
      !record(value) ||
      !exact(
        value,
        [
          "version",
          "runId",
          "status",
          "providerPin",
          "budget",
          "metrics",
          "worktreeBase",
        ],
        ["statusReason", "result", "error"],
      ) ||
      value.version !== 1 ||
      typeof value.runId !== "string" ||
      !runToken.test(value.runId) ||
      !["paused", "completed", "failed", "killed"].includes(
        String(value.status),
      ) ||
      (value.statusReason !== undefined &&
        (value.status !== "killed" ||
          value.statusReason !== "host_crash_detected")) ||
      !validBudget(value.budget) ||
      !validMetrics(value.metrics)
    )
      throw new TypeError();
    const completed = value.status === "completed";
    if (
      completed !== Object.hasOwn(value, "result") ||
      completed === Object.hasOwn(value, "error") ||
      (!completed && !validError(value.error, value.runId))
    )
      throw new TypeError();
    const providerPin = parseProviderPin(value.providerPin);
    const worktreeBase = parseGitWorktreeBase(value.worktreeBase);
    if (
      expected !== undefined &&
      (value.runId !== expected.runId ||
        value.status !== expected.status ||
        value.statusReason !== expected.statusReason ||
        canonicalJson(providerPin) !== canonicalJson(expected.providerPin) ||
        canonicalJson(value.budget) !== canonicalJson(expected.budget) ||
        canonicalJson(value.metrics) !== canonicalJson(expected.metrics) ||
        canonicalJson(worktreeBase) !== canonicalJson(expected.worktreeBase))
    )
      throw new TypeError();
    return Object.freeze({
      ...(value as unknown as StoredRunResultSnapshot),
      providerPin,
      worktreeBase,
    });
  } catch (error) {
    throw persistence("invalid result snapshot", error);
  }
}

export interface ReconciledRun {
  readonly snapshot: StoredRunSnapshot;
  readonly active: boolean;
  readonly repaired: boolean;
  readonly atLeastOnce: boolean;
}

function sameProcess(
  snapshot: StoredRunSnapshot,
  lock: StoredLockOwner,
): boolean {
  return (
    snapshot.process.pid === lock.pid &&
    snapshot.process.processStartIdentity === lock.processStartIdentity &&
    snapshot.process.nonce === lock.nonce
  );
}

function sameSnapshotProcess(
  left: StoredRunSnapshot,
  right: StoredRunSnapshot,
): boolean {
  return (
    left.process.pid === right.process.pid &&
    left.process.processStartIdentity === right.process.processStartIdentity &&
    left.process.nonce === right.process.nonce
  );
}

function latestStartedCalls(
  records: readonly (JournalCallRecordV1 | { readonly kind: "attempt" })[],
): readonly JournalCallRecordV1[] {
  const latest = new Map<string, JournalCallRecordV1>();
  for (const record of records) {
    if (record.kind !== "call") continue;
    latest.set(
      `${record.attemptSeq}:${record.callSeq}:${record.callId}:${record.key}`,
      record,
    );
  }
  return [...latest.values()].filter((record) => record.state === "started");
}

async function optionalLock(
  store: FileRunStore,
): Promise<StoredLockOwner | undefined> {
  try {
    return await store.readLockOwner();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function optionalJournal(
  store: FileRunStore,
): Promise<readonly JournalRecordV1[]> {
  try {
    return await store.loadJournal();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function hasAtLeastOnceRisk(records: readonly JournalRecordV1[]): boolean {
  return records.some(
    (record) => record.kind === "call" && record.state === "indeterminate",
  );
}

export async function reconcileRun(
  store: FileRunStore,
  options: {
    readonly inspectProcess: (pid: number) => Promise<ProcessInspection>;
    readonly repairOwner: LockOwner;
  },
): Promise<ReconciledRun> {
  const original = parseStoredRunSnapshot(await store.readRun());
  const storedLock = await optionalLock(store);
  if (original.status !== "running") {
    const atLeastOnce = hasAtLeastOnceRisk(await optionalJournal(store));
    if (storedLock === undefined)
      return Object.freeze({
        snapshot: original,
        active: false,
        repaired: false,
        atLeastOnce,
      });
    if (!sameProcess(original, storedLock))
      throw persistence("run snapshot and lock owner do not match");
    const inspected = await options.inspectProcess(original.process.pid);
    if (
      inspected.kind === "alive" &&
      inspected.processStartIdentity === original.process.processStartIdentity
    )
      return Object.freeze({
        snapshot: original,
        active: true,
        repaired: false,
        atLeastOnce,
      });
    if (inspected.kind === "unknown")
      throw persistence("run process identity could not be verified");
    if (!(await store.removeLockIfMatches(storedLock)))
      throw persistence("run lock changed during terminal recovery");
    return Object.freeze({
      snapshot: original,
      active: false,
      repaired: true,
      atLeastOnce,
    });
  }

  if (storedLock !== undefined && !sameProcess(original, storedLock))
    throw persistence("run snapshot and lock owner do not match");
  const inspected = await options.inspectProcess(original.process.pid);
  if (
    inspected.kind === "alive" &&
    inspected.processStartIdentity === original.process.processStartIdentity
  ) {
    if (storedLock === undefined)
      throw persistence("active run is missing its owner lock");
    return Object.freeze({
      snapshot: original,
      active: true,
      repaired: false,
      atLeastOnce: false,
    });
  }
  if (inspected.kind === "unknown")
    throw persistence("run process identity could not be verified");
  if (
    storedLock !== undefined &&
    !(await store.removeLockIfMatches(storedLock))
  )
    throw persistence("run lock changed during orphan recovery");

  const repairLock = await store.acquireRunLock(options.repairOwner);
  try {
    const current = parseStoredRunSnapshot(await store.readRun());
    if (current.status !== "running")
      return Object.freeze({
        snapshot: current,
        active: false,
        repaired: false,
        atLeastOnce: hasAtLeastOnceRisk(await optionalJournal(store)),
      });
    if (!sameSnapshotProcess(original, current))
      throw persistence("run owner changed during orphan recovery");
    const records = await optionalJournal(store);
    const started = latestStartedCalls(records);
    for (const record of started)
      await store.appendCall({
        version: 1,
        kind: "call",
        runId: record.runId,
        attemptId: record.attemptId,
        attemptSeq: record.attemptSeq,
        callSeq: record.callSeq,
        callId: record.callId,
        key: record.key,
        previousKey: record.previousKey,
        state: "indeterminate",
        ...(record.usage === undefined ? {} : { usage: record.usage }),
      });
    const killed = parseStoredRunSnapshot({
      ...current,
      status: "killed",
      statusReason: "host_crash_detected",
    });
    await store.writeRun(killed as unknown as RunSnapshot);
    await store.writeResult({
      version: 1,
      runId: killed.runId,
      status: "killed",
      statusReason: "host_crash_detected",
      providerPin: killed.providerPin as unknown as JsonValue,
      budget: killed.budget,
      metrics: killed.metrics,
      worktreeBase: killed.worktreeBase as unknown as JsonValue,
      error: {
        name: "AwslError",
        code: "CANCELLED",
        message: "host_crash_detected",
        recoverable: false,
      },
    });
    await store.appendEvent(
      createEvent("run.killed", killed.runId, {
        status: "killed",
        code: "CANCELLED",
        reason: "host_crash_detected",
        atLeastOnce: started.length > 0,
      }),
    );
    return Object.freeze({
      snapshot: killed,
      active: false,
      repaired: true,
      atLeastOnce: hasAtLeastOnceRisk(records) || started.length > 0,
    });
  } finally {
    await repairLock.release();
  }
}
