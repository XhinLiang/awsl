import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";

const fakeCodex = fileURLToPath(
  new URL("../fixtures/bin/fake-codex.mjs", import.meta.url),
);
const fakeClaude = fileURLToPath(
  new URL("../fixtures/bin/fake-claude.mjs", import.meta.url),
);

beforeAll(async () => {
  await chmod(fakeCodex, 0o755);
});

function memoryCli(cwd: string, env: NodeJS.ProcessEnv, stdoutIsTTY = false) {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      cwd,
      env,
      homeDir: cwd,
      stdoutIsTTY,
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

describe("CLI configuration and doctor commands", () => {
  test("shows merged configuration and provenance without ambient secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-config-"));
    const secret = "CONFIG_SECRET_CANARY";
    const cli = memoryCli(cwd, {
      ...process.env,
      AWSL_PROVIDER: "codex",
      AWSL_STATE_DIR: join(cwd, "state"),
      UNLISTED_SECRET: secret,
    });

    expect(
      await executeCli(["config", "show", "--format", "json"], cli.context),
    ).toBe(0);
    const shown = JSON.parse(cli.output().stdout);
    expect(shown.value).toMatchObject({
      provider: "codex",
      stateDir: join(cwd, "state"),
    });
    expect(shown.provenance["/provider"]).toMatchObject({
      layer: "env",
    });
    expect(cli.output().stdout).not.toContain(secret);
    expect(cli.output().stderr).toBe("");
  });

  test("renders static command results as pretty text or versioned JSONL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-config-"));
    const env = {
      ...process.env,
      AWSL_PROVIDER: "codex",
      AWSL_STATE_DIR: join(cwd, "state"),
    };
    const pretty = memoryCli(cwd, env, true);
    expect(
      await executeCli(
        ["config", "show", "--format", "pretty"],
        pretty.context,
      ),
    ).toBe(0);
    expect(pretty.output().stdout).toContain('\n  "provenance"');
    expect(pretty.output().stdout.trim()).not.toMatch(/^\{".*"\}$/);

    for (const argv of [
      ["config", "show"],
      ["config", "show", "--format", "jsonl"],
    ]) {
      const machine = memoryCli(cwd, env);
      expect(await executeCli(argv, machine.context)).toBe(0);
      expect(JSON.parse(machine.output().stdout)).toMatchObject({
        version: 1,
        type: "command.completed",
        runId: "cli",
        data: {
          value: { provider: "codex" },
        },
      });
      expect(machine.output().stderr).toBe("");
    }
  });

  test("doctor probes versions but never launches a model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-doctor-"));
    const log = join(cwd, "codex.log");
    const env = {
      ...process.env,
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_CLAUDE_COMMAND: fakeClaude,
      AWSL_FAKE_CODEX_LOG: log,
    };
    const cli = memoryCli(cwd, env);
    expect(await executeCli(["doctor", "--format", "json"], cli.context)).toBe(
      0,
    );
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      checks: {
        node: { available: true },
        git: { available: true },
        codex: { available: true, version: "0.145.0" },
        claude: { available: true, version: "2.1.218" },
      },
    });
    expect(await readFile(log, "utf8")).toBe("version\n");
  });

  test("doctor JSONL is one versioned command event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-doctor-"));
    const cli = memoryCli(cwd, {
      ...process.env,
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_CLAUDE_COMMAND: fakeClaude,
    });
    expect(await executeCli(["doctor", "--format", "jsonl"], cli.context)).toBe(
      0,
    );
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      version: 1,
      type: "command.completed",
      data: {
        checks: {
          node: { available: true },
          git: { available: true },
          codex: { available: true },
          claude: { available: true },
        },
      },
    });
  });

  test("doctor readiness follows the selected provider, not unused providers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-cli-doctor-"));
    const cli = memoryCli(cwd, {
      ...process.env,
      AWSL_PROVIDER: "codex",
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_FAKE_CODEX_VERSION: "0.146.1",
      AWSL_CLAUDE_COMMAND: join(cwd, "missing-claude"),
    });
    expect(await executeCli(["doctor", "--format", "json"], cli.context)).toBe(
      0,
    );
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      status: "ok",
      selectedProvider: "codex",
      checks: {
        codex: { available: true, version: "0.146.1", support: "unverified" },
        claude: { available: false },
      },
    });
  });
});
