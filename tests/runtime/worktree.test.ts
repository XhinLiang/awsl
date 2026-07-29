import { execFile as nodeExecFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  type WorktreeExec,
  createIsolatedWorktree,
  resolveGitWorktreeBase,
} from "../../src/runtime/worktree.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return result.stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "awsl-worktree-"));
  roots.push(root);
  const repo = join(root, "repo");
  const nested = join(repo, "packages", "app");
  const runDir = join(root, "state", "run-1");
  await mkdir(nested, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "awsl@example.invalid");
  await git(repo, "config", "user.name", "awsl Test");
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(join(nested, "tracked.txt"), "tracked\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  return { nested: await realpath(nested), repo: await realpath(repo), runDir };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("isolated Git worktrees", () => {
  test("pins detached HEAD, maps a nested cwd, and removes clean success", async () => {
    const value = await fixture();
    const isolated = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "call-1",
    });

    expect(isolated.repoRoot).toBe(value.repo);
    expect(isolated.cwd).toBe(join(isolated.path, "packages", "app"));
    expect((await git(isolated.path, "rev-parse", "HEAD")).trim()).toBe(
      isolated.baseCommit,
    );
    expect(
      (await git(isolated.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("HEAD");

    await isolated.cleanup(true);
    await expect(access(isolated.path)).rejects.toThrow();
  });

  test("uses a run-start base even if the source checkout advances later", async () => {
    const value = await fixture();
    const base = await resolveGitWorktreeBase({
      canonicalCwd: value.nested,
    });
    await writeFile(join(value.repo, "README.md"), "advanced\n");
    await git(value.repo, "add", "README.md");
    await git(value.repo, "commit", "-m", "advance");
    expect((await git(value.repo, "rev-parse", "HEAD")).trim()).not.toBe(
      base.baseCommit,
    );

    const isolated = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "pinned-base",
      base,
    });
    expect((await git(isolated.path, "rev-parse", "HEAD")).trim()).toBe(
      base.baseCommit,
    );
    await isolated.cleanup(true);
  });

  test("retains dirty, failed, and cancelled worktrees with bounded reasons", async () => {
    const value = await fixture();
    const retained: Array<{ path: string; reason: string }> = [];

    const dirty = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "dirty",
      onRetained: async (event) => {
        retained.push(event);
      },
    });
    await writeFile(join(dirty.cwd, "untracked.txt"), "keep me");
    await dirty.cleanup(true);
    await expect(access(dirty.path)).resolves.toBeUndefined();

    const failed = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "failed",
      onRetained: async (event) => {
        retained.push(event);
      },
    });
    await failed.cleanup(false);
    await expect(access(failed.path)).resolves.toBeUndefined();

    expect(retained).toHaveLength(2);
    expect(retained[0]).toMatchObject({
      path: dirty.path,
      reason: "worktree contains changes",
    });
    expect(retained[1]).toMatchObject({
      path: failed.path,
      reason: "agent did not complete successfully",
    });
    expect(retained.every(({ reason }) => reason.length <= 512)).toBe(true);
  });

  test("uses argv-only Git operations and never force-removes a worktree", async () => {
    const value = await fixture();
    const recorded: string[][] = [];
    const delegate: WorktreeExec = async (file, args) => {
      recorded.push([file, ...args]);
      const result = await execFile(file, [...args], { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    const isolated = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "recorded",
      execFile: delegate,
    });
    await isolated.cleanup(true);

    expect(recorded).toEqual(
      expect.arrayContaining([
        ["git", "-C", value.nested, "rev-parse", "--show-toplevel"],
        ["git", "-C", value.repo, "rev-parse", "HEAD"],
        [
          "git",
          "-C",
          value.repo,
          "worktree",
          "add",
          "--detach",
          isolated.path,
          isolated.baseCommit,
        ],
        ["git", "-C", isolated.path, "status", "--porcelain=v1", "-z"],
        ["git", "-C", value.repo, "worktree", "remove", isolated.path],
      ]),
    );
    expect(recorded.flat()).not.toContain("--force");
  });

  test("fails closed outside Git and on unsafe call identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-worktree-invalid-"));
    roots.push(root);
    const runDir = join(root, "run");
    await mkdir(runDir);

    await expect(
      createIsolatedWorktree({
        canonicalCwd: root,
        runDir,
        callId: "not-git",
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
    await expect(
      createIsolatedWorktree({
        canonicalCwd: root,
        runDir,
        callId: "../escape",
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
  });

  test("retains the worktree when clean inspection or removal fails", async () => {
    const value = await fixture();
    const retained: Array<{ path: string; reason: string }> = [];
    let rejectStatus = true;
    const delegate: WorktreeExec = async (file, args) => {
      if (rejectStatus && args.includes("status")) {
        rejectStatus = false;
        throw new Error("secret inspection detail");
      }
      const result = await execFile(file, [...args], { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    const isolated = await createIsolatedWorktree({
      canonicalCwd: value.nested,
      runDir: value.runDir,
      callId: "inspection",
      execFile: delegate,
      onRetained: async (event) => {
        retained.push(event);
      },
    });

    await isolated.cleanup(true);

    await expect(access(isolated.path)).resolves.toBeUndefined();
    expect(retained).toEqual([
      {
        path: isolated.path,
        reason: "could not verify worktree cleanliness",
      },
    ]);
    expect(JSON.stringify(retained)).not.toContain("secret inspection detail");
  });
});
