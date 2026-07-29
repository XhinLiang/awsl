import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";

import { AwslError } from "../core/errors.js";

export interface WorktreeExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type WorktreeExec = (
  file: string,
  args: readonly string[],
) => Promise<WorktreeExecResult>;

export interface WorktreeRetainedEvent {
  readonly path: string;
  readonly reason: string;
}

export interface CreateIsolatedWorktreeOptions {
  readonly canonicalCwd: string;
  readonly runDir: string;
  readonly callId: string;
  readonly base?: GitWorktreeBase;
  readonly execFile?: WorktreeExec;
  readonly onRetained?: (event: WorktreeRetainedEvent) => void | Promise<void>;
}

export interface ResolveGitWorktreeBaseOptions {
  readonly canonicalCwd: string;
  readonly execFile?: WorktreeExec;
  readonly baseCommit?: string;
}

export interface GitWorktreeBase {
  readonly repoRoot: string;
  readonly baseCommit: string;
}

export interface IsolatedWorktree {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly path: string;
  readonly cwd: string;
  cleanup(success: boolean): Promise<void>;
}

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function worktreeError(message: string): AwslError {
  return new AwslError("WORKTREE_ERROR", message, { recoverable: false });
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function absoluteLexicalPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw worktreeError(`${label} must be an absolute lexical path`);
  return value;
}

const defaultExecFile: WorktreeExec = (file, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    nodeExecFile(
      file,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });

async function retained(
  path: string,
  reason: string,
  callback: CreateIsolatedWorktreeOptions["onRetained"],
): Promise<void> {
  await callback?.(Object.freeze({ path, reason: reason.slice(0, 512) }));
}

async function discoverBase(
  canonicalSessionCwd: string,
  execute: WorktreeExec,
  pinnedCommit?: string,
): Promise<GitWorktreeBase> {
  try {
    const rootResult = await execute("git", [
      "-C",
      canonicalSessionCwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    const discovered = rootResult.stdout.trim();
    if (!isAbsolute(discovered) || discovered.includes("\0"))
      throw new TypeError();
    const repoRoot = await realpath(discovered);
    if (!contains(repoRoot, canonicalSessionCwd)) throw new TypeError();

    let baseCommit: string;
    if (pinnedCommit === undefined) {
      const commitResult = await execute("git", [
        "-C",
        repoRoot,
        "rev-parse",
        "HEAD",
      ]);
      baseCommit = commitResult.stdout.trim();
      if (!commit.test(baseCommit)) throw new TypeError();
    } else {
      if (!commit.test(pinnedCommit)) throw new TypeError();
      await execute("git", [
        "-C",
        repoRoot,
        "cat-file",
        "-e",
        `${pinnedCommit}^{commit}`,
      ]);
      baseCommit = pinnedCommit;
    }
    return Object.freeze({ repoRoot, baseCommit });
  } catch {
    throw worktreeError("could not resolve a pinned Git base commit");
  }
}

function captureBase(value: unknown): GitWorktreeBase {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value)
  )
    throw worktreeError("pinned Git base is invalid");
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(descriptors).length !== 2 ||
      !["repoRoot", "baseCommit"].every((key) => {
        const descriptor = descriptors[key];
        return descriptor?.enumerable && "value" in descriptor;
      })
    )
      throw new TypeError();
    const repoRoot = absoluteLexicalPath(
      descriptors.repoRoot?.value,
      "pinned Git repository root",
    );
    const baseCommit = descriptors.baseCommit?.value;
    if (typeof baseCommit !== "string" || !commit.test(baseCommit))
      throw new TypeError();
    return Object.freeze({ repoRoot, baseCommit });
  } catch (error) {
    if (error instanceof AwslError) throw error;
    throw worktreeError("pinned Git base is invalid");
  }
}

export function parseGitWorktreeBase(value: unknown): GitWorktreeBase | null {
  return value === null ? null : captureBase(value);
}

export async function resolveGitWorktreeBase(
  options: ResolveGitWorktreeBaseOptions,
): Promise<GitWorktreeBase> {
  const requestedCwd = absoluteLexicalPath(
    options.canonicalCwd,
    "canonical cwd",
  );
  const execute = options.execFile ?? defaultExecFile;
  if (typeof execute !== "function")
    throw worktreeError("Git executor is invalid");
  let canonicalSessionCwd: string;
  try {
    canonicalSessionCwd = await realpath(requestedCwd);
  } catch {
    throw worktreeError("canonical cwd could not be resolved");
  }
  if (canonicalSessionCwd !== requestedCwd)
    throw worktreeError("canonical cwd is not canonical");
  return discoverBase(canonicalSessionCwd, execute, options.baseCommit);
}

export async function createIsolatedWorktree(
  options: CreateIsolatedWorktreeOptions,
): Promise<IsolatedWorktree> {
  const requestedCwd = absoluteLexicalPath(
    options.canonicalCwd,
    "canonical cwd",
  );
  const requestedRunDir = absoluteLexicalPath(options.runDir, "run directory");
  if (typeof options.callId !== "string" || !safeToken.test(options.callId))
    throw worktreeError("call identifier is unsafe");
  const execute = options.execFile ?? defaultExecFile;
  if (typeof execute !== "function")
    throw worktreeError("Git executor is invalid");

  let canonicalSessionCwd: string;
  let canonicalRunDir: string;
  try {
    canonicalSessionCwd = await realpath(requestedCwd);
    canonicalRunDir = await realpath(requestedRunDir);
  } catch {
    throw worktreeError("worktree input path could not be resolved");
  }
  if (canonicalSessionCwd !== requestedCwd)
    throw worktreeError("canonical cwd is not canonical");

  const base =
    options.base === undefined
      ? await discoverBase(canonicalSessionCwd, execute)
      : captureBase(options.base);
  const canonicalBaseRoot = await realpath(base.repoRoot).catch(() => "");
  if (
    canonicalBaseRoot !== base.repoRoot ||
    !contains(canonicalBaseRoot, canonicalSessionCwd)
  )
    throw worktreeError("pinned Git base does not contain the canonical cwd");
  const { repoRoot, baseCommit } = base;

  const sourceRelative = relative(repoRoot, canonicalSessionCwd);
  if (
    isAbsolute(sourceRelative) ||
    sourceRelative === ".." ||
    sourceRelative.startsWith(`..${sep}`)
  )
    throw worktreeError("canonical cwd is outside the Git repository");

  const worktreesRoot = join(canonicalRunDir, "worktrees");
  try {
    await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(worktreesRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new TypeError();
  } catch {
    throw worktreeError("could not prepare the run worktree directory");
  }
  const canonicalWorktreesRoot = await realpath(worktreesRoot).catch(() => "");
  if (
    !canonicalWorktreesRoot ||
    !contains(canonicalRunDir, canonicalWorktreesRoot)
  )
    throw worktreeError("run worktree directory escaped its state directory");
  const target = join(canonicalWorktreesRoot, options.callId);
  if (
    !contains(canonicalWorktreesRoot, target) ||
    target === repoRoot ||
    contains(target, repoRoot)
  )
    throw worktreeError("isolated worktree target is unsafe");

  let created = false;
  try {
    await execute("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "--detach",
      target,
      baseCommit,
    ]);
    created = true;
    const canonicalTarget = await realpath(target);
    if (
      canonicalTarget !== target ||
      !contains(canonicalWorktreesRoot, canonicalTarget)
    )
      throw new TypeError();
    const mapped = join(canonicalTarget, sourceRelative);
    const mappedRealpath = await realpath(mapped);
    if (!contains(canonicalTarget, mappedRealpath)) throw new TypeError();

    let finished = false;
    const result: IsolatedWorktree = {
      repoRoot,
      baseCommit,
      path: canonicalTarget,
      cwd: mappedRealpath,
      cleanup: async (success) => {
        if (finished) return;
        finished = true;
        if (!success) {
          await retained(
            canonicalTarget,
            "agent did not complete successfully",
            options.onRetained,
          );
          return;
        }
        let status: WorktreeExecResult;
        try {
          status = await execute("git", [
            "-C",
            canonicalTarget,
            "status",
            "--porcelain=v1",
            "-z",
          ]);
        } catch {
          await retained(
            canonicalTarget,
            "could not verify worktree cleanliness",
            options.onRetained,
          );
          return;
        }
        if (status.stdout.length > 0) {
          await retained(
            canonicalTarget,
            "worktree contains changes",
            options.onRetained,
          );
          return;
        }
        try {
          await execute("git", [
            "-C",
            repoRoot,
            "worktree",
            "remove",
            canonicalTarget,
          ]);
        } catch {
          await retained(
            canonicalTarget,
            "could not remove clean worktree",
            options.onRetained,
          );
        }
      },
    };
    return Object.freeze(result);
  } catch {
    if (created)
      await execute("git", [
        "-C",
        repoRoot,
        "worktree",
        "remove",
        target,
      ]).catch(() => {});
    throw worktreeError("could not create an isolated Git worktree");
  }
}
