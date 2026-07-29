import { AwslError } from "../core/errors.js";
import {
  MAX_PENDING_WORKER_REQUESTS,
  MAX_WORKER_AGENT_CALLS,
  isParentMessage,
} from "./protocol.js";
import type {
  ChildMessage,
  ParentMessage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
import { executeSandbox } from "./sandbox.js";

function serialize(error: unknown) {
  return error instanceof AwslError
    ? error.toJSON()
    : new AwslError(
        "WORKFLOW_ERROR",
        error instanceof Error ? error.message : String(error),
        { recoverable: false, cause: error },
      ).toJSON();
}
function restore(
  error: NonNullable<Extract<ParentMessage, { type: "run.abort" }>["error"]>,
) {
  return new AwslError(error.code, error.message, {
    recoverable: error.recoverable,
    runId: error.runId,
    callId: error.callId,
    phase: error.phase,
    provider: error.provider,
  });
}
let controller: AbortController | undefined;
let activeBudget: { total: number | null; spent: number } | undefined;
let nextId = 0;
let agentCalls = 0;
let started = false;
function failClosed(message: string): never {
  const error = new AwslError("WORKFLOW_ERROR", message, {
    recoverable: false,
  });
  controller?.abort(error);
  rejectPending(error);
  process.disconnect?.();
  process.exit(1);
}
const pending = new Map<
  string,
  {
    resolve: (value: {
      value: unknown;
      budget?: { total: number | null; spent: number };
    }) => void;
    reject: (error: unknown) => void;
  }
>();
function send(message: ChildMessage) {
  if (!process.connected || !process.send)
    failClosed("worker IPC channel is unavailable");
  try {
    const accepted = process.send(message, (error) => {
      if (error)
        failClosed(`worker IPC send callback failed: ${error.message}`);
    });
    if (!accepted) failClosed("worker IPC send backpressure exceeded");
  } catch {
    failClosed("worker IPC send failed");
  }
}
function rejectPending(error: AwslError) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}
process.on("message", (message: unknown) => {
  if (!isParentMessage(message)) {
    rejectPending(
      new AwslError("WORKFLOW_ERROR", "invalid parent IPC message", {
        recoverable: false,
      }),
    );
    failClosed("invalid parent IPC message");
  }
  if (message.type === "response") {
    if (!started) failClosed("worker received response before start");
    const waiter = pending.get(message.id);
    if (!waiter) failClosed("worker received unknown response id");
    pending.delete(message.id);
    if (activeBudget) Object.assign(activeBudget, message.budget);
    if (message.ok)
      waiter.resolve({ value: message.value, budget: message.budget });
    else
      waiter.reject(
        new AwslError(
          message.error?.code ?? "WORKFLOW_ERROR",
          message.error?.message ?? "worker request failed",
          {
            recoverable: message.error?.recoverable ?? false,
            runId: message.error?.runId,
            callId: message.error?.callId,
            phase: message.error?.phase,
            provider: message.error?.provider,
          },
        ),
      );
    return;
  }
  if (message.type === "budget.updated") {
    if (!started) failClosed("worker received budget before start");
    if (activeBudget) Object.assign(activeBudget, message.budget);
    return;
  }
  if (message.type === "run.abort") {
    if (!started) failClosed("worker received abort before start");
    const error = restore(message.error);
    controller?.abort(error);
    rejectPending(error);
    return;
  }
  if (started) failClosed("worker received duplicate start");
  started = true;
  controller = new AbortController();
  activeBudget = { ...message.budget };
  agentCalls = 0;
  const request = (method: WorkerRequest["method"], params: unknown) =>
    new Promise<{
      value: unknown;
      budget?: { total: number | null; spent: number };
    }>((resolve, reject) => {
      if (
        pending.size >= MAX_PENDING_WORKER_REQUESTS ||
        (method === "agent" && agentCalls >= MAX_WORKER_AGENT_CALLS)
      ) {
        reject(
          new AwslError("WORKFLOW_ERROR", "worker IPC request limit exceeded", {
            recoverable: false,
          }),
        );
        failClosed("worker IPC request limit exceeded");
        return;
      }
      const id = String(++nextId);
      if (pending.has(id)) {
        reject(
          new AwslError("WORKFLOW_ERROR", "duplicate worker IPC request id", {
            recoverable: false,
          }),
        );
        failClosed("duplicate worker IPC request id");
        return;
      }
      if (method === "agent") agentCalls += 1;
      pending.set(id, { resolve, reject });
      send({ type: "request", id, method, params });
    });
  void executeSandbox({
    ...message,
    args: message.args,
    budget: activeBudget,
    request,
    signal: controller.signal,
  }).then(
    (value) => send({ type: "result", value }),
    (error) => send({ type: "result", error: serialize(error) }),
  );
});
