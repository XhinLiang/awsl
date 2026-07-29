import {
  type ChildProcess,
  execFile as nodeExecFile,
  spawn,
} from "node:child_process";
import { access, chmod, mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, test } from "vitest";

import { projectId } from "../../src/cli/state.js";
import { FileRunStore } from "../../src/store/run-store.js";

const execFile = promisify(nodeExecFile);
const repository = dirname(
  dirname(dirname(fileURLToPath(new URL(import.meta.url)))),
);
const main = join(repository, "dist", "cli", "main.js");
const workflow = join(
  repository,
  "tests",
  "fixtures",
  "workflows",
  "nested",
  "basic-agent.js",
);
const fakeCodex = join(
  repository,
  "tests",
  "fixtures",
  "bin",
  "fake-codex.mjs",
);

beforeAll(async () => {
  await chmod(fakeCodex, 0o755);
});

class EventCollector {
  readonly events: Array<Record<string, unknown>> = [];
  readonly stderr: string[] = [];
  readonly closed: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  #buffer = "";
  #waiters = new Set<{
    type: string;
    resolve: (event: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(readonly child: ChildProcess) {
    this.closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI process did not exit"));
      }, 15_000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      while (this.#buffer.includes("\n")) {
        const index = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        this.events.push(event);
        for (const waiter of [...this.#waiters]) {
          if (event.type !== waiter.type) continue;
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
    });
    child.once("close", () => {
      for (const waiter of this.#waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`process closed before ${waiter.type}`));
      }
      this.#waiters.clear();
    });
  }

  wait(type: string): Promise<Record<string, unknown>> {
    const existing = this.events.find((event) => event.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${type}`));
        }, 15_000),
      };
      this.#waiters.add(waiter);
    });
  }
}

async function waitForStartedRun(runsRoot: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      for (const runId of await readdir(runsRoot)) {
        const store = await FileRunStore.openExisting({
          root: runsRoot,
          runId,
        });
        if (
          (await store.loadJournal()).some(
            (record) => record.kind === "call" && record.state === "started",
          )
        )
          return runId;
      }
    } catch {
      // The run hierarchy and its first durable journal record are created
      // asynchronously by the child process.
    }
    await delay(25);
  }
  throw new Error("timed out waiting for a durable started call");
}

async function startLongRun(format: "json" | "jsonl" = "jsonl") {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-cli-process-")),
  );
  const stateDir = join(cwd, "state");
  const env = {
    ...process.env,
    AWSL_STATE_DIR: stateDir,
    AWSL_CODEX_COMMAND: fakeCodex,
    AWSL_FAKE_CODEX_DELAY_MS: "30000",
    CODEX_HOME: join(cwd, "codex-home"),
  };
  const child = spawn(
    process.execPath,
    [main, workflow, "--args", '{"prompt":"hello"}', "--format", format],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collector = new EventCollector(child);
  const runsRoot = join(stateDir, "projects", projectId(cwd), "runs");
  const runId =
    format === "jsonl"
      ? ((await collector.wait("call.started")).runId as string)
      : await waitForStartedRun(runsRoot);
  return { child, collector, cwd, env, runId, runsRoot };
}

describe("CLI cooperative process termination", () => {
  for (const [signal, expectedExit] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    for (const format of ["jsonl", "json"] as const)
      test(`${signal} persists killed and exits ${expectedExit} in ${format}`, async () => {
        const run = await startLongRun(format);
        run.child.kill(signal);
        await expect(run.collector.closed).resolves.toEqual({
          code: expectedExit,
          signal: null,
        });

        const store = await FileRunStore.openExisting({
          root: run.runsRoot,
          runId: run.runId,
        });
        await expect(store.readRun()).resolves.toMatchObject({
          status: "killed",
        });
        await expect(store.readResult()).resolves.toMatchObject({
          status: "killed",
          error: { code: "CANCELLED" },
        });
        expect((await store.loadJournal()).at(-1)).toMatchObject({
          state: "indeterminate",
        });
        await expect(access(store.paths.lock)).rejects.toBeTruthy();
        if (format === "jsonl")
          expect(run.collector.events.at(-1)).toMatchObject({
            type: "run.killed",
          });
        else
          expect(run.collector.events).toEqual([
            expect.objectContaining({
              runId: run.runId,
              status: "killed",
            }),
          ]);
      }, 25_000);

  test("runs pause verifies the owner and waits for a durable paused run", async () => {
    const run = await startLongRun();
    const paused = await execFile(
      process.execPath,
      [main, "runs", "pause", run.runId, "--format", "json"],
      {
        cwd: run.cwd,
        env: run.env,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      },
    );
    expect(JSON.parse(paused.stdout)).toEqual({
      runId: run.runId,
      status: "paused",
    });
    await expect(run.collector.closed).resolves.toEqual({
      code: 0,
      signal: null,
    });

    const store = await FileRunStore.openExisting({
      root: run.runsRoot,
      runId: run.runId,
    });
    await expect(store.readRun()).resolves.toMatchObject({
      status: "paused",
    });
    await expect(store.readResult()).resolves.toMatchObject({
      status: "paused",
      error: { code: "CANCELLED" },
    });
    await expect(access(store.paths.lock)).rejects.toBeTruthy();
    expect(run.collector.events.at(-1)).toMatchObject({
      type: "run.paused",
    });
  }, 25_000);

  test("JSON mode writes one durable failure envelope before its diagnostic", async () => {
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "awsl-cli-failure-")),
    );
    const child = spawn(
      process.execPath,
      [main, workflow, "--args", '{"prompt":"hello"}', "--format", "json"],
      {
        cwd,
        env: {
          ...process.env,
          AWSL_STATE_DIR: join(cwd, "state"),
          AWSL_CODEX_COMMAND: fakeCodex,
          AWSL_FAKE_CODEX_FAIL: "1",
          CODEX_HOME: join(cwd, "codex-home"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const collector = new EventCollector(child);
    await expect(collector.closed).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(collector.events).toEqual([
      expect.objectContaining({
        status: "failed",
        error: { code: "PROVIDER_ERROR" },
      }),
    ]);
    expect(collector.stderr.join("")).toContain("PROVIDER_ERROR");
  });

  test("bounds and fatally decodes piped stdin before provider discovery", async () => {
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "awsl-cli-stdin-")),
    );
    const invoke = async (input: Buffer) => {
      const child = spawn(
        process.execPath,
        [main, join(repository, "tests", "fixtures", "workflows", "args.js")],
        {
          cwd,
          env: {
            ...process.env,
            AWSL_CODEX_COMMAND: join(cwd, "must-not-run"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdin.end(input);
      const closed = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      return { ...closed, stdout, stderr };
    };

    await expect(invoke(Buffer.alloc(512 * 1024 + 1, 0x20))).resolves.toEqual(
      expect.objectContaining({
        code: 2,
        signal: null,
        stdout: "",
        stderr: expect.stringContaining("USAGE_ERROR"),
      }),
    );
    await expect(invoke(Buffer.from([0xff]))).resolves.toEqual(
      expect.objectContaining({
        code: 2,
        signal: null,
        stdout: "",
        stderr: expect.stringContaining("USAGE_ERROR"),
      }),
    );
  });
});
