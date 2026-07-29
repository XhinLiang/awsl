import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { parseResume, resolveArgsInput } from "../../src/cli/args.js";
import { executeCli } from "../../src/cli/commands.js";
import { projectId } from "../../src/cli/state.js";
import { canonicalJson } from "../../src/core/canonical-json.js";
import { journalKeyV2 } from "../../src/store/canonical-json.js";
import { FileRunStore } from "../../src/store/run-store.js";

const roots: string[] = [];
const workflows = dirname(
  fileURLToPath(new URL("../fixtures/workflows/args.js", import.meta.url)),
);
const fakeCodex = fileURLToPath(
  new URL("../fixtures/bin/fake-codex.mjs", import.meta.url),
);

beforeAll(async () => {
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function cliContext(cwd: string, env: NodeJS.ProcessEnv) {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      cwd,
      env,
      homeDir: join(cwd, "home"),
      stdoutIsTTY: false,
      stdin: { isTTY: true, read: async () => "" },
      writeStdout: async (value: string) => {
        stdout += value;
      },
      writeStderr: async (value: string) => {
        stderr += value;
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("CLI resume and argument inputs", () => {
  test("accepts replacement args and budget but rejects pinned overrides", () => {
    expect(
      parseResume(["wf_test", "--args", '{"v":2}', "--budget", "1000"]),
    ).toMatchObject({
      runId: "wf_test",
      args: { v: 2 },
      argsPresent: true,
      budget: 1000,
    });
    expect(
      parseResume([
        "wf_test",
        '--args={"v":3}',
        "--budget=2000",
        "--format=json",
      ]),
    ).toMatchObject({
      runId: "wf_test",
      args: { v: 3 },
      budget: 2000,
      format: "json",
    });

    for (const argv of [
      ["wf_test", "--provider", "claude"],
      ["wf_test", "--provider=claude"],
      ["wf_test", "--cwd", "/other"],
      ["wf_test", "--cwd=/other"],
      ["wf_test", "--profile", "other"],
      ["wf_test", "--model", "other"],
    ])
      expect(() => parseResume(argv)).toThrowError(/pinned/i);
  });

  test("marks args-file as an explicit replacement without reading it yet", () => {
    expect(parseResume(["wf_test", "--args-file", "next.json"])).toEqual({
      runId: "wf_test",
      argsPresent: true,
      argsFile: "next.json",
    });
  });

  test("rejects malformed budgets and duplicate JSON keys", () => {
    for (const budget of ["-1", "1.5", "9007199254740992", "1e3"])
      expect(() => parseResume(["wf_test", "--budget", budget])).toThrowError(
        expect.objectContaining({
          code: "USAGE_ERROR",
          recoverable: false,
        }),
      );
    expect(() =>
      parseResume(["wf_test", "--args", '{"v":1,"v":2}']),
    ).toThrowError(
      expect.objectContaining({
        code: "USAGE_ERROR",
        recoverable: false,
      }),
    );
  });

  test("counts non-TTY stdin only when it contains non-whitespace bytes", async () => {
    await expect(
      resolveArgsInput({
        cwd: process.cwd(),
        argsText: '{"value":7}',
        stdin: { isTTY: false, read: async () => " \n\t" },
      }),
    ).resolves.toEqual({ present: true, value: { value: 7 } });

    await expect(
      resolveArgsInput({
        cwd: process.cwd(),
        argsText: '{"value":7}',
        stdin: { isTTY: false, read: async () => '{"other":8}' },
      }),
    ).rejects.toMatchObject({
      code: "USAGE_ERROR",
      message: "workflow argument sources are mutually exclusive",
    });

    await expect(
      resolveArgsInput({
        cwd: process.cwd(),
        stdin: { isTTY: false, read: async () => " \n\t" },
      }),
    ).resolves.toEqual({ present: false });
  });

  test("reads one bounded args file or explicit stdin marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-cli-args-"));
    roots.push(root);
    const path = join(root, "args.json");
    await writeFile(path, '{"from":"file"}');

    await expect(
      resolveArgsInput({
        cwd: root,
        argsFile: path,
        stdin: { isTTY: true, read: async () => "" },
      }),
    ).resolves.toEqual({ present: true, value: { from: "file" } });
    await expect(
      resolveArgsInput({
        cwd: root,
        argsFile: "-",
        stdin: { isTTY: true, read: async () => '{"from":"stdin"}' },
      }),
    ).resolves.toEqual({ present: true, value: { from: "stdin" } });
  });
});

describe("CLI durable resume", () => {
  test("runs list defaults piped output to a versioned JSONL event", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-cli-list-")));
    roots.push(cwd);
    const cli = cliContext(cwd, {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "missing-state"),
    });
    expect(await executeCli(["runs", "list"], cli.context)).toBe(0);
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      version: 1,
      type: "command.completed",
      data: { runs: [] },
    });
  });

  test("resumes with replacement args and budget, then exposes list/show state", async () => {
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "awsl-cli-resume-")),
    );
    roots.push(cwd);
    const log = join(cwd, "codex.log");
    const env = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_FAKE_CODEX_LOG: log,
      CODEX_HOME: join(cwd, "codex-home"),
    };
    const first = cliContext(cwd, env);
    expect(
      await executeCli(
        [
          join(workflows, "args.js"),
          "--args",
          '{"value":1}',
          "--budget",
          "10",
          "--format",
          "json",
        ],
        first.context,
      ),
    ).toBe(0);
    const runId = JSON.parse(first.output().stdout).runId as string;

    const resumed = cliContext(cwd, env);
    expect(
      await executeCli(
        [
          "resume",
          runId,
          "--args",
          '{"value":2}',
          "--budget",
          "20",
          "--format",
          "json",
        ],
        resumed.context,
      ),
    ).toBe(0);
    expect(JSON.parse(resumed.output().stdout)).toMatchObject({
      runId,
      status: "completed",
      result: { value: 2 },
      budget: { total: 20, spent: 0 },
    });

    const listed = cliContext(cwd, env);
    expect(
      await executeCli(["runs", "list", "--format", "json"], listed.context),
    ).toBe(0);
    expect(JSON.parse(listed.output().stdout).runs).toContainEqual(
      expect.objectContaining({
        runId,
        status: "completed",
        attemptSeq: 1,
      }),
    );

    const shown = cliContext(cwd, env);
    expect(
      await executeCli(
        ["runs", "show", runId, "--format", "json"],
        shown.context,
      ),
    ).toBe(0);
    expect(JSON.parse(shown.output().stdout)).toMatchObject({
      run: {
        runId,
        status: "completed",
        attempt: { seq: 1 },
        args: { value: 2 },
      },
      result: {
        status: "completed",
        result: { value: 2 },
      },
    });

    const shownJsonl = cliContext(cwd, env);
    expect(
      await executeCli(
        ["runs", "show", runId, "--format", "jsonl"],
        shownJsonl.context,
      ),
    ).toBe(0);
    expect(JSON.parse(shownJsonl.output().stdout)).toMatchObject({
      version: 1,
      type: "command.completed",
      data: {
        run: { runId, status: "completed" },
        result: { status: "completed" },
      },
    });
    expect(await readFile(log, "utf8")).toBe("version\nversion\n");
  });

  test("rejects executable drift before a resumed attempt starts", async () => {
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "awsl-cli-resume-")),
    );
    roots.push(cwd);
    const otherCodex = join(cwd, "other-codex.mjs");
    await copyFile(fakeCodex, otherCodex);
    await chmod(otherCodex, 0o755);
    const baseEnv = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CODEX_COMMAND: fakeCodex,
      CODEX_HOME: join(cwd, "codex-home"),
    };
    const first = cliContext(cwd, baseEnv);
    expect(
      await executeCli(
        [
          join(workflows, "args.js"),
          "--args",
          '{"value":1}',
          "--format",
          "json",
        ],
        first.context,
      ),
    ).toBe(0);
    const runId = JSON.parse(first.output().stdout).runId as string;

    const drifted = cliContext(cwd, {
      ...baseEnv,
      AWSL_CODEX_COMMAND: otherCodex,
    });
    expect(
      await executeCli(
        ["resume", runId, "--args", '{"value":2}', "--format", "json"],
        drifted.context,
      ),
    ).toBe(2);
    expect(drifted.output().stdout).toBe("");
    expect(drifted.output().stderr).toContain("CONFIG_ERROR");
  });

  test("still warns on resume after runs list repaired an orphan", async () => {
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "awsl-cli-orphan-")),
    );
    roots.push(cwd);
    const stateDir = join(cwd, "state");
    const env = {
      ...process.env,
      AWSL_STATE_DIR: stateDir,
      AWSL_CODEX_COMMAND: fakeCodex,
      CODEX_HOME: join(cwd, "codex-home"),
    };
    const first = cliContext(cwd, env);
    expect(
      await executeCli(
        [
          join(workflows, "args.js"),
          "--args",
          '{"value":1}',
          "--format",
          "json",
        ],
        first.context,
      ),
    ).toBe(0);
    const runId = JSON.parse(first.output().stdout).runId as string;
    const store = await FileRunStore.openExisting({
      root: join(stateDir, "projects", projectId(cwd), "runs"),
      runId,
    });
    const snapshot = await store.readRun();
    const stalePid = 2_147_483_647;
    const staleOwner = {
      nonce: "orphaned-lock",
      pid: stalePid,
      processStartIdentity: "orphaned-start",
    };
    const lock = await store.acquireRunLock(staleOwner);
    await store.writeRun({
      ...snapshot,
      status: "running",
      process: staleOwner,
    });
    const key = journalKeyV2({ previousKey: "", prompt: "orphaned-call" });
    const call = {
      version: 1 as const,
      kind: "call" as const,
      runId,
      attemptId: (snapshot.attempt as { id: string }).id,
      attemptSeq: (snapshot.attempt as { seq: number }).seq,
      callSeq: 0,
      callId: "orphaned-call",
      key,
      previousKey: "",
    };
    await store.appendCall({ ...call, state: "scheduled" });
    await store.appendCall({ ...call, state: "started" });
    await lock.release();
    await writeFile(
      store.paths.lock,
      canonicalJson({
        version: 1,
        ...staleOwner,
        acquiredAt: new Date(0).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );

    const listed = cliContext(cwd, env);
    expect(
      await executeCli(["runs", "list", "--format", "json"], listed.context),
    ).toBe(0);
    expect(JSON.parse(listed.output().stdout).runs).toContainEqual(
      expect.objectContaining({
        runId,
        status: "killed",
        atLeastOnce: true,
      }),
    );

    const resumed = cliContext(cwd, env);
    expect(
      await executeCli(["resume", runId, "--format", "json"], resumed.context),
    ).toBe(0);
    expect(resumed.output().stderr).toContain("PERSISTENCE_WARNING");
    expect(JSON.parse(resumed.output().stdout)).toMatchObject({
      runId,
      status: "completed",
    });
  });
});
