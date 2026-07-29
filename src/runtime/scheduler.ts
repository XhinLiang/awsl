import os from "node:os";

import { AwslError } from "../core/errors.js";

interface QueueEntry {
  operation: (signal?: AbortSignal) => unknown | Promise<unknown>;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  abortListener?: () => void;
}

function cancelledError(): AwslError {
  return new AwslError("CANCELLED", "Scheduled operation was cancelled", {
    recoverable: true,
  });
}

export function runtimeConcurrency(cpus = os.cpus().length): number {
  if (!Number.isFinite(cpus) || !Number.isInteger(cpus)) {
    throw new RangeError("CPU count must be a finite integer");
  }
  return Math.min(16, Math.max(2, cpus - 2));
}

export class Scheduler {
  private readonly queue: QueueEntry[] = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("Scheduler limit must be a positive integer");
    }
  }

  run<T>(
    operation: (signal?: AbortSignal) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(cancelledError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        operation,
        reject,
        resolve: (value) => resolve(value as T),
        signal,
      };
      if (this.active < this.limit) {
        this.start(entry);
        return;
      }

      this.queue.push(entry);
      if (signal) {
        entry.abortListener = () => this.cancel(entry);
        signal.addEventListener("abort", entry.abortListener, { once: true });
        if (signal.aborted) this.cancel(entry);
      }
    });
  }

  private cancel(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index === -1) return;

    this.queue.splice(index, 1);
    this.removeAbortListener(entry);
    entry.reject(cancelledError());
  }

  private start(entry: QueueEntry): void {
    this.removeAbortListener(entry);
    this.active += 1;

    let result: unknown | Promise<unknown>;
    try {
      result = entry.operation(entry.signal);
    } catch (error) {
      this.finish();
      entry.reject(error);
      return;
    }

    Promise.resolve(result).then(
      (value) => {
        this.finish();
        entry.resolve(value);
      },
      (error: unknown) => {
        this.finish();
        entry.reject(error);
      },
    );
  }

  private finish(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.start(entry);
    }
  }

  private removeAbortListener(entry: QueueEntry): void {
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
  }
}
