import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";

const fakeCodex = fileURLToPath(
  new URL("../fixtures/bin/fake-codex.mjs", import.meta.url),
);

beforeAll(async () => {
  await chmod(fakeCodex, 0o755);
});

test("demo runs the bundled three-call workflow with a default 8k gate", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-demo-")));
  const log = join(cwd, "codex.log");
  let stdout = "";
  let stderr = "";
  try {
    const exitCode = await executeCli(
      ["demo", "Why make workflows durable?", "--format", "json"],
      {
        cwd,
        env: {
          ...process.env,
          AWSL_STATE_DIR: join(cwd, "state"),
          AWSL_CODEX_COMMAND: fakeCodex,
          AWSL_FAKE_CODEX_LOG: log,
          CODEX_HOME: join(cwd, "codex-home"),
        },
        homeDir: join(cwd, "home"),
        stdoutIsTTY: false,
        stdin: { isTTY: true, read: async () => "" },
        writeStdout: async (value) => {
          stdout += value;
        },
        writeStderr: async (value) => {
          stderr += value;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "completed",
      result: {
        topic: "Why make workflows durable?",
        answers: ["FAKE", "FAKE"],
        synthesis: "FAKE",
        budget: { total: 8000, spent: 3 },
      },
      budget: { total: 8000, spent: 3 },
    });
    expect((await readFile(log, "utf8")).trim().split("\n").sort()).toEqual([
      "run",
      "run",
      "run",
      "version",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
