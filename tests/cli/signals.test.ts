import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import {
  completedStopIntent,
  installRunSignalHandlers,
  parseLinuxProcessStartIdentity,
  sendVerifiedSignal,
} from "../../src/cli/signals.js";
import { AwslError } from "../../src/core/errors.js";

describe("CLI process identities and signals", () => {
  test("parses Linux proc stat after a command name containing spaces and parentheses", () => {
    const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
    fields[19] = "987654";
    expect(
      parseLinuxProcessStartIdentity(
        `42 (worker (one) two) ${fields.join(" ")}`,
        "boot-id",
      ),
    ).toBe("linux:boot-id:987654");
  });

  test("sends pause only after matching both PID and process-start identity", async () => {
    const signal = vi.fn();
    await expect(
      sendVerifiedSignal(
        { pid: 42, processStartIdentity: "start-a" },
        "SIGUSR2",
        {
          inspect: async () => ({
            kind: "alive",
            processStartIdentity: "start-b",
          }),
          signal,
        },
      ),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
      message: "run process identity could not be verified",
    });
    expect(signal).not.toHaveBeenCalled();

    await expect(
      sendVerifiedSignal(
        { pid: 42, processStartIdentity: "start-a" },
        "SIGUSR2",
        {
          inspect: async () => ({
            kind: "alive",
            processStartIdentity: "start-a",
          }),
          signal,
        },
      ),
    ).resolves.toBeUndefined();
    expect(signal).toHaveBeenCalledWith(42, "SIGUSR2");
  });

  test("latches the first cooperative stop intent", () => {
    const processSignals = new EventEmitter();
    const controller = new AbortController();
    const handlers = installRunSignalHandlers({
      controller,
      processSignals: {
        on: (signal, listener) => processSignals.on(signal, listener),
        off: (signal, listener) => processSignals.off(signal, listener),
      },
    });

    processSignals.emit("SIGUSR2");
    processSignals.emit("SIGTERM");
    processSignals.emit("SIGINT");

    expect(controller.signal.aborted).toBe(true);
    expect(handlers.intent()).toEqual({
      signal: "SIGUSR2",
      status: "paused",
      exitCode: 0,
    });
    handlers.dispose();
    expect(processSignals.listenerCount("SIGINT")).toBe(0);
    expect(processSignals.listenerCount("SIGTERM")).toBe(0);
    expect(processSignals.listenerCount("SIGUSR2")).toBe(0);
  });

  test("maps an intent only after durable cancellation completed", () => {
    const paused = {
      signal: "SIGUSR2",
      status: "paused",
      exitCode: 0,
    } as const;
    expect(
      completedStopIntent(
        new AwslError("CANCELLED", "cancelled", { recoverable: false }),
        paused,
      ),
    ).toEqual(paused);
    expect(
      completedStopIntent(
        new AwslError("PERSISTENCE_ERROR", "terminal write failed", {
          recoverable: false,
        }),
        paused,
      ),
    ).toBeUndefined();
    expect(
      completedStopIntent(
        new AwslError("WORKFLOW_ERROR", "workflow failed", {
          recoverable: false,
        }),
        paused,
      ),
    ).toBeUndefined();
  });
});
