import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";
import { createOutputController } from "../../src/cli/output.js";
import { createEvent } from "../../src/core/events.js";

const workflows = dirname(
  fileURLToPath(new URL("../fixtures/workflows/args.js", import.meta.url)),
);
const fakeCodex = fileURLToPath(
  new URL("../fixtures/bin/fake-codex.mjs", import.meta.url),
);
const fakeClaude = fileURLToPath(
  new URL("../fixtures/bin/fake-claude.mjs", import.meta.url),
);

beforeAll(async () => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClaude, 0o755)]);
});

function output(format: "pretty" | "json" | "jsonl") {
  let stdout = "";
  let stderr = "";
  return {
    controller: createOutputController({
      format,
      stdoutIsTTY: false,
      writeStdout: (value) => {
        stdout += value;
      },
      writeStderr: (value) => {
        stderr += value;
      },
    }),
    read: () => ({ stdout, stderr }),
  };
}

function cliContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { stdin?: string; stdinIsTTY?: boolean } = {},
) {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      cwd,
      env,
      homeDir: join(cwd, "home"),
      stdoutIsTTY: false,
      stdin: {
        isTTY: options.stdinIsTTY ?? true,
        read: async () => options.stdin ?? "",
      },
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

describe("CLI output modes", () => {
  test("JSON emits one final envelope and no progress records", async () => {
    const value = output("json");
    await value.controller.event(
      createEvent("run.started", "wf_test", { attemptSeq: 0 }),
    );
    await value.controller.complete({
      runId: "wf_test",
      status: "completed",
      result: { value: 7 },
    });

    expect(value.read().stderr).toBe("");
    expect(JSON.parse(value.read().stdout)).toEqual({
      runId: "wf_test",
      status: "completed",
      result: { value: 7 },
    });
    expect(value.read().stdout.endsWith("\n")).toBe(true);
  });

  test("JSONL emits only versioned events", async () => {
    const value = output("jsonl");
    const event = createEvent("run.started", "wf_test", { attemptSeq: 0 });
    await value.controller.event(event);
    await value.controller.complete({
      runId: "wf_test",
      status: "completed",
      result: { value: 7 },
    });

    expect(value.read().stderr).toBe("");
    expect(
      value
        .read()
        .stdout.trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([event]);
  });

  test("pretty writes progress to stderr and the business result to stdout", async () => {
    const value = output("pretty");
    await value.controller.event(
      createEvent("workflow.log", "wf_test", {
        level: "info",
        message: "collecting",
      }),
    );
    await value.controller.complete({
      runId: "wf_test",
      status: "completed",
      result: { value: 7 },
    });

    expect(value.read().stderr).toContain("collecting");
    expect(JSON.parse(value.read().stdout)).toEqual({ value: 7 });
  });

  test("defensively redacts event output while preserving business results", async () => {
    const secret = "CLI_EVENT_SECRET";
    const value = output("jsonl");
    await value.controller.event(
      createEvent("workflow.log", "wf_test", {
        message: `Authorization: Bearer ${secret}`,
      }),
    );
    await value.controller.complete({
      runId: "wf_test",
      status: "completed",
      result: { token: secret },
    });

    expect(value.read().stdout).not.toContain(secret);
    expect(value.read().stdout).toContain("[REDACTED]");

    const business = output("json");
    await business.controller.complete({
      runId: "wf_test",
      status: "completed",
      result: { token: secret },
    });
    expect(JSON.parse(business.read().stdout).result).toEqual({
      token: secret,
    });
  });

  test("auto resolves from stdout TTY state", () => {
    expect(
      createOutputController({
        format: "auto",
        stdoutIsTTY: true,
        writeStdout: () => {},
        writeStderr: () => {},
      }).format,
    ).toBe("pretty");
    expect(
      createOutputController({
        format: "auto",
        stdoutIsTTY: false,
        writeStdout: () => {},
        writeStderr: () => {},
      }).format,
    ).toBe("jsonl");
  });
});

describe("CLI workflow execution", () => {
  test("supports the leading workflow form with JSON args and durable JSON output", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-cli-run-")));
    const log = join(cwd, "codex.log");
    const env = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_FAKE_CODEX_LOG: log,
      CODEX_HOME: join(cwd, "codex-home"),
    };
    const cli = cliContext(cwd, env);
    expect(
      await executeCli(
        [
          join(workflows, "args.js"),
          "--args",
          '{"value":7}',
          "--format",
          "json",
        ],
        cli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(cli.output().stdout)).toMatchObject({
      runId: expect.stringMatching(/^wf-/),
      status: "completed",
      result: { value: 7 },
    });
    expect(cli.output().stderr).toBe("");
    expect(await readFile(log, "utf8")).toBe("version\n");
  });

  test("runs a real Codex JSONL protocol fixture and includes result in completion", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-cli-run-")));
    const log = join(cwd, "codex.log");
    const env = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_FAKE_CODEX_LOG: log,
      CODEX_HOME: join(cwd, "codex-home"),
    };
    const cli = cliContext(cwd, env);
    expect(
      await executeCli(
        [
          "run",
          join(workflows, "nested", "basic-agent.js"),
          "--args",
          '{"prompt":"hello"}',
          "--format",
          "jsonl",
        ],
        cli.context,
      ),
    ).toBe(0);
    const events = cli
      .output()
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.every((event) => event.version === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      data: {
        status: "completed",
        result: { answer: "FAKE", requestedStatus: "failed" },
      },
    });
    expect(await readFile(log, "utf8")).toBe("version\nrun\n");
  });

  test("passes the CLI context environment to the Claude provider process", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-cli-run-")));
    const capture = join(cwd, "claude-capture.jsonl");
    const ambientCapture = process.env.AWSL_FAKE_CLAUDE_CAPTURE;
    const env = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CLAUDE_COMMAND: fakeClaude,
      AWSL_FAKE_CLAUDE_CAPTURE: capture,
      CLAUDE_CONFIG_DIR: join(cwd, "claude-config"),
    };
    const cli = cliContext(cwd, env);

    expect(
      await executeCli(
        [
          "run",
          join(workflows, "nested", "basic-agent.js"),
          "--provider",
          "claude",
          "--args",
          '{"prompt":"fixture:success"}',
          "--format",
          "jsonl",
        ],
        cli.context,
      ),
    ).toBe(0);

    const events = cli
      .output()
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      data: {
        status: "completed",
        result: {
          answer: "ok",
          requestedStatus: "failed",
        },
      },
    });
    const invocation = JSON.parse((await readFile(capture, "utf8")).trim());
    expect(invocation.prompt).toBe("fixture:success");
    expect(invocation.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
      ]),
    );
    expect(process.env.AWSL_FAKE_CLAUDE_CAPTURE).toBe(ambientCapture);
  });

  test("routes a named Codex agent to its native TOML policy on Codex CLI 0.146.0", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "awsl-cli-run-")));
    const codexHome = join(cwd, "codex-home");
    const claudeConfigDir = join(cwd, "claude-config");
    const workflow = join(cwd, "named-agent.js");
    const log = join(cwd, "codex.log");
    const capture = join(cwd, "codex-capture.jsonl");
    await Promise.all([
      mkdir(join(codexHome, "agents"), { recursive: true }),
      mkdir(join(claudeConfigDir, "agents"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(codexHome, "agents", "audit-worker.toml"),
        [
          'name = "audit-worker"',
          'description = "Native audit worker"',
          'developer_instructions = "CODEX_NATIVE_AUDIT_MARKER"',
          'model = "gpt-5.5"',
          'model_reasoning_effort = "xhigh"',
          'sandbox_mode = "read-only"',
          "",
        ].join("\n"),
      ),
      writeFile(
        join(claudeConfigDir, "agents", "audit-worker.md"),
        [
          "---",
          "name: audit-worker",
          "description: Foreign audit worker",
          "model: claude-opus-foreign",
          "---",
          "CLAUDE_FOREIGN_AUDIT_MARKER",
          "",
        ].join("\n"),
      ),
      writeFile(
        workflow,
        [
          "export const meta = {",
          '  name: "named-codex-agent",',
          '  description: "Run one named agent",',
          "}",
          "",
          'return await agent("native agent prompt", { agentType: "audit-worker" })',
          "",
        ].join("\n"),
      ),
    ]);
    const env = {
      ...process.env,
      AWSL_STATE_DIR: join(cwd, "state"),
      AWSL_CODEX_COMMAND: fakeCodex,
      AWSL_FAKE_CODEX_LOG: log,
      AWSL_FAKE_CODEX_CAPTURE: capture,
      AWSL_FAKE_CODEX_VERSION: "0.146.0",
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
    const cli = cliContext(cwd, env);
    const ambientVersion = process.env.AWSL_FAKE_CODEX_VERSION;
    expect(
      await executeCli(
        ["run", workflow, "--provider", "codex", "--format", "jsonl"],
        cli.context,
      ),
    ).toBe(0);

    const events = cli
      .output()
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      data: { status: "completed", result: "FAKE" },
    });
    const invocation = JSON.parse((await readFile(capture, "utf8")).trim());
    expect(invocation.argv).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--sandbox",
      "read-only",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-",
    ]);
    expect(invocation.prompt).toContain("CODEX_NATIVE_AUDIT_MARKER");
    expect(invocation.prompt).not.toContain("CLAUDE_FOREIGN_AUDIT_MARKER");
    expect(invocation.argv).not.toContain("claude-opus-foreign");
    expect(await readFile(log, "utf8")).toBe("version\nrun\n");
    expect(process.env.AWSL_FAKE_CODEX_VERSION).toBe(ambientVersion);
  });
});
