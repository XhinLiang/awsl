import { describe, expect, test } from "vitest";

import { Scheduler, runtimeConcurrency } from "../../src/runtime/scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countAbortListeners(signal: AbortSignal) {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;

  signal.addEventListener = ((type, listener, options) => {
    if (type === "abort") added += 1;
    originalAdd(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type, listener, options) => {
    if (type === "abort") removed += 1;
    originalRemove(type, listener, options);
  }) as AbortSignal["removeEventListener"];

  return { added: () => added, removed: () => removed };
}

describe("runtimeConcurrency", () => {
  test.each([
    [1, 2],
    [2, 2],
    [4, 2],
    [18, 16],
    [64, 16],
  ])("derives the concurrency limit from %i CPUs", (cpus, expected) => {
    expect(runtimeConcurrency(cpus)).toBe(expected);
  });

  test("rejects non-finite and non-integer CPU counts", () => {
    expect(() => runtimeConcurrency(Number.NaN)).toThrow(RangeError);
    expect(() => runtimeConcurrency(2.5)).toThrow(RangeError);
  });
});

describe("Scheduler", () => {
  test("rejects limits that are not positive integers", () => {
    expect(() => new Scheduler(0)).toThrow(RangeError);
    expect(() => new Scheduler(1.5)).toThrow(RangeError);
  });

  test("never exceeds its limit and admits work in FIFO order", async () => {
    const scheduler = new Scheduler(2);
    const gates: Record<number, ReturnType<typeof deferred>> = {
      0: deferred(),
      1: deferred(),
      2: deferred(),
      3: deferred(),
    };
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const results = [0, 1, 2, 3].map((value) =>
      scheduler.run(async () => {
        started.push(value);
        active += 1;
        peak = Math.max(peak, active);
        await gates[value].promise;
        active -= 1;
        return value;
      }),
    );

    expect(started).toEqual([0, 1]);
    gates[0].resolve(undefined);
    await nextTurn();
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve(undefined);
    await nextTurn();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve(undefined);
    gates[3].resolve(undefined);

    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  test("releases a slot after synchronous throws and rejected operations", async () => {
    const scheduler = new Scheduler(1);
    const syncFailure = scheduler.run(() => {
      throw new Error("sync");
    });
    const rejected = scheduler.run(() => Promise.reject(new Error("reject")));
    const succeeding = scheduler.run(() => "done");

    await expect(syncFailure).rejects.toThrow("sync");
    await expect(rejected).rejects.toThrow("reject");
    await expect(succeeding).resolves.toBe("done");
  });

  test("rejects already-aborted work without invoking or queuing it", async () => {
    const scheduler = new Scheduler(1);
    const controller = new AbortController();
    controller.abort();
    let invoked = false;

    await expect(
      scheduler.run(() => {
        invoked = true;
      }, controller.signal),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: true,
    });
    expect(invoked).toBe(false);
  });

  test("removes aborted queued work and immediately admits the next waiter", async () => {
    const scheduler = new Scheduler(1);
    const gate = deferred();
    const first = scheduler.run(() => gate.promise);
    const controller = new AbortController();
    let cancelledInvoked = false;
    const cancelled = scheduler.run(() => {
      cancelledInvoked = true;
    }, controller.signal);
    let nextInvoked = false;
    const next = scheduler.run(() => {
      nextInvoked = true;
      return "next";
    });

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: true,
    });
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(next).resolves.toBe("next");
    expect(cancelledInvoked).toBe(false);
    expect(nextInvoked).toBe(true);
  });

  test("settles dequeue-versus-abort races once without growing the queue", async () => {
    const scheduler = new Scheduler(1);
    for (let index = 0; index < 50; index += 1) {
      const gate = deferred();
      const active = scheduler.run(() => gate.promise);
      const controller = new AbortController();
      let calls = 0;
      const racing = scheduler.run(() => {
        calls += 1;
        return "started";
      }, controller.signal);
      gate.resolve();
      controller.abort();

      const outcome = await racing.then(
        () => "started",
        (error: unknown) => {
          expect(error).toMatchObject({ code: "CANCELLED", recoverable: true });
          return "cancelled";
        },
      );
      await expect(active).resolves.toBeUndefined();
      expect(calls).toBe(outcome === "started" ? 1 : 0);
    }
  });

  test("balances abort listeners for queued cancellation and admission", async () => {
    const scheduler = new Scheduler(1);
    const gate = deferred();
    const active = scheduler.run(() => gate.promise);
    const cancelledController = new AbortController();
    const cancelledListeners = countAbortListeners(cancelledController.signal);
    const cancelled = scheduler.run(
      () => "unreachable",
      cancelledController.signal,
    );
    const startedController = new AbortController();
    const startedListeners = countAbortListeners(startedController.signal);
    const started = scheduler.run(() => "started", startedController.signal);

    cancelledController.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
    gate.resolve();
    await active;
    await expect(started).resolves.toBe("started");

    expect(cancelledListeners.added()).toBe(1);
    expect(cancelledListeners.removed()).toBe(1);
    expect(startedListeners.added()).toBe(1);
    expect(startedListeners.removed()).toBe(1);
  });
});
