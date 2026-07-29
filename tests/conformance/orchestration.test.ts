import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, expect, test } from "vitest";

import { projectId } from "../../src/cli/state.js";
import { FileRunStore } from "../../src/store/run-store.js";

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const cli = join(repositoryRoot, "dist", "cli", "main.js");
const workflow = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "workflows",
  "orchestration-19.js",
);
const fakeCodex = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "bin",
  "fake-codex-orchestration.mjs",
);
const expectedLabels = [
  "prepare-1",
  "prepare-2",
  "shard-1",
  "shard-2",
  "shard-3",
  "join-1",
  "summary-1",
  "summary-2",
  "summary-3",
  "summary-4",
  "summary-5",
  "summary-6",
  "prepare-3",
  "write-1",
  "lint-1",
  "rewrite-1",
  "persist-1",
  "commit-1",
  "commit-2",
].sort();
const expectedPhaseCounts = {
  setup: 2,
  summarize: 10,
  finalize: 5,
  commit: 2,
};

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execute(
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("orchestration conformance timed out"));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

function eventsFrom(execution: ProcessResult): Record<string, unknown>[] {
  if (execution.code !== 0)
    throw new Error(
      `orchestration fixture failed: ${JSON.stringify(execution)}`,
    );
  expect(execution).toMatchObject({ code: 0, stderr: "" });
  const events = execution.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    events.every(
      (event) =>
        event.version === 1 &&
        typeof event.type === "string" &&
        typeof event.runId === "string",
    ),
  ).toBe(true);
  return events;
}

function assertCallProfile(
  events: readonly Record<string, unknown>[],
  expectedPhaseCounts: Record<string, number>,
  labels?: readonly string[],
): void {
  const scheduled = events.filter((event) => event.type === "call.scheduled");
  const started = events.filter((event) => event.type === "call.started");
  const completed = events.filter((event) => event.type === "call.completed");
  expect(scheduled).toHaveLength(19);
  expect(started).toHaveLength(19);
  expect(completed).toHaveLength(19);
  expect(
    events.filter(
      (event) => event.type === "call.failed" || event.type === "call.reused",
    ),
  ).toHaveLength(0);
  if (labels)
    expect(
      scheduled.map((event) => (event.data as { label?: string }).label).sort(),
    ).toEqual(labels);
  expect(
    Object.fromEntries(
      ["setup", "summarize", "finalize", "commit"].map((phase) => [
        phase,
        scheduled.filter(
          (event) => (event.data as { phase?: string }).phase === phase,
        ).length,
      ]),
    ),
  ).toEqual(expectedPhaseCounts);
}

beforeAll(async () => {
  await chmod(fakeCodex, 0o755);
});

test("executes an independently authored 19-call orchestration profile", async () => {
  const fakeSource = await readFile(fakeCodex, "utf8");
  expect(fakeSource).not.toMatch(
    /node:child_process|node:http|node:https|node:net|fetch\s*\(/u,
  );

  const root = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-orchestration-conformance-")),
  );
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const sentinel = join(root, "must-not-exist");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  expect(await absent(sentinel)).toBe(true);
  expect(await readdir(cwd)).toEqual([]);

  try {
    const execution = await execute(
      [
        workflow,
        "--provider",
        "codex",
        "--args",
        '{"fixture":"AWSL_ORCHESTRATION_19"}',
        "--format",
        "jsonl",
      ],
      {
        cwd,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: root,
          AWSL_CODEX_COMMAND: fakeCodex,
          AWSL_STATE_DIR: stateDir,
          CODEX_HOME: join(root, "codex-home"),
          CLAUDE_CONFIG_DIR: join(root, "claude-home"),
        },
      },
    );
    const events = eventsFrom(execution);
    assertCallProfile(events, expectedPhaseCounts, expectedLabels);
    const terminal = events.at(-1) as {
      type?: string;
      runId?: string;
      data?: {
        result?: { profile?: string; status?: string };
        metrics?: {
          agentCount?: number;
          outputTokens?: number;
          attemptOutputTokens?: number;
          usageComplete?: boolean;
        };
      };
    };
    expect(terminal).toMatchObject({
      type: "run.completed",
      data: {
        result: { profile: "orchestration-19", status: "ok" },
        metrics: {
          agentCount: 19,
          outputTokens: 19,
          attemptOutputTokens: 19,
          usageComplete: true,
        },
      },
    });
    expect(await absent(sentinel)).toBe(true);
    expect(await readdir(cwd)).toEqual([]);

    const store = await FileRunStore.openExisting({
      root: join(stateDir, "projects", projectId(cwd), "runs"),
      runId: terminal.runId as string,
    });
    await expect(store.readRun()).resolves.toMatchObject({
      status: "completed",
      providerPin: {
        provider: "codex",
        executableRealpath: await realpath(fakeCodex),
      },
      metrics: {
        agentCount: 19,
        outputTokens: 19,
        usageComplete: true,
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 75_000);
