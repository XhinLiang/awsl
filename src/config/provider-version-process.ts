import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import { isProxy, isUint8Array } from "node:util/types";

import { AwslError } from "../core/errors.js";
import type {
  ProviderVersionProbeInput,
  ProviderVersionProbeResult,
} from "./provider-identity.js";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_GRACE_MS = 1_000;
const GROUP_POLL_INTERVAL_MS = 10;
const GROUP_CLEANUP_TIMEOUT_MS = 2_000;

export interface ProviderVersionProbeReadable {
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  removeListener(event: "data", listener: (chunk: unknown) => void): this;
  removeListener(event: "error", listener: (error: unknown) => void): this;
  destroy(): unknown;
}

export interface ProviderVersionProbeChild {
  readonly pid?: number;
  readonly stdout: ProviderVersionProbeReadable;
  readonly stderr: ProviderVersionProbeReadable;
  on(event: "error", listener: (error: unknown) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "error", listener: (error: unknown) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ProviderVersionSpawnOptions {
  readonly cwd: string;
  readonly detached: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly windowsHide: true;
}

export interface ProviderVersionProbeRuntime {
  readonly platform: NodeJS.Platform;
  readonly spawn: (
    executable: string,
    argv: readonly string[],
    options: ProviderVersionSpawnOptions,
  ) => ProviderVersionProbeChild;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

const defaultRuntime: ProviderVersionProbeRuntime = {
  platform: process.platform,
  spawn: (executable, argv, options) =>
    nodeSpawn(executable, [...argv], {
      ...options,
      stdio: [...options.stdio],
    }) as ProviderVersionProbeChild,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

function probeError(message: string): AwslError {
  return new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function snapshotEnvironmentRecord(value: unknown): NodeJS.ProcessEnv {
  if (value === null || typeof value !== "object" || isProxy(value))
    throw probeError("provider version environment is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !key ||
        key.includes("\0") ||
        key.includes("=") ||
        !descriptors[key].enumerable ||
        !("value" in descriptors[key]) ||
        (descriptors[key].value !== undefined &&
          (typeof descriptors[key].value !== "string" ||
            descriptors[key].value.includes("\0"))),
    )
  )
    throw probeError("provider version environment is invalid");
  const snapshot: NodeJS.ProcessEnv = {};
  for (const key of keys as string[])
    snapshot[key] = descriptors[key].value as string | undefined;
  return snapshot;
}

function mergeEnvironment(overrides: unknown): NodeJS.ProcessEnv {
  const environment = snapshotEnvironmentRecord(process.env);
  if (overrides !== undefined) {
    const captured = snapshotEnvironmentRecord(overrides);
    for (const [key, value] of Object.entries(captured)) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
  return Object.freeze(environment);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

type GroupState = "exists" | "missing" | "error";

function signalGroup(
  runtime: ProviderVersionProbeRuntime,
  pid: number,
  signal: NodeJS.Signals,
): GroupState {
  try {
    runtime.kill(-pid, signal);
    return "exists";
  } catch (error) {
    return errno(error) === "ESRCH" ? "missing" : "error";
  }
}

function inspectGroup(
  runtime: ProviderVersionProbeRuntime,
  pid: number,
): GroupState {
  try {
    runtime.kill(-pid, 0);
    return "exists";
  } catch (error) {
    return errno(error) === "ESRCH" ? "missing" : "error";
  }
}

function killDirectChild(
  child: ProviderVersionProbeChild,
  signal: NodeJS.Signals,
): GroupState {
  try {
    return child.kill(signal) ? "exists" : "missing";
  } catch (error) {
    return errno(error) === "ESRCH" ? "missing" : "error";
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;

function chunkByteLength(value: unknown): number {
  if (typedArrayByteLength === undefined) throw new TypeError();
  if (isProxy(value) || !isUint8Array(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (
    isProxy(prototype) ||
    (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
  )
    throw new TypeError();
  const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new TypeError();
  return byteLength;
}

function snapshotChunk(value: unknown, byteLength: number): Buffer {
  const cloned = structuredClone(value);
  if (isProxy(cloned) || !isUint8Array(cloned)) throw new TypeError();
  const clonedByteLength = Reflect.apply(
    typedArrayByteLength as (this: Uint8Array) => number,
    cloned,
    [],
  ) as number;
  if (clonedByteLength !== byteLength) throw new TypeError();
  return Buffer.from(cloned);
}

export async function defaultProviderVersionProbe(
  input: ProviderVersionProbeInput,
  runtime: ProviderVersionProbeRuntime = defaultRuntime,
): Promise<ProviderVersionProbeResult> {
  if (
    !Number.isSafeInteger(input.maxStdoutBytes) ||
    input.maxStdoutBytes < 0 ||
    !Number.isSafeInteger(input.maxStderrBytes) ||
    input.maxStderrBytes < 0
  )
    throw probeError("provider version stream limit is invalid");
  const env = mergeEnvironment(input.env);

  let child: ProviderVersionProbeChild;
  try {
    child = runtime.spawn(input.executableRealpath, ["--version"], {
      cwd: input.cwd,
      detached: runtime.platform !== "win32",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw probeError("provider version process could not be started");
  }
  return await new Promise<ProviderVersionProbeResult>((resolve, reject) => {
    let lifecycle: "running" | "terminating" | "settled" = "running";
    let processGroupPid: number | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutDeadline = Date.now() + PROBE_TIMEOUT_MS;

    const clearTimers = () => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      timeoutTimer = undefined;
      graceTimer = undefined;
      pollTimer = undefined;
    };

    const cleanup = () => {
      clearTimers();
      child.removeListener("error", onChildError);
      child.removeListener("spawn", onSpawn);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", onStdoutData);
      child.stdout.removeListener("error", onStdoutError);
      child.stderr.removeListener("data", onStderrData);
      child.stderr.removeListener("error", onStderrError);
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const finishFailure = (message: string) => {
      if (lifecycle === "settled") return;
      lifecycle = "settled";
      cleanup();
      reject(probeError(message));
    };

    const finishSuccess = () => {
      if (lifecycle !== "running") return;
      lifecycle = "settled";
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
        exitCode: 0,
      });
    };

    const wait = async (
      milliseconds: number,
      kind: "grace" | "poll",
    ): Promise<void> => {
      await new Promise<void>((done) => {
        const handle = setTimeout(() => {
          if (kind === "grace") graceTimer = undefined;
          else pollTimer = undefined;
          done();
        }, milliseconds);
        if (kind === "grace") graceTimer = handle;
        else pollTimer = handle;
      });
    };

    const waitForGroupCleanup = async (pid: number): Promise<void> => {
      const deadline = Date.now() + GROUP_CLEANUP_TIMEOUT_MS;
      while (true) {
        const state = inspectGroup(runtime, pid);
        if (state === "missing") return;
        if (state === "error" || Date.now() >= deadline)
          throw new Error("process group cleanup failed");
        await wait(
          Math.min(GROUP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())),
          "poll",
        );
      }
    };

    const terminateImmediately = async (): Promise<void> => {
      if (runtime.platform === "win32" || processGroupPid === undefined) {
        killDirectChild(child, "SIGKILL");
        return;
      }
      if (signalGroup(runtime, processGroupPid, "SIGKILL") === "exists")
        await waitForGroupCleanup(processGroupPid);
    };

    const terminateAfterTimeout = async (): Promise<void> => {
      if (runtime.platform === "win32" || processGroupPid === undefined) {
        killDirectChild(child, "SIGTERM");
        await wait(PROBE_KILL_GRACE_MS, "grace");
        killDirectChild(child, "SIGKILL");
        return;
      }

      const term = signalGroup(runtime, processGroupPid, "SIGTERM");
      if (term === "missing") return;
      await wait(PROBE_KILL_GRACE_MS, "grace");
      const state = inspectGroup(runtime, processGroupPid);
      if (state === "missing") return;
      const killed = signalGroup(runtime, processGroupPid, "SIGKILL");
      if (killed === "exists") await waitForGroupCleanup(processGroupPid);
    };

    const beginFailure = (
      message: string,
      termination: "immediate" | "timeout",
    ) => {
      if (lifecycle !== "running") return;
      lifecycle = "terminating";
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      void (async () => {
        try {
          if (termination === "timeout") await terminateAfterTimeout();
          else await terminateImmediately();
        } catch {
          // The public failure remains bounded even when cleanup fails closed.
        }
        finishFailure(message);
      })();
    };

    const append = (
      target: Buffer[],
      value: unknown,
      stream: "stdout" | "stderr",
    ) => {
      if (lifecycle !== "running") return;
      let byteLength: number;
      try {
        byteLength = chunkByteLength(value);
      } catch {
        beginFailure("provider version stream failed", "immediate");
        return;
      }
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const limit =
        stream === "stdout" ? input.maxStdoutBytes : input.maxStderrBytes;
      if (current + byteLength > limit) {
        beginFailure("provider version output exceeds byte limit", "immediate");
        return;
      }
      let chunk: Buffer;
      try {
        chunk = snapshotChunk(value, byteLength);
      } catch {
        beginFailure("provider version stream failed", "immediate");
        return;
      }
      target.push(chunk);
      if (stream === "stdout") stdoutBytes += byteLength;
      else stderrBytes += byteLength;
    };

    const superviseSuccessfulPosixClose = () => {
      if (lifecycle !== "running" || processGroupPid === undefined) return;
      const state = inspectGroup(runtime, processGroupPid);
      if (state === "missing") {
        finishSuccess();
        return;
      }
      if (state === "error") {
        beginFailure(
          "provider version process group could not be verified",
          "immediate",
        );
        return;
      }
      const remaining = timeoutDeadline - Date.now();
      if (remaining <= 0) {
        beginFailure("provider version process timed out", "timeout");
        return;
      }
      pollTimer = setTimeout(
        superviseSuccessfulPosixClose,
        Math.min(GROUP_POLL_INTERVAL_MS, remaining),
      );
    };

    function onStdoutData(value: unknown): void {
      append(stdout, value, "stdout");
    }
    function onStderrData(value: unknown): void {
      append(stderr, value, "stderr");
    }
    function onStdoutError(): void {
      beginFailure("provider version stdout stream failed", "immediate");
    }
    function onStderrError(): void {
      beginFailure("provider version stderr stream failed", "immediate");
    }
    function onChildError(): void {
      beginFailure(
        "provider version process could not be started",
        "immediate",
      );
    }
    function onSpawn(): void {
      if (lifecycle !== "running") return;
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
        beginFailure(
          "provider version process returned an invalid pid",
          "immediate",
        );
        return;
      }
      processGroupPid = pid;
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (lifecycle !== "running") return;
      if (processGroupPid === undefined) {
        finishFailure("provider version process returned an invalid pid");
        return;
      }
      if (code !== 0 || signal !== null) {
        beginFailure(
          "provider version process exited unsuccessfully",
          "immediate",
        );
        return;
      }
      if (runtime.platform === "win32") {
        finishSuccess();
        return;
      }
      superviseSuccessfulPosixClose();
    }

    child.on("error", onChildError);
    child.once("spawn", onSpawn);
    child.once("close", onClose);
    child.stdout.on("data", onStdoutData);
    child.stdout.on("error", onStdoutError);
    child.stderr.on("data", onStderrData);
    child.stderr.on("error", onStderrError);
    timeoutTimer = setTimeout(
      () => beginFailure("provider version process timed out", "timeout"),
      PROBE_TIMEOUT_MS,
    );

    const initialPid = child.pid;
    if (initialPid !== undefined) {
      if (!Number.isSafeInteger(initialPid) || initialPid <= 0)
        beginFailure(
          "provider version process returned an invalid pid",
          "immediate",
        );
      else processGroupPid = initialPid;
    }
  });
}
