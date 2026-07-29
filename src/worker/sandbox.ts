import vm from "node:vm";

import {
  AwslError,
  type AwslErrorCode,
  type AwslErrorJSON,
} from "../core/errors.js";
import { strictJsonClone, strictJsonPacket } from "./json.js";
import type { BudgetSnapshot } from "./protocol.js";

export class RunAbortError extends Error {
  readonly code = "CANCELLED" as const;
  readonly #brand = true;
  constructor() {
    super("workflow run cancelled");
    this.name = "RunAbortError";
  }
  isLocal(): boolean {
    return this.#brand;
  }
}

export interface SandboxOptions {
  code: string;
  filename: string;
  args: unknown;
  budget: BudgetSnapshot;
  scriptTimeoutMs?: number;
  watchdogMs?: number;
  request(
    method: "agent" | "workflow" | "phase" | "log",
    params: unknown,
  ): Promise<{ value: unknown; budget?: BudgetSnapshot }>;
  onBudget?(budget: BudgetSnapshot): void;
  signal: AbortSignal;
}

function jsonClone(value: unknown): unknown {
  try {
    return strictJsonClone(value, "workflow result");
  } catch (error) {
    throw new AwslError(
      "WORKFLOW_ERROR",
      "workflow result must be strict JSON data",
      { recoverable: false, cause: error },
    );
  }
}

function cancelledError(message = "workflow run cancelled"): AwslErrorJSON {
  return {
    name: "AwslError",
    code: "CANCELLED",
    message,
    recoverable: false,
  };
}

function serializedError(error: unknown, aborted: boolean): AwslErrorJSON {
  if (error instanceof AwslError) return error.toJSON();
  if (aborted || error instanceof RunAbortError)
    return cancelledError(
      error instanceof Error ? error.message : "workflow run cancelled",
    );
  return new AwslError(
    "WORKFLOW_ERROR",
    error instanceof Error ? error.message : String(error),
    { recoverable: false, cause: error },
  ).toJSON();
}

function parseErrorJson(value: string): AwslErrorJSON | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<AwslErrorJSON>;
    if (
      parsed.name !== "AwslError" ||
      typeof parsed.code !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.recoverable !== "boolean"
    )
      return undefined;
    return {
      name: "AwslError",
      code: parsed.code as AwslErrorCode,
      message: parsed.message,
      recoverable: parsed.recoverable,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      ...(typeof parsed.callId === "string" ? { callId: parsed.callId } : {}),
      ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
      ...(typeof parsed.provider === "string"
        ? { provider: parsed.provider }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function restoredError(json: AwslErrorJSON, cause: unknown): AwslError {
  return new AwslError(json.code, json.message, {
    recoverable: json.recoverable,
    runId: json.runId,
    callId: json.callId,
    phase: json.phase,
    provider: json.provider,
    cause,
  });
}

export async function executeSandbox(
  options: SandboxOptions,
): Promise<unknown> {
  const budget = options.budget;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const timerIds = new Map<number, ReturnType<typeof setTimeout>>();
  const brandedErrors = new WeakMap<object, AwslErrorJSON>();
  let nextTimerId = 0;
  let timerFailure: unknown;
  let rejectTimerFailure!: (error: unknown) => void;
  const timerFailed = new Promise<never>((_, reject) => {
    rejectTimerFailure = reject;
  });
  // Notification pressure is deliberately bounded: logs are diagnostic, never workflow control.
  const MAX_PENDING_NOTIFICATIONS = 256;
  const MAX_NOTIFICATION_PAYLOAD = 8_192;
  let pendingNotifications = 0;
  let notificationTail = Promise.resolve();
  let abortReject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  const watchdogMs = options.watchdogMs ?? 30_000;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatchdog!: (error: unknown) => void;
  let externalRequests = 0;
  let watchdogFinished = false;
  let watchdogGeneration = 0;
  const watchdog = new Promise<never>((_, reject) => {
    rejectWatchdog = reject;
  });
  const clearWatchdog = () => {
    watchdogGeneration += 1;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };
  const armWatchdog = () => {
    clearWatchdog();
    if (watchdogFinished || externalRequests > 0) return;
    const generation = watchdogGeneration;
    watchdogTimer = setTimeout(() => {
      if (
        generation !== watchdogGeneration ||
        watchdogFinished ||
        externalRequests > 0
      )
        return;
      watchdogTimer = undefined;
      rejectWatchdog(new Error("workflow wall-clock watchdog exceeded"));
    }, watchdogMs);
  };
  const beginExternalRequest = () => {
    externalRequests += 1;
    clearWatchdog();
  };
  const endExternalRequest = () => {
    externalRequests -= 1;
    if (externalRequests === 0) armWatchdog();
  };
  const abort = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    timerIds.clear();
    abortReject(
      options.signal.reason instanceof AwslError
        ? options.signal.reason
        : new RunAbortError(),
    );
  };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });

  const bridge = {
    args: options.args === undefined ? null : JSON.stringify(options.args),
    budget: () => JSON.stringify(budget),
    brandError: (error: unknown, json: string) => {
      try {
        if (
          (typeof error !== "object" && typeof error !== "function") ||
          error === null
        )
          return false;
        const parsed = parseErrorJson(json);
        if (!parsed) return false;
        brandedErrors.set(error, parsed);
        return true;
      } catch {
        return false;
      }
    },
    request: async (
      method: "agent" | "workflow" | "phase" | "log",
      params: string,
    ) => {
      const external = method === "agent" || method === "workflow";
      try {
        if (options.signal.aborted) throw new RunAbortError();
        const parsed = JSON.parse(params);
        const request = external
          ? notificationTail.then(async () => {
              beginExternalRequest();
              try {
                return await options.request(method, parsed);
              } finally {
                endExternalRequest();
              }
            })
          : options.request(method, parsed);
        const response = await Promise.race([request, aborted]);
        if (response.budget !== undefined) {
          Object.assign(budget, response.budget);
          options.onBudget?.({ ...budget });
        }
        return JSON.stringify({ ok: true, value: response.value });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: serializedError(error, options.signal.aborted),
        });
      }
    },
    workflowPacket: (reference: unknown, args: unknown, hasArgs: boolean) => {
      const packet = strictJsonClone(
        hasArgs ? { reference, args } : { reference },
        "workflow call",
      );
      const object = packet as { reference: unknown; args?: unknown };
      if (typeof object.reference === "string") {
        if (object.reference.length === 0)
          throw new TypeError("workflow reference must be a nonempty string");
      } else {
        const referenceObject = object.reference;
        if (
          referenceObject === null ||
          typeof referenceObject !== "object" ||
          Array.isArray(referenceObject) ||
          Object.keys(referenceObject).length !== 1 ||
          !("scriptPath" in referenceObject) ||
          typeof (referenceObject as { scriptPath?: unknown }).scriptPath !==
            "string" ||
          (referenceObject as { scriptPath: string }).scriptPath.length === 0
        )
          throw new TypeError(
            "workflow reference must be a nonempty string or { scriptPath }",
          );
      }
      return JSON.stringify(packet);
    },
    agentPacket: (prompt: unknown, options: unknown, phase: unknown) => {
      if (typeof prompt !== "string")
        throw new TypeError("agent prompt must be a string");
      const cloned = strictJsonClone(options ?? {}, "agent options") as Record<
        string,
        unknown
      >;
      if (phase !== undefined && cloned.phase === undefined)
        cloned.phase = phase;
      return strictJsonPacket({ prompt, options: cloned }, "agent call");
    },
    notify: (method: "phase" | "log", params: unknown) => {
      if (pendingNotifications >= MAX_PENDING_NOTIFICATIONS) return;
      let packet: string;
      try {
        packet = strictJsonPacket(params, `${method} notification`);
      } catch {
        return;
      }
      if (packet.length > MAX_NOTIFICATION_PAYLOAD) return;
      pendingNotifications += 1;
      notificationTail = notificationTail
        .then(async () => {
          await options.request(method, JSON.parse(packet));
        })
        .catch(() => {})
        .finally(() => {
          pendingNotifications -= 1;
        });
    },
    setTimeout: (callback: () => void, delay?: number) => {
      try {
        if (options.signal.aborted)
          return JSON.stringify({
            ok: false,
            error: cancelledError(),
          });
        const id = ++nextTimerId;
        const timer = setTimeout(() => {
          timers.delete(timer);
          timerIds.delete(id);
          if (!options.signal.aborted) {
            try {
              Promise.resolve(callback()).catch((error) => {
                if (!timerFailure) {
                  timerFailure = error;
                  rejectTimerFailure(error);
                }
              });
            } catch (error) {
              if (!timerFailure) {
                timerFailure = error;
                rejectTimerFailure(error);
              }
            }
          }
        }, delay);
        timers.add(timer);
        timerIds.set(id, timer);
        return JSON.stringify({ ok: true, id });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: serializedError(error, options.signal.aborted),
        });
      }
    },
    clearTimeout: (id: number) => {
      try {
        const timer = timerIds.get(id);
        if (!timer) return false;
        timerIds.delete(id);
        timers.delete(timer);
        clearTimeout(timer);
        return true;
      } catch {
        return false;
      }
    },
  };

  const context = vm.createContext(
    { __awslBridge: bridge },
    {
      codeGeneration: { strings: false, wasm: false },
    },
  );
  new vm.Script(
    `(() => {
    const bridge = globalThis.__awslBridge;
    const abortErrors = new WeakSet();
    const makeError = (payload) => {
      const error = new Error(String(payload.message));
      error.name = "AwslError";
      error.code = payload.code;
      error.recoverable = payload.recoverable;
      if (payload.runId !== undefined) error.runId = payload.runId;
      if (payload.callId !== undefined) error.callId = payload.callId;
      if (payload.phase !== undefined) error.phase = payload.phase;
      if (payload.provider !== undefined) error.provider = payload.provider;
      if (bridge.brandError(error, JSON.stringify(payload)) && payload.code === "CANCELLED") abortErrors.add(error);
      return error;
    };
    const unwrap = (packet) => {
      if (!packet.ok) throw makeError(packet.error);
      return packet.value;
    };
    const call = async (method, params) => unwrap(JSON.parse(await bridge.request(method, JSON.stringify(params))));
    const latestBudget = () => JSON.parse(bridge.budget());
    globalThis.args = bridge.args === null ? undefined : JSON.parse(bridge.args);
    let currentPhase;
    globalThis.agent = async (prompt, opts) => {
      if (typeof prompt !== "string") throw new TypeError("agent prompt must be a string");
      if (opts !== undefined && (opts === null || typeof opts !== "object" || Array.isArray(opts))) throw new TypeError("agent options must be an object");
      return await call("agent", JSON.parse(bridge.agentPacket(prompt, opts, currentPhase)));
    };
    globalThis.workflow = async function (reference, args) {
      const packet = JSON.parse(bridge.workflowPacket(reference, args, arguments.length >= 2));
      return await call("workflow", packet);
    };
    globalThis.phase = (title) => {
      if (typeof title !== "string") throw new TypeError("phase title must be a string");
      currentPhase = title;
      bridge.notify("phase", { title });
    };
    globalThis.log = (message) => {
      if (typeof message !== "string") throw new TypeError("log message must be a string");
      bridge.notify("log", { message, level: "info" });
    };
    const format = (values) => values.map((value) => String(value)).join(" ");
    const emit = (level, values) => bridge.notify("log", { message: format(values), level });
    globalThis.console = {
      log: (...values) => emit("log", values),
      info: (...values) => emit("info", values),
      warn: (...values) => emit("warn", values),
      error: (...values) => emit("error", values),
      debug: (...values) => emit("debug", values),
    };
    globalThis.budget = Object.freeze({
      get total() { return latestBudget().total; },
      spent: () => latestBudget().spent,
      remaining: () => {
        const value = latestBudget();
        return value.total === null ? Number.POSITIVE_INFINITY : value.total - value.spent;
      },
    });
    globalThis.setTimeout = (callback, delay, ...values) => {
      if (typeof callback !== "function") throw new TypeError("setTimeout callback must be a function");
      const packet = JSON.parse(bridge.setTimeout(() => callback(...values), Number(delay) || 0));
      if (!packet.ok) throw makeError(packet.error);
      return packet.id;
    };
    globalThis.clearTimeout = (timer) => {
      if (typeof timer === "number") bridge.clearTimeout(timer);
    };
    globalThis.parallel = async (thunks) => {
      if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) throw new TypeError("parallel requires an array of functions");
      return Promise.all(thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch (error) {
          if (abortErrors.has(error)) throw error;
          log(String(error));
          return null;
        }
      }));
    };
    globalThis.pipeline = async (items, ...stages) => {
      if (!Array.isArray(items) || stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline requires an array and functions");
      return Promise.all(items.map(async (original, index) => {
        let previous = original;
        try {
          for (const stage of stages) {
            if (previous === null) break;
            previous = await stage(previous, original, index);
          }
          return previous;
        } catch (error) {
          if (abortErrors.has(error)) throw error;
          log(String(error));
          return null;
        }
      }));
    };
    const NativeDate = Date;
    const SafeDate = function (...values) {
      if (!new.target || values.length === 0) throw new Error("Date is disabled in workflows");
      return Reflect.construct(NativeDate, values, SafeDate);
    };
    Object.defineProperties(SafeDate, {
      now: {
        value: () => { throw new Error("Date.now is disabled in workflows"); },
        writable: false,
        configurable: false,
      },
      parse: {
        value: (value) => NativeDate.parse(value),
        writable: false,
        configurable: false,
      },
      UTC: {
        value: (...values) => NativeDate.UTC(...values),
        writable: false,
        configurable: false,
      },
    });
    SafeDate.prototype = NativeDate.prototype;
    Object.defineProperty(NativeDate.prototype, "constructor", { value: SafeDate, configurable: true });
    globalThis.Date = SafeDate;
    Math.random = () => { throw new Error("Math.random is disabled in workflows"); };
    delete globalThis.__awslBridge;
  })()`,
    { filename: "awsl-bootstrap.js" },
  ).runInContext(context);

  const workflowError = (error: unknown): AwslError => {
    if (
      (typeof error === "object" || typeof error === "function") &&
      error !== null
    ) {
      const branded = brandedErrors.get(error);
      if (branded) return restoredError(branded, error);
    }
    if (error instanceof AwslError) return error;
    if (error instanceof RunAbortError)
      return new AwslError("CANCELLED", error.message, {
        recoverable: false,
        cause: error,
      });
    return new AwslError(
      "WORKFLOW_ERROR",
      error instanceof Error ? error.message : String(error),
      { recoverable: false, cause: error },
    );
  };

  try {
    const result = new vm.Script(options.code, {
      filename: options.filename,
    }).runInContext(context, { timeout: options.scriptTimeoutMs ?? 30_000 });
    armWatchdog();
    try {
      const value = await Promise.race([
        Promise.resolve(result),
        aborted,
        watchdog,
        timerFailed,
      ]);
      await Promise.race([notificationTail, aborted, watchdog, timerFailed]);
      return jsonClone(value);
    } finally {
      watchdogFinished = true;
      clearWatchdog();
    }
  } catch (error) {
    throw workflowError(error);
  } finally {
    options.signal.removeEventListener("abort", abort);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    timerIds.clear();
  }
}
