import type { AwslErrorCode, AwslErrorJSON } from "../core/errors.js";

export const MAX_PENDING_WORKER_REQUESTS = 1_024;
export const MAX_WORKER_AGENT_CALLS = 1_000;
export const MAX_IPC_PACKET_BYTES = 8 * 1024 * 1024;
export const MAX_IPC_PACKET_DEPTH = 64;
export const MAX_IPC_PACKET_NODES = 100_000;
export interface BudgetSnapshot {
  total: number | null;
  spent: number;
}
export interface WorkerStart {
  type: "start";
  runId: string;
  code: string;
  filename: string;
  args?: unknown;
  budget: BudgetSnapshot;
  scriptTimeoutMs?: number;
  watchdogMs?: number;
}
export interface WorkerRequest {
  type: "request";
  id: string;
  method: "agent" | "workflow" | "phase" | "log";
  params: unknown;
}
export type WorkerResponse =
  | {
      type: "response";
      id: string;
      ok: true;
      value: unknown;
      budget: BudgetSnapshot;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: AwslErrorJSON;
      budget: BudgetSnapshot;
    };
export type WorkerBroadcast =
  | { type: "budget.updated"; budget: BudgetSnapshot }
  | { type: "run.abort"; error: AwslErrorJSON };
export type WorkerResult =
  | { type: "result"; value: unknown }
  | { type: "result"; error: AwslErrorJSON };
export type ParentMessage = WorkerStart | WorkerResponse | WorkerBroadcast;
export type ChildMessage = WorkerRequest | WorkerResult;

const CODES: ReadonlySet<AwslErrorCode> = new Set([
  "USAGE_ERROR",
  "CONFIG_ERROR",
  "COMPATIBILITY_ERROR",
  "WORKFLOW_ERROR",
  "PROVIDER_ERROR",
  "SCHEMA_ERROR",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "PERSISTENCE_ERROR",
  "WORKTREE_ERROR",
]);
function record(x: unknown): x is Record<string, unknown> {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    (Object.getPrototypeOf(x) === Object.prototype ||
      Object.getPrototypeOf(x) === null)
  );
}
function data(x: Record<string, unknown>, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(x, k);
  return d && "value" in d ? d.value : undefined;
}
function exact(x: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(x);
  return (
    actual.length === keys.length &&
    actual.every((k) => {
      const d =
        typeof k === "string"
          ? Object.getOwnPropertyDescriptor(x, k)
          : undefined;
      return (
        typeof k === "string" &&
        keys.includes(k) &&
        !!d?.enumerable &&
        "value" in (d ?? {})
      );
    })
  );
}
function keys(
  x: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Reflect.ownKeys(x);
  return (
    actual.every((k) => {
      const d =
        typeof k === "string"
          ? Object.getOwnPropertyDescriptor(x, k)
          : undefined;
      return (
        typeof k === "string" &&
        [...required, ...optional].includes(k) &&
        !!d?.enumerable &&
        "value" in (d ?? {})
      );
    }) && required.every((k) => Object.hasOwn(x, k))
  );
}
function text(x: unknown, max: number): x is string {
  return typeof x === "string" && Buffer.byteLength(x, "utf8") <= max;
}
function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
export function isPacketData(value: unknown): boolean {
  const seen = new Set<object>();
  const work: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  let bytes = 0;
  while (work.length) {
    const item = work.pop();
    if (!item) return false;
    const [v, depth] = item;
    if (++nodes > MAX_IPC_PACKET_NODES || depth > MAX_IPC_PACKET_DEPTH)
      return false;
    if (v === null || typeof v === "boolean") {
      bytes += 5;
      continue;
    }
    if (typeof v === "string") {
      bytes += jsonStringBytes(v);
      if (bytes > MAX_IPC_PACKET_BYTES) return false;
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return false;
      bytes += 32;
      continue;
    }
    if (
      typeof v !== "object" ||
      seen.has(v) ||
      (!Array.isArray(v) && !record(v))
    )
      return false;
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const own = Reflect.ownKeys(descriptors);
    if (own.some((k) => typeof k === "symbol")) return false;
    if (Array.isArray(v)) {
      bytes += 2 + Math.max(0, v.length - 1);
      if (own.length !== v.length + 1) return false;
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !d.enumerable) return false;
        work.push([d.value, depth + 1]);
      }
    } else {
      bytes += 2 + Math.max(0, own.length - 1);
      for (const k of own as string[]) {
        const d = descriptors[k];
        if (!("value" in d) || !d.enumerable) return false;
        bytes += jsonStringBytes(k) + 1;
        work.push([d.value, depth + 1]);
      }
    }
    if (bytes > MAX_IPC_PACKET_BYTES) return false;
  }
  return true;
}
export function isBudgetSnapshot(x: unknown): x is BudgetSnapshot {
  if (!record(x) || !exact(x, ["total", "spent"])) return false;
  const total = data(x, "total");
  const spent = data(x, "spent");
  return (
    (total === null ||
      (typeof total === "number" &&
        Number.isSafeInteger(total) &&
        total >= 0)) &&
    typeof spent === "number" &&
    Number.isSafeInteger(spent) &&
    spent >= 0
  );
}
export function isAwslErrorJson(x: unknown): x is AwslErrorJSON {
  return (
    record(x) &&
    keys(
      x,
      ["name", "code", "message", "recoverable"],
      ["runId", "callId", "phase", "provider"],
    ) &&
    data(x, "name") === "AwslError" &&
    typeof data(x, "code") === "string" &&
    CODES.has(data(x, "code") as AwslErrorCode) &&
    text(data(x, "message"), 16_384) &&
    typeof data(x, "recoverable") === "boolean" &&
    ["runId", "callId", "phase", "provider"].every(
      (k) => !Object.hasOwn(x, k) || text(data(x, k), 512),
    )
  );
}
function id(x: unknown): x is string {
  return text(x, 256) && x.length > 0;
}
function timeout(x: unknown): boolean {
  return (
    typeof x === "number" &&
    Number.isSafeInteger(x) &&
    x > 0 &&
    x <= 2_147_483_647
  );
}
export function isChildMessage(x: unknown): x is ChildMessage {
  if (!record(x) || !isPacketData(x)) return false;
  if (data(x, "type") === "result")
    return (
      (exact(x, ["type", "value"]) && isPacketData(data(x, "value"))) ||
      (exact(x, ["type", "error"]) && isAwslErrorJson(data(x, "error")))
    );
  if (
    data(x, "type") !== "request" ||
    !exact(x, ["type", "id", "method", "params"]) ||
    !id(data(x, "id"))
  )
    return false;
  const m = data(x, "method");
  const p = data(x, "params");
  if (!record(p)) return false;
  if (m === "agent")
    return (
      exact(p, ["prompt", "options"]) &&
      text(data(p, "prompt"), MAX_IPC_PACKET_BYTES) &&
      record(data(p, "options"))
    );
  if (m === "workflow") {
    if (!keys(p, ["reference"], ["args"])) return false;
    const reference = data(p, "reference");
    return (
      ((text(reference, 4096) && reference.length > 0) ||
        (record(reference) &&
          exact(reference, ["scriptPath"]) &&
          text(data(reference, "scriptPath"), 4096) &&
          (data(reference, "scriptPath") as string).length > 0)) &&
      (!Object.hasOwn(p, "args") || isPacketData(data(p, "args")))
    );
  }
  if (m === "phase") return exact(p, ["title"]) && text(data(p, "title"), 4096);
  return (
    m === "log" &&
    exact(p, ["message", "level"]) &&
    text(data(p, "message"), 8192) &&
    text(data(p, "level"), 64)
  );
}
export function isParentMessage(x: unknown): x is ParentMessage {
  if (!record(x) || !isPacketData(x)) return false;
  const t = data(x, "type");
  if (t === "start")
    return (
      keys(
        x,
        ["type", "runId", "code", "filename", "budget"],
        ["args", "scriptTimeoutMs", "watchdogMs"],
      ) &&
      text(data(x, "runId"), 256) &&
      text(data(x, "code"), 512 * 1024) &&
      text(data(x, "filename"), 4096) &&
      (data(x, "args") === undefined || isPacketData(data(x, "args"))) &&
      isBudgetSnapshot(data(x, "budget")) &&
      (!Object.hasOwn(x, "scriptTimeoutMs") ||
        timeout(data(x, "scriptTimeoutMs"))) &&
      (!Object.hasOwn(x, "watchdogMs") || timeout(data(x, "watchdogMs")))
    );
  if (t === "budget.updated")
    return exact(x, ["type", "budget"]) && isBudgetSnapshot(data(x, "budget"));
  if (t === "run.abort")
    return exact(x, ["type", "error"]) && isAwslErrorJson(data(x, "error"));
  if (
    t !== "response" ||
    !id(data(x, "id")) ||
    !isBudgetSnapshot(data(x, "budget"))
  )
    return false;
  return data(x, "ok") === true
    ? exact(x, ["type", "id", "ok", "value", "budget"])
    : data(x, "ok") === false &&
        exact(x, ["type", "id", "ok", "error", "budget"]) &&
        isAwslErrorJson(data(x, "error"));
}
