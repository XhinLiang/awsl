import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";

const workflows = dirname(
  fileURLToPath(new URL("../fixtures/workflows/basic.js", import.meta.url)),
);

function memoryCli(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      cwd,
      env,
      homeDir: cwd,
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

describe("CLI workflow inspection", () => {
  test("inspects metadata without probing a provider or creating state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-inspect-"));
    const stateDir = join(cwd, "must-not-exist");
    const cli = memoryCli(cwd, {
      ...process.env,
      AWSL_STATE_DIR: stateDir,
      AWSL_CODEX_COMMAND: join(cwd, "must-not-run"),
    });

    await expect(
      executeCli(
        [
          "workflow",
          "inspect",
          join(workflows, "basic.js"),
          "--format",
          "json",
        ],
        cli.context,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      meta: { name: "basic", description: "basic workflow" },
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(cli.output().stderr).toBe("");
    await expect(access(stateDir)).rejects.toBeTruthy();
  });

  test("renders inspection as a versioned JSONL event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-inspect-"));
    const cli = memoryCli(cwd);
    expect(
      await executeCli(
        [
          "workflow",
          "inspect",
          join(workflows, "basic.js"),
          "--format",
          "jsonl",
        ],
        cli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      version: 1,
      type: "command.completed",
      data: {
        meta: { name: "basic" },
      },
    });
  });

  test("prints one safe validation diagnostic and exits 2", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-inspect-"));
    const invalid = join(cwd, "invalid.js");
    const secret = "INSPECT_SECRET_CANARY";
    await writeFile(invalid, `throw new Error("${secret}")`);
    const cli = memoryCli(cwd);

    await expect(
      executeCli(
        ["workflow", "inspect", invalid, "--format", "json"],
        cli.context,
      ),
    ).resolves.toBe(2);
    expect(cli.output().stdout).toBe("");
    expect(cli.output().stderr).toContain("COMPATIBILITY_ERROR");
    expect(cli.output().stderr).not.toContain(secret);
  });
});
