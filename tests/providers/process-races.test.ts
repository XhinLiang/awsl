import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

type FakeChild = EventEmitter & {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
};

const spawnState = vi.hoisted(() => ({
  child: undefined as FakeChild | undefined,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    if (!spawnState.child) throw new Error("missing fake child");
    return spawnState.child;
  }),
}));

import { runProviderProcess } from "../../src/providers/process.js";

function fakeChild(pid = 43210): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function options(signal = new AbortController().signal) {
  return {
    executable: "provider",
    argv: [],
    cwd: process.cwd(),
    prompt: "prompt",
    signal,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnState.child = undefined;
});

describe("runProviderProcess transport races", () => {
  test("rejects a stdout stream error", async () => {
    const child = fakeChild();
    spawnState.child = child;
    const running = runProviderProcess(options());

    child.stdout.emit("error", new Error("stdout exploded"));

    await expect(running).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  test("rejects a stderr stream error", async () => {
    const child = fakeChild();
    spawnState.child = child;
    const running = runProviderProcess(options());

    child.stderr.emit("error", new Error("stderr exploded"));

    await expect(running).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "provider stderr stream failed",
    });
  });

  test("ignores ESRCH while cancelling a vanished process group", async () => {
    const child = fakeChild();
    spawnState.child = child;
    const controller = new AbortController();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("gone"), { code: "ESRCH" });
      throw error;
    });
    const running = runProviderProcess(options(controller.signal));

    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  });

  test("fails closed on EPERM while cancelling a process group", async () => {
    const child = fakeChild();
    spawnState.child = child;
    const controller = new AbortController();
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("forbidden"), { code: "EPERM" });
      throw error;
    });
    const running = runProviderProcess(options(controller.signal));

    controller.abort();

    await expect(running).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "unable to terminate provider process group",
    });
  });

  test("settles once when stdout, stderr, and child failures race", async () => {
    const child = fakeChild();
    spawnState.child = child;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("gone"), { code: "ESRCH" });
      throw error;
    });
    const running = runProviderProcess(options());

    child.stdout.emit("error", new Error("stdout exploded"));
    child.stderr.emit("error", new Error("stderr exploded"));
    child.emit("error", new Error("spawn exploded"));

    await expect(running).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
