import { type ChildProcess, type ForkOptions, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompiledWorkflow } from "../compat/compile.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "./json.js";
import {
  MAX_PENDING_WORKER_REQUESTS,
  MAX_WORKER_AGENT_CALLS,
  isChildMessage,
  isParentMessage,
} from "./protocol.js";
import type {
  BudgetSnapshot,
  ChildMessage,
  ParentMessage,
  WorkerResponse,
} from "./protocol.js";

export interface WorkerHostOptions {
  workerPath?: string;
  forkWorker?: (
    modulePath: string,
    args: string[],
    options: ForkOptions,
  ) => ChildProcess;
  maxOldSpaceMb?: number;
  scriptTimeoutMs?: number;
  watchdogMs?: number;
  abortGraceMs?: number;
  budget?: BudgetSnapshot;
  agent?: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<WorkerHandlerResult>;
  workflow?: (
    reference: unknown,
    args: unknown,
  ) => Promise<WorkerHandlerResult>;
  onLog?: (message: string, level: string) => void;
  onPhase?: (title: string) => void;
  onBudget?: (budget: BudgetSnapshot) => void;
}
export interface WorkerHandlerResult {
  value: unknown;
  budget?: BudgetSnapshot;
}
export interface WorkerRun extends CompiledWorkflow {
  args?: unknown;
  runId?: string;
}

function validateBudget(value: unknown): BudgetSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("budget must be a BudgetSnapshot");
  const { total, spent } = value as Record<string, unknown>;
  if (
    (total !== null &&
      (typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0)) ||
    typeof spent !== "number" ||
    !Number.isSafeInteger(spent) ||
    spent < 0
  )
    throw new TypeError("budget must be a BudgetSnapshot");
  return { total: total as number | null, spent };
}

function handlerResult(value: unknown): WorkerHandlerResult {
  const result = strictJsonClone(value, "WorkerHandlerResult");
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Object.prototype.hasOwnProperty.call(result, "value")
  )
    throw new TypeError("handler must return an explicit WorkerHandlerResult");
  const cloned = result as WorkerHandlerResult;
  return {
    value: cloned.value,
    ...(cloned.budget === undefined
      ? {}
      : { budget: validateBudget(cloned.budget) }),
  };
}

function errorFrom(json: {
  code: AwslError["code"];
  message: string;
  recoverable?: boolean;
  runId?: string;
  callId?: string;
  phase?: string;
  provider?: string;
}) {
  return new AwslError(json.code, json.message, {
    recoverable: json.recoverable ?? false,
    runId: json.runId,
    callId: json.callId,
    phase: json.phase,
    provider: json.provider,
  });
}
export class WorkerHost {
  readonly options: Readonly<WorkerHostOptions>;
  readonly #maxOldSpaceMb: number;
  #child?: ChildProcess;
  #budget: BudgetSnapshot;
  #settle?: {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  };
  #watchdog?: ReturnType<typeof setTimeout>;
  #watchdogGeneration = 0;
  #abortTimer?: ReturnType<typeof setTimeout>;
  #aborting = false;
  #poisoned = false;
  #closed = false;
  #abortError?: AwslError;
  #activeRun?: Promise<unknown>;
  #inflight = new Set<string>();
  #watchdogSuspensions = new Set<string>();
  #agentCalls = 0;
  constructor(options: WorkerHostOptions = {}) {
    for (const [name, value] of Object.entries({
      scriptTimeoutMs: options.scriptTimeoutMs,
      watchdogMs: options.watchdogMs,
      abortGraceMs: options.abortGraceMs,
    }))
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      )
        throw new AwslError(
          "CONFIG_ERROR",
          `${name} must be a positive integer no greater than 2147483647`,
          { recoverable: false },
        );
    const maxOldSpaceMb = options.maxOldSpaceMb ?? 128;
    if (
      !Number.isInteger(maxOldSpaceMb) ||
      maxOldSpaceMb < 16 ||
      maxOldSpaceMb > 4096
    )
      throw new AwslError(
        "CONFIG_ERROR",
        "maxOldSpaceMb must be an integer between 16 and 4096",
        { recoverable: false },
      );
    this.#maxOldSpaceMb = maxOldSpaceMb;
    this.options = Object.freeze({ ...options });
    try {
      this.#budget = validateBudget(
        options.budget ?? { total: null, spent: 0 },
      );
    } catch (error) {
      throw new AwslError("CONFIG_ERROR", "invalid initial worker budget", {
        recoverable: false,
        cause: error,
      });
    }
  }
  async run(run: WorkerRun): Promise<unknown> {
    if (this.#closed)
      throw new AwslError("WORKFLOW_ERROR", "worker host is closed", {
        recoverable: false,
      });
    if (this.#poisoned)
      throw new AwslError(
        "WORKFLOW_ERROR",
        "worker host cannot be reused after abort",
        { recoverable: false },
      );
    if (this.#child !== undefined)
      throw new AwslError(
        "WORKFLOW_ERROR",
        "worker host already has an active run",
        { recoverable: false },
      );
    let args: unknown;
    if (
      run.runId !== undefined &&
      (typeof run.runId !== "string" ||
        run.runId.length === 0 ||
        Buffer.byteLength(run.runId, "utf8") > 256)
    )
      throw new AwslError(
        "WORKFLOW_ERROR",
        "worker run identifier is invalid",
        {
          recoverable: false,
        },
      );
    try {
      args =
        run.args === undefined
          ? undefined
          : strictJsonClone(run.args, "workflow args");
    } catch (error) {
      throw new AwslError(
        "WORKFLOW_ERROR",
        "workflow args must be strict JSON data",
        { recoverable: false, cause: error },
      );
    }
    const bundledWorker = fileURLToPath(new URL("./main.js", import.meta.url));
    const workerPath =
      this.options.workerPath ??
      (existsSync(bundledWorker)
        ? bundledWorker
        : resolve(process.cwd(), "dist/worker/main.js"));
    const child = (this.options.forkWorker ?? fork)(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [`--max-old-space-size=${this.#maxOldSpaceMb}`],
    });
    this.#child = child;
    this.#inflight.clear();
    this.#watchdogSuspensions.clear();
    this.#agentCalls = 0;
    let childExited = false;
    let resolveChildExit: (() => void) | undefined;
    child.once("exit", () => {
      childExited = true;
      resolveChildExit?.();
    });
    child.once("close", () => {
      childExited = true;
      resolveChildExit?.();
    });
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    });
    const active = new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        this.#clearWatchdog();
        if (this.#abortTimer) clearTimeout(this.#abortTimer);
        this.#abortTimer = undefined;
        this.#settle = undefined;
        this.#watchdogSuspensions.clear();
        void (async () => {
          if (!childExited)
            await new Promise<void>((done) => {
              resolveChildExit = done;
              const force = setTimeout(() => {
                if (!childExited) {
                  try {
                    child.kill("SIGKILL");
                  } catch {}
                }
              }, this.options.abortGraceMs ?? 50);
              const complete = () => {
                clearTimeout(force);
                done();
              };
              resolveChildExit = complete;
              if (!child.killed) {
                try {
                  child.kill();
                } catch {}
              }
              if (child.connected) {
                try {
                  child.disconnect();
                } catch {}
              }
              if (childExited) done();
            });
          if (this.#child === child) this.#child = undefined;
          this.#aborting = false;
          child.removeAllListeners();
          error === undefined ? resolve(value) : reject(error);
        })();
      };
      this.#settle = {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      };
      child.once("error", (error) =>
        finish(
          new AwslError("WORKFLOW_ERROR", error.message, {
            recoverable: false,
            cause: error,
          }),
        ),
      );
      child.once("exit", (code, signal) => {
        if (this.#settle) {
          if (!this.#aborting) this.#poisoned = true;
          finish(
            this.#aborting && this.#abortError
              ? this.#abortError
              : new AwslError(
                  "WORKFLOW_ERROR",
                  `worker exited unexpectedly (${code ?? signal ?? "unknown"}): ${stderr}`,
                  { recoverable: false },
                ),
          );
        }
      });
      child.on(
        "message",
        (message: ChildMessage) => void this.#onMessage(child, message),
      );
      this.#armWatchdog(child);
      this.#send({
        type: "start",
        runId: run.runId ?? "run",
        code: run.code,
        filename: run.filename,
        ...(args === undefined ? {} : { args }),
        budget: this.#budget,
        ...(this.options.scriptTimeoutMs === undefined
          ? {}
          : { scriptTimeoutMs: this.options.scriptTimeoutMs }),
        ...(this.options.watchdogMs === undefined
          ? {}
          : { watchdogMs: this.options.watchdogMs }),
      });
    });
    const tracked = active.finally(() => {
      if (this.#activeRun === tracked) this.#activeRun = undefined;
    });
    this.#activeRun = tracked;
    return tracked;
  }
  abort(error?: AwslError): void {
    if (this.#aborting || !this.#settle) return;
    if (
      error !== undefined &&
      (!(error instanceof AwslError) || error.code !== "CANCELLED")
    )
      throw new AwslError(
        "WORKFLOW_ERROR",
        "abort error must be CANCELLED AwslError",
        { recoverable: false },
      );
    this.#aborting = true;
    this.#poisoned = true;
    this.#clearWatchdog();
    this.#abortError = error
      ? errorFrom(error.toJSON())
      : new AwslError("CANCELLED", "workflow run cancelled", {
          recoverable: false,
        });
    this.#send({ type: "run.abort", error: this.#abortError.toJSON() });
    this.#abortTimer = setTimeout(
      () => this.#settle?.reject(this.#abortError),
      this.options.abortGraceMs ?? 50,
    );
  }
  updateBudget(budget: BudgetSnapshot): void {
    let next: BudgetSnapshot;
    try {
      next = validateBudget(budget);
    } catch (error) {
      throw new AwslError("WORKFLOW_ERROR", "invalid worker budget update", {
        recoverable: false,
        cause: error,
      });
    }
    if (this.#child !== undefined) {
      if (next.total !== this.#budget.total)
        throw new AwslError(
          "WORKFLOW_ERROR",
          "worker budget total is immutable during an active run",
          { recoverable: false },
        );
      if (next.spent < this.#budget.spent)
        throw new AwslError(
          "WORKFLOW_ERROR",
          "worker budget spent cannot regress during an active run",
          { recoverable: false },
        );
    }
    this.#budget = next;
    this.options.onBudget?.({ ...this.#budget });
    this.#send({ type: "budget.updated", budget: this.#budget });
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.abort();
    await this.#activeRun?.catch(() => {});
  }
  #send(message: ParentMessage) {
    const child = this.#child;
    if (!isParentMessage(message)) {
      if (child) this.#failClosed(child, "invalid outbound worker IPC message");
      return;
    }
    if (!child?.connected) return;
    try {
      const accepted = child.send(message, (error) => {
        if (error && this.#child === child && !this.#aborting)
          this.#settle?.reject(
            new AwslError("WORKFLOW_ERROR", error.message, {
              recoverable: false,
              cause: error,
            }),
          );
      });
      if (!accepted)
        this.#failClosed(child, "worker IPC send backpressure exceeded");
    } catch (error) {
      if (this.#child === child && !this.#aborting)
        this.#settle?.reject(
          new AwslError(
            "WORKFLOW_ERROR",
            error instanceof Error ? error.message : String(error),
            { recoverable: false, cause: error },
          ),
        );
    }
  }
  #sendChild(child: ChildProcess, message: ParentMessage | WorkerResponse) {
    if (!isParentMessage(message)) {
      this.#failClosed(child, "invalid outbound worker IPC message");
      return;
    }
    if (!child.connected) return;
    try {
      const accepted = child.send(message, (error) => {
        if (error && this.#child === child && !this.#aborting)
          this.#settle?.reject(
            new AwslError("WORKFLOW_ERROR", error.message, {
              recoverable: false,
              cause: error,
            }),
          );
      });
      if (!accepted)
        this.#failClosed(child, "worker IPC send backpressure exceeded");
    } catch (error) {
      if (this.#child === child && !this.#aborting)
        this.#settle?.reject(
          new AwslError(
            "WORKFLOW_ERROR",
            error instanceof Error ? error.message : String(error),
            { recoverable: false, cause: error },
          ),
        );
    }
  }
  async #onMessage(child: ChildProcess, message: ChildMessage) {
    if (!isChildMessage(message)) {
      this.#failClosed(child, "invalid worker IPC message");
      return;
    }
    if (message.type === "result") {
      this.#aborting
        ? this.#settle?.reject(this.#abortError)
        : !("error" in message)
          ? this.#settle?.resolve(message.value)
          : this.#settle?.reject(errorFrom(message.error));
      return;
    }
    if (
      this.#inflight.has(message.id) ||
      this.#inflight.size >= MAX_PENDING_WORKER_REQUESTS ||
      (message.method === "agent" && this.#agentCalls >= MAX_WORKER_AGENT_CALLS)
    ) {
      this.#failClosed(child, "worker IPC request limit exceeded");
      return;
    }
    this.#inflight.add(message.id);
    if (message.method === "agent") this.#agentCalls += 1;
    const suspendsWatchdog =
      message.method === "agent" || message.method === "workflow";
    if (suspendsWatchdog) {
      this.#watchdogSuspensions.add(message.id);
      this.#clearWatchdog();
    }
    try {
      let response: WorkerResponse;
      try {
        if (message.method === "agent") {
          const p = message.params as {
            prompt: string;
            options: Record<string, unknown>;
          };
          if (!this.options.agent)
            throw new TypeError("agent handler is not configured");
          const output = handlerResult(
            await this.options.agent(p.prompt, p.options),
          );
          if (this.#child !== child || this.#aborting) return;
          const value = output.value;
          if (output.budget) this.#acceptResponseBudget(output.budget);
          response = {
            type: "response",
            id: message.id,
            ok: true,
            value,
            budget: { ...this.#budget },
          };
        } else if (message.method === "workflow") {
          const p = message.params as { reference: unknown; args: unknown };
          if (!this.options.workflow)
            throw new TypeError("workflow handler is not configured");
          const output = handlerResult(
            await this.options.workflow(p.reference, p.args),
          );
          if (this.#child !== child || this.#aborting) return;
          const value = output.value;
          if (output.budget) this.#acceptResponseBudget(output.budget);
          response = {
            type: "response",
            id: message.id,
            ok: true,
            value,
            budget: { ...this.#budget },
          };
        } else if (message.method === "phase") {
          this.options.onPhase?.((message.params as { title: string }).title);
          response = {
            type: "response",
            id: message.id,
            ok: true,
            value: null,
            budget: { ...this.#budget },
          };
        } else {
          const p = message.params as { message: string; level?: string };
          this.options.onLog?.(p.message, p.level ?? "info");
          response = {
            type: "response",
            id: message.id,
            ok: true,
            value: null,
            budget: { ...this.#budget },
          };
        }
        if (this.#child !== child || this.#aborting) return;
        this.options.onBudget?.({ ...response.budget });
        this.#sendChild(child, {
          type: "budget.updated",
          budget: response.budget,
        });
      } catch (error) {
        if (this.#child !== child || this.#aborting) return;
        response = {
          type: "response",
          id: message.id,
          ok: false,
          error:
            error instanceof AwslError
              ? error.toJSON()
              : new AwslError(
                  "WORKFLOW_ERROR",
                  error instanceof Error ? error.message : String(error),
                  { recoverable: false, cause: error },
                ).toJSON(),
          budget: { ...this.#budget },
        };
      }
      this.#sendChild(child, response);
    } finally {
      if (this.#child === child) {
        this.#inflight.delete(message.id);
        if (suspendsWatchdog) {
          this.#watchdogSuspensions.delete(message.id);
          this.#armWatchdog(child);
        }
      }
    }
  }
  #clearWatchdog() {
    this.#watchdogGeneration += 1;
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }
  #armWatchdog(child: ChildProcess) {
    if (this.#child !== child) return;
    this.#clearWatchdog();
    if (!this.#settle || this.#aborting || this.#watchdogSuspensions.size > 0)
      return;
    const generation = this.#watchdogGeneration;
    this.#watchdog = setTimeout(
      () => {
        if (
          generation !== this.#watchdogGeneration ||
          this.#child !== child ||
          !this.#settle ||
          this.#aborting ||
          this.#watchdogSuspensions.size > 0
        )
          return;
        this.abort();
      },
      (this.options.watchdogMs ?? 30_000) + 100,
    );
  }
  #failClosed(child: ChildProcess, message: string) {
    if (this.#child !== child) return;
    this.#poisoned = true;
    this.#settle?.reject(
      new AwslError("WORKFLOW_ERROR", message, { recoverable: false }),
    );
  }
  #acceptResponseBudget(budget: BudgetSnapshot) {
    if (budget.total !== this.#budget.total)
      throw new TypeError(
        "handler budget total is immutable during an active run",
      );
    if (budget.spent > this.#budget.spent) this.#budget = budget;
  }
}
