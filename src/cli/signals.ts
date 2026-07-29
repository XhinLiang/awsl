import { execFile as nodeExecFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { AwslError } from "../core/errors.js";

const execFile = promisify(nodeExecFile);

export type ProcessInspection =
  | {
      readonly kind: "alive";
      readonly processStartIdentity: string;
    }
  | { readonly kind: "dead" }
  | { readonly kind: "unknown" };

export interface RunStopIntent {
  readonly signal: "SIGINT" | "SIGTERM" | "SIGUSR2";
  readonly status: "killed" | "paused";
  readonly exitCode: 0 | 130 | 143;
}

export interface ProcessSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

function persistence(message: string, cause?: unknown): AwslError {
  return new AwslError("PERSISTENCE_ERROR", message, {
    recoverable: false,
    cause,
  });
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function processExists(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

export function parseLinuxProcessStartIdentity(
  stat: string,
  bootId: string,
): string {
  const close = stat.lastIndexOf(")");
  if (
    close <= 0 ||
    close + 2 >= stat.length ||
    !/^[A-Za-z0-9-]{1,128}$/.test(bootId)
  )
    throw persistence("process start identity is unavailable");
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (
    fields.length < 20 ||
    startTicks === undefined ||
    !/^(?:0|[1-9][0-9]*)$/.test(startTicks)
  )
    throw persistence("process start identity is unavailable");
  return `linux:${bootId}:${startTicks}`;
}

async function inspectLinuxProcess(pid: number): Promise<ProcessInspection> {
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, { encoding: "utf8" }),
      readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8" }),
    ]);
    return {
      kind: "alive",
      processStartIdentity: parseLinuxProcessStartIdentity(stat, bootId.trim()),
    };
  } catch {
    const state = processExists(pid);
    return state === "dead" ? { kind: "dead" } : { kind: "unknown" };
  }
}

async function inspectPosixProcess(pid: number): Promise<ProcessInspection> {
  try {
    const result = await execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        maxBuffer: 4_096,
      },
    );
    const started = result.stdout.trim();
    if (
      started.length === 0 ||
      started.includes("\0") ||
      Buffer.byteLength(started, "utf8") > 1_024
    )
      return { kind: "unknown" };
    return {
      kind: "alive",
      processStartIdentity: `${process.platform}:${started}`,
    };
  } catch {
    const state = processExists(pid);
    return state === "dead" ? { kind: "dead" } : { kind: "unknown" };
  }
}

export async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!validPid(pid)) throw persistence("run process identifier is invalid");
  if (process.platform === "win32")
    throw persistence("process identity is unsupported on native Windows");
  return process.platform === "linux"
    ? inspectLinuxProcess(pid)
    : inspectPosixProcess(pid);
}

export async function currentProcessStartIdentity(): Promise<string> {
  const inspected = await inspectProcess(process.pid);
  if (inspected.kind !== "alive")
    throw persistence("current process identity is unavailable");
  return inspected.processStartIdentity;
}

export interface SendVerifiedSignalDependencies {
  readonly inspect?: (pid: number) => Promise<ProcessInspection>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
}

export async function sendVerifiedSignal(
  owner: { readonly pid: number; readonly processStartIdentity: string },
  signal: NodeJS.Signals,
  dependencies: SendVerifiedSignalDependencies = {},
): Promise<void> {
  if (
    !validPid(owner.pid) ||
    typeof owner.processStartIdentity !== "string" ||
    owner.processStartIdentity.length === 0
  )
    throw persistence("run process identity could not be verified");
  const inspect = dependencies.inspect ?? inspectProcess;
  const inspected = await inspect(owner.pid);
  if (
    inspected.kind !== "alive" ||
    inspected.processStartIdentity !== owner.processStartIdentity
  )
    throw persistence("run process identity could not be verified");
  try {
    (dependencies.signal ?? process.kill)(owner.pid, signal);
  } catch (error) {
    throw persistence("could not signal the verified run process", error);
  }
}

export interface InstalledRunSignalHandlers {
  intent(): RunStopIntent | undefined;
  dispose(): void;
}

export function completedStopIntent(
  error: unknown,
  intent: RunStopIntent | undefined,
): RunStopIntent | undefined {
  return error instanceof AwslError && error.code === "CANCELLED"
    ? intent
    : undefined;
}

export function installRunSignalHandlers(options: {
  readonly controller: AbortController;
  readonly processSignals?: ProcessSignalSource;
}): InstalledRunSignalHandlers {
  const source = options.processSignals ?? process;
  let current: RunStopIntent | undefined;
  const latch = (intent: RunStopIntent) => {
    if (current !== undefined) return;
    current = intent;
    options.controller.abort(intent);
  };
  const listeners = {
    SIGINT: () => latch({ signal: "SIGINT", status: "killed", exitCode: 130 }),
    SIGTERM: () =>
      latch({ signal: "SIGTERM", status: "killed", exitCode: 143 }),
    SIGUSR2: () => latch({ signal: "SIGUSR2", status: "paused", exitCode: 0 }),
  } as const;
  for (const signal of Object.keys(listeners) as Array<keyof typeof listeners>)
    source.on(signal, listeners[signal]);
  let disposed = false;
  return Object.freeze({
    intent: () => current,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const signal of Object.keys(listeners) as Array<
        keyof typeof listeners
      >)
        source.off(signal, listeners[signal]);
    },
  });
}
