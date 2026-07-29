import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import process from "node:process";
import { TextDecoder } from "node:util";

import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import { AwslError } from "../core/errors.js";

const GROUP_POLL_INTERVAL_MS = 10;
const GROUP_KILL_WAIT_MS = 2_000;

export interface RunProviderProcessOptions {
  executable: string;
  argv: readonly string[];
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  maxLineBytes?: number;
  stderrLimitBytes?: number;
}

export interface ProviderProcessResult {
  exitCode: 0;
  signal: null;
  eventCount: number;
  stderrTail: Buffer;
}

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class TransportFailure extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "TransportFailure";
  }
}

function providerError(message: string): AwslError {
  return new AwslError("PROVIDER_ERROR", message, {
    recoverable: false,
  });
}

function cancellationError(): AwslError {
  return new AwslError("CANCELLED", "provider process cancelled", {
    recoverable: false,
  });
}

function validateIntegerOption(
  name: string,
  value: number,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AwslError(
      "CONFIG_ERROR",
      `${name} must be a safe integer greater than or equal to ${minimum}`,
      { recoverable: false },
    );
  }
}

function mergeEnvironment(overrides: NodeJS.ProcessEnv | undefined) {
  const environment = Object.assign(
    Object.create(null),
    process.env,
  ) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function appendByteTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit === 0) return Buffer.alloc(0);
  if (chunk.byteLength >= limit) {
    return Buffer.from(chunk.subarray(chunk.byteLength - limit));
  }
  if (current.byteLength + chunk.byteLength <= limit) {
    return Buffer.concat(
      [current, chunk],
      current.byteLength + chunk.byteLength,
    );
  }

  const keepFromCurrent = limit - chunk.byteLength;
  const result = Buffer.allocUnsafe(limit);
  current.copy(
    result,
    0,
    current.byteLength - keepFromCurrent,
    current.byteLength,
  );
  chunk.copy(result, keepFromCurrent);
  return result;
}

function lastPendingByte(parts: readonly Buffer[]): number | undefined {
  const last = parts.at(-1);
  return last?.at(-1);
}

async function consumeNdjson(
  stdout: NodeJS.ReadableStream,
  maxLineBytes: number,
  onEvent: RunProviderProcessOptions["onEvent"],
): Promise<number> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Buffer[] = [];
  let pendingBytes = 0;
  let eventCount = 0;

  const append = (part: Buffer) => {
    if (part.byteLength === 0) return;
    parts.push(part);
    pendingBytes += part.byteLength;

    const permitsTrailingCarriageReturn =
      pendingBytes === maxLineBytes + 1 && lastPendingByte(parts) === 0x0d;
    if (
      pendingBytes > maxLineBytes + 1 ||
      (pendingBytes > maxLineBytes && !permitsTrailingCarriageReturn)
    ) {
      throw new TransportFailure("provider output line exceeds byte limit");
    }
  };

  const flush = async () => {
    let lineBytes = pendingBytes;
    const line = Buffer.concat(parts, pendingBytes);
    parts = [];
    pendingBytes = 0;

    if (line.at(-1) === 0x0d) lineBytes -= 1;
    if (lineBytes > maxLineBytes) {
      throw new TransportFailure("provider output line exceeds byte limit");
    }

    const content =
      lineBytes === line.byteLength ? line : line.subarray(0, lineBytes);
    let text: string;
    try {
      text = decoder.decode(content);
    } catch {
      throw new TransportFailure("provider emitted invalid UTF-8");
    }
    if (text.trim() === "") return;

    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      throw new TransportFailure("provider emitted malformed NDJSON");
    }

    try {
      await onEvent?.(event);
    } catch (error) {
      if (error instanceof AwslError && error.code === "PERSISTENCE_ERROR")
        throw error;
      throw new TransportFailure("provider event callback failed");
    }
    eventCount += 1;
  };

  try {
    for await (const rawChunk of stdout) {
      const chunk =
        typeof rawChunk === "string"
          ? Buffer.from(rawChunk)
          : Buffer.isBuffer(rawChunk)
            ? rawChunk
            : Buffer.from(rawChunk as Uint8Array);
      let offset = 0;
      let newline = chunk.indexOf(0x0a, offset);
      while (newline !== -1) {
        append(chunk.subarray(offset, newline));
        await flush();
        offset = newline + 1;
        newline = chunk.indexOf(0x0a, offset);
      }
      append(chunk.subarray(offset));
    }
    if (pendingBytes > 0) await flush();
  } catch (error) {
    if (error instanceof AwslError && error.code === "PERSISTENCE_ERROR")
      throw error;
    if (error instanceof TransportFailure) throw error;
    throw new TransportFailure("provider stdout stream failed");
  }

  return eventCount;
}

function groupState(pid: number): "exists" | "missing" | NodeJS.ErrnoException {
  try {
    process.kill(-pid, 0);
    return "exists";
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ESRCH") return "missing";
    return systemError;
  }
}

function signalGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  processGroupPid = child.pid,
): "sent" | "missing" | NodeJS.ErrnoException {
  if (processGroupPid === undefined) {
    try {
      child.kill(signal);
      return "sent";
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") return "missing";
      return systemError;
    }
  }

  if (process.platform === "win32") {
    try {
      child.kill(signal);
      return "sent";
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") return "missing";
      return systemError;
    }
  }

  try {
    process.kill(-processGroupPid, signal);
    return "sent";
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ESRCH") return "missing";
    return systemError;
  }
}

function isSystemError(
  result: "sent" | "missing" | NodeJS.ErrnoException,
): result is NodeJS.ErrnoException {
  return result !== "sent" && result !== "missing";
}

function groupMayExist(
  state: "exists" | "missing" | NodeJS.ErrnoException,
): boolean {
  return state === "exists" || (state !== "missing" && state.code === "EPERM");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForGroupToDisappear(
  processGroupPid: number | undefined,
  timeoutMs: number,
): Promise<void> {
  if (process.platform === "win32" || processGroupPid === undefined) return;

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = groupState(processGroupPid);
    if (state === "missing") return;
    if (!groupMayExist(state)) {
      throw new TransportFailure("unable to inspect provider process group");
    }
    if (Date.now() >= deadline) {
      throw new TransportFailure("provider process group did not terminate");
    }
    await delay(GROUP_POLL_INTERVAL_MS);
  }
}

async function terminateForCancellation(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
  processGroupPid: number | undefined,
): Promise<void> {
  const termResult = signalGroup(child, "SIGTERM", processGroupPid);
  if (isSystemError(termResult)) {
    throw new TransportFailure("unable to terminate provider process group");
  }
  if (termResult === "missing") return;

  if (process.platform === "win32" || processGroupPid === undefined) {
    if (graceMs > 0) await delay(graceMs);
    const killResult = signalGroup(child, "SIGKILL", processGroupPid);
    if (isSystemError(killResult)) {
      throw new TransportFailure("unable to terminate provider process");
    }
    return;
  }

  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    const state = groupState(processGroupPid as number);
    if (state === "missing") return;
    if (!groupMayExist(state)) {
      throw new TransportFailure("unable to inspect provider process group");
    }
    await delay(
      Math.min(GROUP_POLL_INTERVAL_MS, Math.max(1, graceDeadline - Date.now())),
    );
  }

  const stateAfterGrace = groupState(processGroupPid as number);
  if (stateAfterGrace === "missing") return;
  if (!groupMayExist(stateAfterGrace)) {
    throw new TransportFailure("unable to inspect provider process group");
  }

  const killResult = signalGroup(child, "SIGKILL", processGroupPid);
  if (isSystemError(killResult)) {
    throw new TransportFailure("unable to kill provider process group");
  }
  if (killResult === "sent") {
    await waitForGroupToDisappear(processGroupPid, GROUP_KILL_WAIT_MS);
  }
}

async function terminateImmediately(
  child: ChildProcessWithoutNullStreams,
  processGroupPid: number | undefined,
): Promise<void> {
  const killResult = signalGroup(child, "SIGKILL", processGroupPid);
  if (isSystemError(killResult) || killResult === "missing") return;
  try {
    await waitForGroupToDisappear(processGroupPid, GROUP_KILL_WAIT_MS);
  } catch {
    // Preserve the original transport failure. Cancellation uses the strict path.
  }
}

async function terminateDescendantsAfterExit(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
  processGroupPid: number | undefined,
): Promise<void> {
  if (process.platform === "win32" || processGroupPid === undefined) return;
  const state = groupState(processGroupPid);
  if (state === "missing") return;
  if (!groupMayExist(state)) {
    throw new TransportFailure("unable to inspect provider process group");
  }
  await terminateForCancellation(child, graceMs, processGroupPid);
}

function spawnProvider(
  options: RunProviderProcessOptions,
): ChildProcessWithoutNullStreams {
  try {
    return spawn(options.executable, [...options.argv], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: mergeEnvironment(options.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw providerError("provider process could not be started");
  }
}

export async function runProviderProcess(
  options: RunProviderProcessOptions,
): Promise<ProviderProcessResult> {
  const killGraceMs =
    options.killGraceMs ?? COMPATIBILITY_PROFILE.providerProcess.killGraceMs;
  const maxLineBytes =
    options.maxLineBytes ??
    COMPATIBILITY_PROFILE.providerProcess.maxNdjsonLineBytes;
  const stderrLimitBytes =
    options.stderrLimitBytes ??
    COMPATIBILITY_PROFILE.providerProcess.stderrTailBytes;
  validateIntegerOption("killGraceMs", killGraceMs, 0);
  validateIntegerOption("maxLineBytes", maxLineBytes, 1);
  validateIntegerOption("stderrLimitBytes", stderrLimitBytes, 0);

  if (options.signal.aborted) throw cancellationError();

  const child = spawnProvider(options);
  const processGroupPid = child.pid;
  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let fatalTriggered = false;
  let triggerFatal!: (error: TransportFailure) => void;
  const fatalPromise = new Promise<never>((_, reject) => {
    triggerFatal = (error) => {
      if (fatalTriggered) return;
      fatalTriggered = true;
      reject(error);
    };
  });

  const onChildError = () => {
    triggerFatal(new TransportFailure("provider process could not be started"));
  };
  const onStdinError = () => {
    triggerFatal(new TransportFailure("provider stdin stream failed"));
  };
  const onStderrError = () => {
    triggerFatal(new TransportFailure("provider stderr stream failed"));
  };
  const onStderrData = (rawChunk: Buffer | Uint8Array) => {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    stderrTail = appendByteTail(stderrTail, chunk, stderrLimitBytes);
  };

  child.on("error", onChildError);
  child.stdin.on("error", onStdinError);
  child.stderr.on("error", onStderrError);
  child.stderr.on("data", onStderrData);

  let closeListener!: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  const closePromise = new Promise<CloseResult>((resolve) => {
    closeListener = (code, signal) => resolve({ code, signal });
    child.once("close", closeListener);
  });
  let exitListener!: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  const exitPromise = new Promise<CloseResult>((resolve) => {
    exitListener = (code, signal) => resolve({ code, signal });
    child.once("exit", exitListener);
  });
  const exitCleanupPromise = exitPromise.then(async (exit) => {
    await terminateDescendantsAfterExit(child, killGraceMs, processGroupPid);
    return exit;
  });

  let stdinFinished = false;
  const stdinPromise = new Promise<void>((resolve) => {
    child.stdin.end(options.prompt, () => {
      stdinFinished = true;
      resolve();
    });
  });
  const stdoutPromise = consumeNdjson(
    child.stdout,
    maxLineBytes,
    options.onEvent,
  );

  let abortTriggered = false;
  let triggerAbort!: () => void;
  const abortSignalPromise = new Promise<void>((resolve) => {
    triggerAbort = () => {
      if (abortTriggered) return;
      abortTriggered = true;
      child.stdin.destroy();
      resolve();
    };
  });
  const onAbort = () => triggerAbort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) triggerAbort();

  const cancellationPromise = abortSignalPromise.then(async () => {
    await terminateForCancellation(child, killGraceMs, processGroupPid);
    throw cancellationError();
  });

  const normalPromise = Promise.all([
    exitCleanupPromise,
    closePromise,
    stdoutPromise,
    stdinPromise,
  ]).then(
    async ([exit, close, eventCount]) => {
      if (abortTriggered) return await cancellationPromise;
      if (
        exit.code !== close.code ||
        exit.signal !== close.signal ||
        exit.code !== 0 ||
        exit.signal !== null
      ) {
        throw new TransportFailure("provider process exited unsuccessfully");
      }
      if (abortTriggered) return await cancellationPromise;
      return {
        exitCode: 0 as const,
        signal: null,
        eventCount,
        stderrTail: Buffer.from(stderrTail),
      };
    },
    async (error: unknown) => {
      if (abortTriggered) return await cancellationPromise;
      throw error;
    },
  );

  try {
    return await Promise.race([
      normalPromise,
      fatalPromise,
      cancellationPromise,
    ]);
  } catch (error) {
    if (error instanceof AwslError && error.code === "CANCELLED") throw error;

    await terminateImmediately(child, processGroupPid);
    if (error instanceof AwslError) throw error;
    if (error instanceof TransportFailure) {
      throw providerError(error.publicMessage);
    }
    throw providerError("provider process transport failed");
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    child.removeListener("error", onChildError);
    child.stdin.removeListener("error", onStdinError);
    child.stderr.removeListener("error", onStderrError);
    child.stderr.removeListener("data", onStderrData);
    child.removeListener("exit", exitListener);
    child.removeListener("close", closeListener);
    if (!stdinFinished) child.stdin.destroy();
    if (!child.stdout.destroyed) child.stdout.destroy();
    if (!child.stderr.destroyed) child.stderr.destroy();
  }
}
