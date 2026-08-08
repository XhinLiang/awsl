import { describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";

function memoryCli() {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      cwd: process.cwd(),
      env: process.env,
      homeDir: process.cwd(),
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

describe("CLI help", () => {
  test.each([
    [[], "Start here:"],
    [["help"], "Start here:"],
    [["help", "run"], "Arguments:"],
    [["run", "--help"], "Arguments:"],
    [["help", "resume"], "longest valid journal prefix"],
    [["help", "runs"], "current project"],
    [["help", "runs", "list"], "whether interrupted work"],
    [["help", "runs", "show"], "terminal result"],
    [["help", "runs", "pause"], "durable confirmation"],
    [["help", "doctor"], "without invoking a model"],
    [["help", "config"], "Configuration precedence"],
    [["help", "config", "show"], "per-field provenance"],
    [["help", "workflow"], "normalized awsl Workflow ABI"],
    [["help", "workflow", "inspect"], "No provider or model is invoked"],
  ] as const)("renders %j successfully", async (argv, expected) => {
    const cli = memoryCli();
    await expect(executeCli(argv, cli.context)).resolves.toBe(0);
    expect(cli.output().stdout).toContain(expected);
    expect(cli.output().stderr).toBe("");
  });

  test("documents the agent-relevant run contract", async () => {
    const cli = memoryCli();
    expect(await executeCli(["help", "run"], cli.context)).toBe(0);
    expect(cli.output().stdout).toContain(
      "--args, --args-file, and non-empty piped stdin are mutually exclusive",
    );
    expect(cli.output().stdout).toContain("A run uses one provider");
    expect(cli.output().stdout).toContain("awsl review.js");
  });

  test("summarizes the JavaScript Workflow ABI without external docs", async () => {
    const cli = memoryCli();
    expect(await executeCli(["help"], cli.context)).toBe(0);
    expect(cli.output().stdout).toContain("export const meta");
    expect(cli.output().stdout).toContain(
      "args, agent, parallel, pipeline, phase, log",
    );
  });

  test("documents user-level Codex skill installation", async () => {
    const cli = memoryCli();
    expect(await executeCli(["--help"], cli.context)).toBe(0);
    expect(cli.output().stdout).toContain("--install-skills");
    expect(cli.output().stdout).toContain("~/.agents/skills");
  });

  test("rejects unknown nested commands even when help is requested", async () => {
    const cli = memoryCli();
    expect(
      await executeCli(["runs", "frobnicate", "--help"], cli.context),
    ).toBe(2);
    expect(cli.output().stdout).toBe("");
    expect(cli.output().stderr).toBe("USAGE_ERROR: invalid command line\n");
  });
});
