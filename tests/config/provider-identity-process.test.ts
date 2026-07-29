import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, test, vi } from "vitest";

import * as providerIdentity from "../../src/config/provider-identity.js";
import type {
  ProviderVersionProbeInput,
  ProviderVersionProbeResult,
} from "../../src/config/provider-identity.js";

interface SpawnOptions {
  cwd: string;
  detached: boolean;
  shell: false;
  stdio: readonly ["ignore", "pipe", "pipe"];
  windowsHide: true;
}

class FakeReadable extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killCalls: NodeJS.Signals[] = [];

  constructor(readonly pid: number | undefined = 4_242) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

interface ProbeRuntime {
  readonly platform: NodeJS.Platform;
  readonly spawn: (
    executable: string,
    argv: readonly string[],
    options: SpawnOptions,
  ) => FakeChild;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

type DefaultProbe = (
  input: ProviderVersionProbeInput,
  runtime?: ProbeRuntime,
) => Promise<ProviderVersionProbeResult>;

function defaultProbe(): DefaultProbe {
  const candidate = (
    providerIdentity as unknown as {
      defaultProviderVersionProbe?: unknown;
    }
  ).defaultProviderVersionProbe;
  expect(candidate).toEqual(expect.any(Function));
  return candidate as DefaultProbe;
}

function probeInput(
  overrides: Partial<ProviderVersionProbeInput> = {},
): ProviderVersionProbeInput {
  return {
    executableRealpath: "/physical/provider",
    cwd: "/canonical/workspace",
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    ...overrides,
  };
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("private process-control detail"), { code });
}

function fakeRuntime(
  child: FakeChild,
  overrides: Partial<ProbeRuntime> = {},
): ProbeRuntime {
  return {
    platform: "linux",
    spawn: vi.fn(() => child),
    kill: vi.fn((_pid, signal) => {
      if (signal === 0) throw systemError("ESRCH");
    }),
    ...overrides,
  };
}

async function expectConfigFailure(
  promise: Promise<unknown>,
  secret?: string,
): Promise<Error> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "CONFIG_ERROR",
    recoverable: false,
  });
  expect((failure as Error).cause).toBeUndefined();
  if (secret !== undefined) {
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  }
  return failure as Error;
}

const temporaryPaths: string[] = [];
const temporaryProcessGroups = new Set<number>();
const temporaryProcesses = new Set<number>();

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pid: number): boolean {
  return processExists(-pid);
}

function killTestTarget(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const pid of temporaryProcessGroups) killTestTarget(-pid);
  for (const pid of temporaryProcesses) killTestTarget(pid);
  temporaryProcessGroups.clear();
  temporaryProcesses.clear();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("default provider version probe", () => {
  test("uses the exact version-only spawn contract and clears the happy timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runtime = fakeRuntime(child);
    const pending = defaultProbe()(probeInput(), runtime);

    expect(runtime.spawn).toHaveBeenCalledWith(
      "/physical/provider",
      ["--version"],
      {
        cwd: "/canonical/workspace",
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.emit("data", Buffer.from("codex-cli 0.145.0\n"));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child.emit("close", 0, null);

    await expect(pending).resolves.toEqual({
      stdout: Buffer.from("codex-cli 0.145.0\n"),
      stderr: Buffer.from("diagnostic"),
      exitCode: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  test("accepts each independent stream at the exact 64 KiB limit", async () => {
    const child = new FakeChild();
    const runtime = fakeRuntime(child);
    const pending = defaultProbe()(probeInput(), runtime);
    const prefix = Buffer.from("codex-cli 0.145.0\n");
    const stdout = Buffer.concat([
      prefix,
      Buffer.alloc(64 * 1024 - prefix.byteLength, 0x61),
    ]);
    const stderr = Buffer.alloc(64 * 1024, 0x62);

    child.stdout.emit("data", stdout);
    child.stderr.emit("data", stderr);
    child.emit("close", 0, null);

    await expect(pending).resolves.toEqual({
      stdout,
      stderr,
      exitCode: 0,
    });
  });

  test.each(["stdout", "stderr"] as const)(
    "terminates and rejects when %s exceeds its independent limit by one byte",
    async (stream) => {
      const child = new FakeChild();
      const runtime = fakeRuntime(child);
      const pending = defaultProbe()(probeInput(), runtime);

      child[stream].emit("data", Buffer.alloc(64 * 1024 + 1, 0x61));
      await expectConfigFailure(pending);
      expect(runtime.kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    },
  );

  test.each(["stdout", "stderr"] as const)(
    "maps a %s stream error and close race to one bounded failure",
    async (stream) => {
      const secret = `RAW_${stream.toUpperCase()}_SECRET`;
      const child = new FakeChild();
      const runtime = fakeRuntime(child);
      const pending = defaultProbe()(probeInput(), runtime);

      child[stream].emit("error", new Error(secret));
      child.emit("close", 1, null);

      await expectConfigFailure(pending, secret);
      expect(runtime.kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
    },
  );

  test.each(["stdout", "stderr"] as const)(
    "rejects a proxied %s chunk without invoking its prototype trap",
    async (stream) => {
      let hookCalls = 0;
      const proxiedChunk = new Proxy(Buffer.from("private chunk"), {
        getPrototypeOf: () => {
          hookCalls += 1;
          throw new Error("chunk prototype trap must not run");
        },
      });
      const child = new FakeChild();
      const pending = defaultProbe()(probeInput(), fakeRuntime(child));

      child[stream].emit("data", proxiedChunk);

      await expectConfigFailure(pending, "private chunk");
      expect(hookCalls).toBe(0);
    },
  );

  test("maps synchronous and emitted spawn failures without exposing causes", async () => {
    const synchronousSecret = "SYNC_SPAWN_SECRET";
    await expectConfigFailure(
      defaultProbe()(
        probeInput(),
        fakeRuntime(new FakeChild(), {
          spawn: () => {
            throw new Error(synchronousSecret);
          },
        }),
      ),
      synchronousSecret,
    );

    const emittedSecret = "EMITTED_SPAWN_SECRET";
    const child = new FakeChild();
    const runtime = fakeRuntime(child);
    const pending = defaultProbe()(probeInput(), runtime);
    child.emit("error", new Error(emittedSecret));
    child.emit("close", 1, null);
    await expectConfigFailure(pending, emittedSecret);
  });

  test("waits for the asynchronous spawn error when the initial pid is undefined", async () => {
    vi.useFakeTimers();
    const secret = "ASYNC_SPAWN_SECRET";
    const child = new FakeChild();
    Object.defineProperty(child, "pid", {
      configurable: true,
      value: undefined,
    });
    const pending = defaultProbe()(probeInput(), fakeRuntime(child));

    expect(vi.getTimerCount()).toBe(1);
    child.emit("error", new Error(secret));
    await expectConfigFailure(pending, secret);
    child.emit("close", -1, null);

    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("accepts an initially undefined pid after the child emits spawn", async () => {
    const child = new FakeChild();
    Object.defineProperty(child, "pid", {
      configurable: true,
      value: undefined,
    });
    const pending = defaultProbe()(probeInput(), fakeRuntime(child));

    Object.defineProperty(child, "pid", { value: 4_242 });
    child.emit("spawn");
    child.stdout.emit("data", Buffer.from("codex-cli 0.145.0\n"));
    child.emit("close", 0, null);

    await expect(pending).resolves.toMatchObject({
      stdout: Buffer.from("codex-cli 0.145.0\n"),
      exitCode: 0,
    });
  });

  test.each([0, -1, Number.NaN])(
    "rejects an invalid child pid without leaving a timeout: %j",
    async (pid) => {
      vi.useFakeTimers();
      const child = new FakeChild(pid);
      const pending = defaultProbe()(probeInput(), fakeRuntime(child));
      const failure = expectConfigFailure(pending);
      const timerCount = vi.getTimerCount();

      await failure;
      expect(timerCount).toBe(0);
      expect(child.killCalls).toContain("SIGKILL");
    },
  );

  test("maps a real nonexistent executable spawn failure without an unhandled error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-missing-provider-"));
    temporaryPaths.push(cwd);
    const missingExecutable = join(cwd, "does-not-exist");

    await expectConfigFailure(
      defaultProbe()(
        probeInput({
          cwd,
          executableRealpath: missingExecutable,
        }),
      ),
    );
  });

  test.each([
    [1, null],
    [null, "SIGTERM"],
  ] as const)(
    "rejects an unsuccessful close without raw process detail: %j %j",
    async (code, signal) => {
      const child = new FakeChild();
      const runtime = fakeRuntime(child);
      const pending = defaultProbe()(probeInput(), runtime);
      child.stderr.emit("data", Buffer.from("RAW_STDERR_SECRET"));
      child.emit("close", code, signal);
      await expectConfigFailure(pending, "RAW_STDERR_SECRET");
      expect(runtime.kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
    },
  );

  test("times out a POSIX group and still sends SIGKILL after the direct child closes", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let inspections = 0;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        inspections += 1;
        if (inspections > 1) throw systemError("ESRCH");
      }
    });
    const runtime = fakeRuntime(child, { kill });
    const pending = defaultProbe()(probeInput(), runtime);
    const failure = expectConfigFailure(pending);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalledWith(-4_242, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);

    await failure;
    expect(kill.mock.calls).toEqual([
      [-4_242, "SIGTERM"],
      [-4_242, 0],
      [-4_242, "SIGKILL"],
      [-4_242, 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps supervising a successful POSIX close against the original timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let groupKilled = false;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGKILL") groupKilled = true;
      if (signal === 0 && groupKilled) throw systemError("ESRCH");
    });
    const pending = defaultProbe()(probeInput(), fakeRuntime(child, { kill }));
    const outcome = pending.then(
      (result) => ({ kind: "success" as const, result }),
      (error: unknown) => ({ error, kind: "error" as const }),
    );

    await vi.advanceTimersByTimeAsync(4_000);
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalledWith(-4_242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toMatchObject({
      error: {
        code: "CONFIG_ERROR",
        recoverable: false,
      },
      kind: "error",
    });
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("treats an ESRCH group as already cleaned up", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const kill = vi.fn(() => {
      throw systemError("ESRCH");
    });
    const pending = defaultProbe()(probeInput(), fakeRuntime(child, { kill }));
    const failure = expectConfigFailure(pending);

    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-4_242, 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("fails closed on EPERM while inspecting a timed-out process group", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw systemError("EPERM");
    });
    const pending = defaultProbe()(probeInput(), fakeRuntime(child, { kill }));
    const failure = expectConfigFailure(pending, "private process-control");

    await vi.advanceTimersByTimeAsync(6_000);
    await failure;
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("accepts a successful Windows close without inspecting a process group", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupKill = vi.fn(() => {
      throw new Error("Windows must not inspect a POSIX process group");
    });
    const pending = defaultProbe()(
      probeInput(),
      fakeRuntime(child, {
        platform: "win32",
        kill: groupKill,
      }),
    );

    child.stdout.emit("data", Buffer.from("codex-cli 0.145.0\n"));
    child.emit("close", 0, null);

    await expect(pending).resolves.toMatchObject({
      stdout: Buffer.from("codex-cli 0.145.0\n"),
      exitCode: 0,
    });
    expect(groupKill).not.toHaveBeenCalled();
    expect(child.killCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("uses direct-child TERM and KILL on Windows without a negative PID", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupKill = vi.fn(() => {
      throw new Error("Windows must not use process.kill");
    });
    const pending = defaultProbe()(
      probeInput(),
      fakeRuntime(child, {
        platform: "win32",
        kill: groupKill,
      }),
    );
    const failure = expectConfigFailure(pending);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.killCalls).toEqual(["SIGTERM"]);
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;

    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(groupKill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.runIf(process.platform !== "win32")(
    "rejects and cleans up a valid zero-exit probe with a closed-stdio descendant",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "awsl-version-orphan-"));
      temporaryPaths.push(cwd);
      const executable = join(cwd, "codex-version");
      const pidFile = `${executable}.pids`;
      await writeFile(
        executable,
        '#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf \'%s %s\\n\' "$$" "$!" > "${0}.pids"\nprintf \'codex-cli 0.145.0\\n\'\n',
      );
      await chmod(executable, 0o755);

      let failure: unknown;
      try {
        await providerIdentity.resolveProviderIdentity({
          provider: "codex",
          executable,
          cwd,
          env: {},
        });
      } catch (error) {
        failure = error;
      }

      const [groupText, descendantText] = (await readFile(pidFile, "utf8"))
        .trim()
        .split(" ");
      const groupPid = Number(groupText);
      const descendantPid = Number(descendantText);
      expect(Number.isSafeInteger(groupPid) && groupPid > 0).toBe(true);
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(
        true,
      );
      temporaryProcessGroups.add(groupPid);
      temporaryProcesses.add(descendantPid);
      const groupRemained = processGroupExists(groupPid);
      const descendantRemained = processExists(descendantPid);
      if (groupRemained) killTestTarget(-groupPid);
      if (descendantRemained) killTestTarget(descendantPid);

      expect(failure).toMatchObject({
        code: "CONFIG_ERROR",
        recoverable: false,
      });
      expect(groupRemained).toBe(false);
      expect(descendantRemained).toBe(false);
    },
    12_000,
  );

  test.runIf(process.platform !== "win32")(
    "wires the resolver default to one real version-only executable",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "awsl-version-probe-"));
      temporaryPaths.push(cwd);
      const executable = join(cwd, "codex-version");
      await writeFile(executable, "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n");
      await chmod(executable, 0o755);
      const executableRealpath = await realpath(executable);

      await expect(
        providerIdentity.resolveProviderIdentity({
          provider: "codex",
          executable: "./codex-version",
          cwd,
          env: {},
        }),
      ).resolves.toEqual({
        id: "codex",
        executableRealpath,
        version: "0.145.0",
      });
    },
  );
});
