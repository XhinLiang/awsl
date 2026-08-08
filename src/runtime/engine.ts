import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isProxy } from "node:util/types";

import { negotiateAgent } from "../compat/agent-negotiation.js";
import type {
  AgentRegistry,
  RegistryAgentEntry,
  RegistryPluginProvenance,
  RegistryWorkflowEntry,
} from "../compat/agent-registry.js";
import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import { resolveModel } from "../config/model-map.js";
import { readRegularUtf8Text } from "../config/paths.js";
import {
  type ProviderPin,
  type ProviderPinV2,
  type RunSourceIdentityV1,
  parseProviderPin,
  parseProviderPinV2,
  resolvedDefaultForImplicitCall,
  transitionImplicitDefaultModel,
  transitionProviderPinSources,
  verifyAndHydrateResumePin,
} from "../config/provider-pin.js";
import type { ResolvedAwslConfig } from "../config/types.js";
import {
  type ResolvedWorkflowSource,
  resolveChildWorkflow,
  resolveRootWorkflow,
} from "../config/workflow-resolver.js";
import { AwslError, type AwslErrorCode } from "../core/errors.js";
import { type AwslEvent, createEvent } from "../core/events.js";
import { strictJsonClone } from "../core/strict-json.js";
import type {
  AgentEffort,
  AgentResult,
  JsonValue,
  ProviderAdapter,
  ProviderOutcome,
  ProviderUsage,
  RunStatus,
} from "../core/types.js";
import { prepareProviderJsonSchema } from "../providers/schema.js";
import { journalKeyV2 } from "../store/canonical-json.js";
import { redactJson } from "../store/redact.js";
import { ResumeCursor } from "../store/resume.js";
import type {
  JournalCallRecordV1,
  JournalRecordV1,
  LockOwner,
  RunLock,
  RunSnapshot,
  RunStore,
} from "../store/types.js";
import { WorkerHost } from "../worker/host.js";
import type { WorkerHandlerResult } from "../worker/host.js";
import type { BudgetSnapshot } from "../worker/protocol.js";
import { RunBudget } from "./budget.js";
import { Scheduler, runtimeConcurrency } from "./scheduler.js";
import {
  type GitWorktreeBase,
  type IsolatedWorktree,
  createIsolatedWorktree,
  parseGitWorktreeBase,
  resolveGitWorktreeBase,
} from "./worktree.js";

const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const efforts = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const awslErrorCodes = new Set<AwslErrorCode>([
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
const agentOptionKeys = new Set([
  "label",
  "phase",
  "schema",
  "model",
  "effort",
  "isolation",
  "agentType",
]);
const PROVIDER_ATTEMPT_LIMIT = 3;
const PROVIDER_RETRY_DELAYS_MS = [250, 1_000] as const;

interface CapturedAgentOptions {
  readonly label?: string;
  readonly phase?: string;
  readonly schema?: Record<string, unknown>;
  readonly model?: string;
  readonly effort?: AgentEffort;
  readonly isolation?: "worktree";
  readonly agentType?: string;
}

export interface RunMetrics {
  readonly agentCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly attemptOutputTokens: number;
  readonly usageComplete: boolean;
}

export interface ResumeWorkflowOptions {
  readonly storedPin: unknown;
  readonly storedWorktreeBase: unknown;
  readonly storedWorktrees: unknown;
}

export interface RunWorkflowOptions {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly root: ResolvedWorkflowSource;
  readonly args?: unknown;
  readonly canonicalCwd: string;
  readonly provider: ProviderAdapter;
  readonly config: ResolvedAwslConfig;
  readonly providerPin: ProviderPinV2;
  readonly registry: AgentRegistry;
  readonly store: RunStore;
  readonly lockOwner: LockOwner;
  readonly budget?: number | null;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly cancellationStatus?: () => "killed" | "paused";
  readonly resume?: ResumeWorkflowOptions;
  readonly runDir?: string;
  readonly eventSink?: (event: AwslEvent) => void | Promise<void>;
}

export interface RunWorkflowResult {
  readonly runId: string;
  readonly status: "completed";
  readonly result: JsonValue;
  readonly providerPin: ProviderPin;
  readonly budget: BudgetSnapshot;
  readonly metrics: RunMetrics;
  readonly events: readonly AwslEvent[];
  readonly worktreeBase: GitWorktreeBase | null;
}

interface RuntimeContext {
  readonly options: RunWorkflowOptions;
  readonly scheduler: Scheduler;
  readonly budget: RunBudget;
  readonly controller: AbortController;
  readonly hosts: Set<WorkerHost>;
  readonly activeOperations: Set<Promise<unknown>>;
  readonly events: AwslEvent[];
  readonly state: DurableRunState;
  resumeCursor?: ResumeCursor;
  agentCount: number;
  callSeq: number;
  previousKey: string;
  phase?: string;
  notificationTail: Promise<void>;
  usageIndeterminate: boolean;
  cumulativeBase: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    usageComplete: boolean;
  };
  worktreeBase?: GitWorktreeBase;
  worktreeBaseError?: AwslError;
}

function workflowError(message: string, cause?: unknown): AwslError {
  return new AwslError("WORKFLOW_ERROR", message, {
    recoverable: false,
    cause,
  });
}

function persistenceError(cause: unknown): AwslError {
  return cause instanceof AwslError && cause.code === "PERSISTENCE_ERROR"
    ? cause
    : new AwslError("PERSISTENCE_ERROR", "run snapshot persistence failed", {
        recoverable: false,
        cause,
      });
}

function providerError(
  provider: ProviderAdapter,
  message: string,
  cause?: unknown,
): AwslError {
  return new AwslError("PROVIDER_ERROR", message, {
    provider: provider.id,
    recoverable: false,
    cause,
  });
}

function cancelled(runId: string): AwslError {
  return new AwslError("CANCELLED", "workflow run cancelled", {
    runId,
    recoverable: false,
  });
}

function asJson<T>(value: unknown, label: string): T {
  try {
    return strictJsonClone(value, label) as T;
  } catch (error) {
    throw workflowError(`${label} must be strict JSON data`, error);
  }
}

function runSnapshot(value: unknown): RunSnapshot {
  return asJson<RunSnapshot>(value, "run snapshot");
}

function validateIdentity(options: RunWorkflowOptions): void {
  if (
    !token.test(options.runId) ||
    !token.test(options.attemptId) ||
    !Number.isSafeInteger(options.attemptSeq) ||
    options.attemptSeq < 0
  )
    throw workflowError("run attempt identity is invalid");
  if (
    typeof options.canonicalCwd !== "string" ||
    !isAbsolute(options.canonicalCwd) ||
    options.canonicalCwd.includes("\0")
  )
    throw workflowError("canonical cwd is invalid");
  if (
    options.provider.id !== options.config.provider ||
    options.provider.identity.id !== options.provider.id
  )
    throw new AwslError("CONFIG_ERROR", "runtime provider selection mismatch", {
      recoverable: false,
    });
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0)
  )
    throw new AwslError("CONFIG_ERROR", "runtime concurrency is invalid", {
      recoverable: false,
    });
  if (
    options.cancellationStatus !== undefined &&
    (typeof options.cancellationStatus !== "function" ||
      isProxy(options.cancellationStatus))
  )
    throw new AwslError(
      "CONFIG_ERROR",
      "runtime cancellation status resolver is invalid",
      { recoverable: false },
    );
}

function boundedText(
  value: unknown,
  field: string,
  maximumBytes = 4_096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw workflowError(`agent ${field} is invalid`);
  return value;
}

function captureAgentOptions(value: unknown): CapturedAgentOptions {
  const snapshot = asJson<unknown>(value, "agent options");
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    throw workflowError("agent options must be an object");
  const fields = snapshot as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !agentOptionKeys.has(key)))
    throw workflowError("agent options contain an unknown field");
  const result: {
    label?: string;
    phase?: string;
    schema?: Record<string, unknown>;
    model?: string;
    effort?: AgentEffort;
    isolation?: "worktree";
    agentType?: string;
  } = {};
  if (fields.label !== undefined)
    result.label = boundedText(fields.label, "label", 1_024);
  if (fields.phase !== undefined)
    result.phase = boundedText(fields.phase, "phase", 4_096);
  if (fields.model !== undefined)
    result.model = boundedText(fields.model, "model", 1_024);
  if (fields.agentType !== undefined)
    result.agentType = boundedText(fields.agentType, "agentType", 1_024);
  if (fields.effort !== undefined) {
    if (
      typeof fields.effort !== "string" ||
      !efforts.has(fields.effort as AgentEffort)
    )
      throw workflowError("agent effort is invalid");
    result.effort = fields.effort as AgentEffort;
  }
  if (fields.isolation !== undefined) {
    if (fields.isolation !== "worktree")
      throw workflowError("agent isolation is invalid");
    result.isolation = "worktree";
  }
  if (fields.schema !== undefined) {
    if (
      fields.schema === null ||
      typeof fields.schema !== "object" ||
      Array.isArray(fields.schema)
    )
      throw new AwslError("SCHEMA_ERROR", "agent schema must be an object", {
        recoverable: false,
      });
    result.schema = fields.schema as Record<string, unknown>;
  }
  return Object.freeze(result);
}

function captureUsage(
  value: ProviderUsage,
  provider: ProviderAdapter,
): ProviderUsage {
  let snapshot: unknown;
  try {
    snapshot = strictJsonClone(value, "provider usage");
  } catch (error) {
    throw providerError(provider, "provider usage is invalid", error);
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    throw providerError(provider, "provider usage is invalid");
  const usage = snapshot as Record<string, unknown>;
  if (
    Object.keys(usage).some(
      (key) =>
        ![
          "inputTokens",
          "cachedInputTokens",
          "outputTokens",
          "reasoningTokens",
          "complete",
        ].includes(key),
    ) ||
    typeof usage.complete !== "boolean"
  )
    throw providerError(provider, "provider usage is invalid");
  return usage as unknown as ProviderUsage;
}

function captureAgentResult(
  value: AgentResult,
  provider: ProviderAdapter,
): AgentResult {
  let snapshot: unknown;
  try {
    snapshot = strictJsonClone(value, "provider result");
  } catch (error) {
    throw providerError(provider, "provider result is invalid", error);
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    throw providerError(provider, "provider result is invalid");
  const result = snapshot as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) => !["text", "data", "model", "effort"].includes(key),
    ) ||
    typeof result.text !== "string" ||
    (result.model !== undefined && typeof result.model !== "string") ||
    (result.effort !== undefined &&
      (typeof result.effort !== "string" ||
        !efforts.has(result.effort as AgentEffort)))
  )
    throw providerError(provider, "provider result is invalid");
  return result as unknown as AgentResult;
}

function captureObservation(
  value: unknown,
  provider: ProviderAdapter,
): ProviderOutcome["observation"] {
  if (value === undefined) return undefined;
  let snapshot: unknown;
  try {
    snapshot = strictJsonClone(value, "provider observation");
  } catch (error) {
    throw providerError(provider, "provider observation is invalid", error);
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    throw providerError(provider, "provider observation is invalid");
  const observation = snapshot as Record<string, unknown>;
  if (
    Object.keys(observation).some(
      (key) =>
        ![
          "sessionId",
          "threadId",
          "resolvedModel",
          "structuredOutputAttempts",
        ].includes(key),
    )
  )
    throw providerError(provider, "provider observation is invalid");
  for (const field of ["sessionId", "threadId", "resolvedModel"] as const) {
    const text = observation[field];
    if (
      text !== undefined &&
      (typeof text !== "string" ||
        text.length === 0 ||
        text.includes("\0") ||
        Buffer.byteLength(text, "utf8") > 4_096)
    )
      throw providerError(provider, "provider observation is invalid");
  }
  if (
    observation.structuredOutputAttempts !== undefined &&
    (!Number.isSafeInteger(observation.structuredOutputAttempts) ||
      (observation.structuredOutputAttempts as number) < 0 ||
      (observation.structuredOutputAttempts as number) >
        COMPATIBILITY_PROFILE.structuredOutputAttempts)
  )
    throw providerError(provider, "provider observation is invalid");
  return observation as ProviderOutcome["observation"];
}

function captureProviderOutcome(
  value: unknown,
  provider: ProviderAdapter,
): ProviderOutcome {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value)
  )
    throw providerError(provider, "provider outcome is invalid");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw providerError(provider, "provider outcome is invalid", error);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    )
  )
    throw providerError(provider, "provider outcome is invalid");
  const data = (field: string): unknown => descriptors[field]?.value;
  const kind = data("kind");
  const expected =
    kind === "completed"
      ? ["kind", "result", "usage"]
      : kind === "compatibility-null"
        ? ["kind", "reason", "usage"]
        : kind === "error"
          ? ["kind", "error", "usage"]
          : undefined;
  const stringKeys = keys as string[];
  if (
    expected === undefined ||
    stringKeys.some(
      (key) => !expected.includes(key) && key !== "observation",
    ) ||
    expected.some((key) => !Object.hasOwn(descriptors, key))
  )
    throw providerError(provider, "provider outcome is invalid");
  const usage = captureUsage(data("usage") as ProviderUsage, provider);
  const observation = captureObservation(data("observation"), provider);
  if (kind === "completed")
    return {
      kind,
      result: captureAgentResult(data("result") as AgentResult, provider),
      usage,
      ...(observation === undefined ? {} : { observation }),
    };
  if (kind === "compatibility-null") {
    if (data("reason") !== "claude-terminal-api-error")
      throw providerError(provider, "provider outcome is invalid");
    return {
      kind,
      reason: "claude-terminal-api-error",
      usage,
      ...(observation === undefined ? {} : { observation }),
    };
  }
  const error = captureProviderError(data("error"), provider);
  return {
    kind: "error",
    error,
    usage,
    ...(observation === undefined ? {} : { observation }),
  };
}

function canRetryProviderOutcome(
  outcome: ProviderOutcome,
): outcome is Extract<ProviderOutcome, { kind: "error" }> {
  if (
    outcome.kind !== "error" ||
    outcome.error.code !== "PROVIDER_ERROR" ||
    outcome.error.recoverable !== true ||
    outcome.usage.complete !== true ||
    outcome.usage.outputTokens !== 0
  )
    return false;
  return [
    outcome.usage.inputTokens,
    outcome.usage.cachedInputTokens,
    outcome.usage.reasoningTokens,
  ].every((value) => value === undefined || value === 0);
}

function captureProviderError(
  value: unknown,
  provider: ProviderAdapter,
): AwslError {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== AwslError.prototype
  )
    throw providerError(provider, "provider outcome is invalid");

  const data = (field: string, required = false): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined ? required : !("value" in descriptor))
      throw providerError(provider, "provider outcome is invalid");
    return descriptor?.value;
  };
  const code = data("code", true);
  const message = data("message", true);
  const recoverable = data("recoverable", true);
  if (
    data("name", true) !== "AwslError" ||
    typeof code !== "string" ||
    !awslErrorCodes.has(code as AwslErrorCode) ||
    code === "CANCELLED" ||
    typeof message !== "string" ||
    message.includes("\0") ||
    Buffer.byteLength(message, "utf8") > 16_384 ||
    typeof recoverable !== "boolean"
  )
    throw providerError(provider, "provider outcome is invalid");

  const context: {
    runId?: string;
    callId?: string;
    phase?: string;
    provider?: string;
  } = {};
  for (const field of ["runId", "callId", "phase", "provider"] as const) {
    const text = data(field);
    if (
      text !== undefined &&
      (typeof text !== "string" ||
        text.includes("\0") ||
        Buffer.byteLength(text, "utf8") > 512)
    )
      throw providerError(provider, "provider outcome is invalid");
    if (text !== undefined) context[field] = text as string;
  }
  return new AwslError(code as AwslErrorCode, message, {
    recoverable,
    ...context,
  });
}

function preview(value: string): string {
  return Buffer.byteLength(value, "utf8") <= 256
    ? value
    : `${Buffer.from(value, "utf8").subarray(0, 253).toString("utf8")}...`;
}

function sourceForPlugin(
  plugin: RegistryPluginProvenance,
): RunSourceIdentityV1 {
  return {
    kind: "plugin-manifest",
    reference: plugin.reference,
    pluginRootRealpath: plugin.rootRealpath,
    realpath: plugin.manifestRealpath,
    sha256: plugin.manifestSha256,
  };
}

function sourcesForAgent(entry: RegistryAgentEntry): RunSourceIdentityV1[] {
  const result: RunSourceIdentityV1[] =
    entry.source.tier === "builtin"
      ? [
          {
            kind: "builtin-agent",
            reference: "workflow-subagent",
            realpath: null,
            sha256: entry.source.sha256,
          },
        ]
      : [
          {
            kind: "agent-registry",
            reference: entry.key,
            realpath: entry.source.realpath,
            sha256: entry.source.sha256,
          },
        ];
  if (entry.plugin) result.push(sourceForPlugin(entry.plugin));
  return result;
}

function sourcesForWorkflow(
  entry: ResolvedWorkflowSource | RegistryWorkflowEntry,
  registryReference: boolean,
): RunSourceIdentityV1[] {
  const result: RunSourceIdentityV1[] = [
    {
      kind: registryReference ? "workflow-registry" : "workflow-path",
      reference:
        registryReference && "key" in entry ? entry.key : entry.reference,
      realpath: entry.realpath,
    },
  ];
  if ("plugin" in entry && entry.plugin)
    result.push(sourceForPlugin(entry.plugin));
  return result;
}

class DurableRunState {
  #pin: ProviderPin;
  #snapshot: RunSnapshot;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    pin: ProviderPin,
    snapshot: RunSnapshot,
  ) {
    this.#pin = pin;
    this.#snapshot = snapshot;
  }

  get pin(): ProviderPin {
    return this.#pin;
  }

  get snapshot(): RunSnapshot {
    return this.#snapshot;
  }

  async initialize(): Promise<void> {
    try {
      await this.store.writeRun(this.#snapshot);
    } catch (error) {
      throw persistenceError(error);
    }
  }

  #enqueue<T>(
    update: (
      snapshot: RunSnapshot,
      pin: ProviderPin,
    ) =>
      | { readonly value: T; readonly changed: false }
      | {
          readonly value: T;
          readonly changed: true;
          readonly pin: ProviderPin;
          readonly snapshot: RunSnapshot;
        },
  ): Promise<T> {
    const operation = this.#tail.then(async () => {
      const next = update(this.#snapshot, this.#pin);
      if (!next.changed) return next.value;
      try {
        await this.store.writeRun(next.snapshot);
      } catch (error) {
        throw persistenceError(error);
      }
      this.#pin = next.pin;
      this.#snapshot = next.snapshot;
      return next.value;
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  addSources(additions: readonly RunSourceIdentityV1[]): Promise<void> {
    return this.#enqueue((snapshot, pin) => {
      const transition = transitionProviderPinSources(pin, additions);
      if (!transition.changed) return { value: undefined, changed: false };
      const next = runSnapshot({
        ...snapshot,
        providerPin: transition.pin,
      });
      return {
        value: undefined,
        changed: true,
        pin: transition.pin,
        snapshot: next,
      };
    });
  }

  observeDefault(
    modelSource: Parameters<
      typeof transitionImplicitDefaultModel
    >[1]["modelSource"],
    resolvedModel: string | undefined,
  ): Promise<void> {
    return this.#enqueue((snapshot, pin) => {
      const transition = transitionImplicitDefaultModel(pin, {
        modelSource,
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
      });
      if (!transition.changed) return { value: undefined, changed: false };
      const next = runSnapshot({
        ...snapshot,
        providerPin: transition.pin,
      });
      return {
        value: undefined,
        changed: true,
        pin: transition.pin,
        snapshot: next,
      };
    });
  }

  update(fields: Readonly<Record<string, JsonValue>>): Promise<void> {
    return this.#enqueue((snapshot, pin) => ({
      value: undefined,
      changed: true,
      pin,
      snapshot: runSnapshot({ ...snapshot, ...fields, providerPin: pin }),
    }));
  }

  addWorktree(value: Readonly<Record<string, JsonValue>>): Promise<void> {
    return this.#enqueue((snapshot, pin) => {
      const current = Array.isArray(snapshot.worktrees)
        ? snapshot.worktrees
        : [];
      return {
        value: undefined,
        changed: true,
        pin,
        snapshot: runSnapshot({
          ...snapshot,
          providerPin: pin,
          worktrees: [...current, value],
        }),
      };
    });
  }
}

function metrics(context: RuntimeContext): RunMetrics {
  const usage = context.budget.metrics();
  const inputTokens = context.cumulativeBase.inputTokens + usage.inputTokens;
  const cachedInputTokens =
    context.cumulativeBase.cachedInputTokens + usage.cachedInputTokens;
  const outputTokens = context.cumulativeBase.outputTokens + usage.outputTokens;
  const reasoningTokens =
    context.cumulativeBase.reasoningTokens + usage.reasoningTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(cachedInputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(reasoningTokens)
  )
    throw new AwslError(
      "PERSISTENCE_ERROR",
      "cumulative usage exceeds the safe integer range",
      { recoverable: false },
    );
  return Object.freeze({
    agentCount: context.agentCount,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    attemptOutputTokens: usage.outputTokens,
    usageComplete:
      context.cumulativeBase.usageComplete && !context.usageIndeterminate,
  });
}

function cumulativeUsage(
  records: readonly JournalRecordV1[],
  beforeAttemptSeq: number,
): RuntimeContext["cumulativeBase"] {
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    usageComplete: true,
  };
  const started = new Set<string>();
  const add = (usage: ProviderUsage | undefined, indeterminate: boolean) => {
    if (usage === undefined) {
      if (indeterminate) totals.usageComplete = false;
      return;
    }
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.reasoningTokens += usage.reasoningTokens ?? 0;
    if (usage.complete !== true || usage.outputTokens === undefined)
      totals.usageComplete = false;
  };
  for (const record of records) {
    if (record.kind !== "call" || record.attemptSeq >= beforeAttemptSeq)
      continue;
    const identity = `${record.attemptSeq}:${record.attemptId}:${record.callId}`;
    if (record.state === "started") {
      started.add(identity);
      continue;
    }
    if (record.state === "completed") {
      if (record.completed?.origin === "live")
        add(record.completed.usage, false);
      continue;
    }
    if (record.state === "failed") add(record.usage, started.has(identity));
    else if (record.state === "indeterminate") add(record.usage, true);
  }
  if (
    !Number.isSafeInteger(totals.inputTokens) ||
    !Number.isSafeInteger(totals.cachedInputTokens) ||
    !Number.isSafeInteger(totals.outputTokens) ||
    !Number.isSafeInteger(totals.reasoningTokens)
  )
    throw new AwslError(
      "PERSISTENCE_ERROR",
      "stored cumulative usage exceeds the safe integer range",
      { recoverable: false },
    );
  return totals;
}

async function emit(
  context: RuntimeContext,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const event = asJson<AwslEvent>(
    redactJson(
      createEvent(
        type,
        context.options.runId,
        asJson<JsonValue>(data, "event data"),
      ),
    ),
    "redacted event",
  );
  await context.options.store.appendEvent(event);
  context.events.push(event);
  await context.options.eventSink?.(event);
}

function cancelledStatus(options: RunWorkflowOptions): "killed" | "paused" {
  try {
    return options.cancellationStatus?.() === "paused" ? "paused" : "killed";
  } catch {
    return "killed";
  }
}

function queueNotification(
  context: RuntimeContext,
  operation: () => Promise<void>,
): void {
  context.notificationTail = context.notificationTail.then(operation);
}

function trackOperation<T>(
  context: RuntimeContext,
  operation: Promise<T>,
): Promise<T> {
  const tracked = operation.finally(() => {
    context.activeOperations.delete(tracked);
  });
  context.activeOperations.add(tracked);
  return tracked;
}

async function drainOperations(context: RuntimeContext): Promise<void> {
  while (context.activeOperations.size > 0)
    await Promise.allSettled([...context.activeOperations]);
}

function updateAllHostBudgets(context: RuntimeContext): void {
  const snapshot = context.budget.snapshot();
  for (const host of context.hosts) host.updateBudget(snapshot);
}

function callRecord(
  context: RuntimeContext,
  identity: {
    callSeq: number;
    callId: string;
    key: `v2:${string}`;
    previousKey: string;
  },
  state: JournalCallRecordV1["state"],
  extra: Pick<JournalCallRecordV1, "completed" | "usage"> = {},
): Omit<JournalCallRecordV1, "recordSeq" | "recordedAt"> {
  return {
    version: 1,
    kind: "call",
    runId: context.options.runId,
    attemptId: context.options.attemptId,
    attemptSeq: context.options.attemptSeq,
    ...identity,
    state,
    ...extra,
  };
}

async function appendFailure(
  context: RuntimeContext,
  identity: {
    callSeq: number;
    callId: string;
    key: `v2:${string}`;
    previousKey: string;
  },
  started: boolean,
  error: AwslError,
  usage?: ProviderUsage,
): Promise<void> {
  if (error.code === "PERSISTENCE_ERROR") return;
  const state =
    started && error.code === "CANCELLED" ? "indeterminate" : "failed";
  await context.options.store.appendCall(
    callRecord(context, identity, state, usage === undefined ? {} : { usage }),
  );
  await emit(context, "call.failed", {
    callId: identity.callId,
    callSeq: identity.callSeq,
    code: error.code,
    state,
  });
}

function normalizeError(error: unknown, context: RuntimeContext): AwslError {
  if (error instanceof AwslError) return error;
  if (context.controller.signal.aborted)
    return cancelled(context.options.runId);
  return workflowError(
    error instanceof Error ? error.message : "workflow execution failed",
    error,
  );
}

async function createAgentWorktree(
  context: RuntimeContext,
  callId: string,
): Promise<IsolatedWorktree> {
  if (!context.options.runDir)
    throw new AwslError(
      "WORKTREE_ERROR",
      "worktree isolation requires a durable run directory",
      { recoverable: false },
    );
  if (context.worktreeBaseError !== undefined) throw context.worktreeBaseError;
  if (context.worktreeBase === undefined)
    throw new AwslError(
      "WORKTREE_ERROR",
      "worktree isolation requires a Git repository",
      { recoverable: false },
    );
  const worktree = await createIsolatedWorktree({
    canonicalCwd: context.options.canonicalCwd,
    runDir: context.options.runDir,
    callId: `attempt-${context.options.attemptSeq}-${callId}`,
    base: context.worktreeBase,
    onRetained: async ({ path, reason }) =>
      emit(context, "worktree.retained", { callId, path, reason }),
  });
  try {
    await context.state.addWorktree({
      callId,
      path: worktree.path,
      cwd: worktree.cwd,
      repoRoot: worktree.repoRoot,
      baseCommit: worktree.baseCommit,
    });
    await emit(context, "worktree.created", {
      callId,
      path: worktree.path,
      baseCommit: worktree.baseCommit,
    });
    return worktree;
  } catch (error) {
    await worktree.cleanup(true).catch(() => undefined);
    throw error;
  }
}

async function executeAgent(
  context: RuntimeContext,
  promptValue: string,
  rawOptions: Record<string, unknown>,
  depth: number,
  childName?: string,
): Promise<WorkerHandlerResult> {
  await context.notificationTail;
  if (typeof promptValue !== "string")
    throw workflowError("agent prompt must be a string");
  const options = captureAgentOptions(rawOptions);
  const preparedSchema =
    options.schema === undefined
      ? undefined
      : prepareProviderJsonSchema(options.schema, {
          label: "agent schema",
          provider: context.options.provider.id,
        });
  const providerSchema =
    preparedSchema === undefined
      ? undefined
      : (JSON.parse(preparedSchema.packet) as Record<string, unknown>);

  context.agentCount += 1;
  if (context.agentCount > COMPATIBILITY_PROFILE.agentCap)
    throw workflowError(
      `run exceeds the ${COMPATIBILITY_PROFILE.agentCap} agent call limit`,
    );
  context.budget.gate();

  const callSeq = context.callSeq;
  context.callSeq += 1;
  const previousKey = context.previousKey;
  const key = journalKeyV2({
    previousKey,
    prompt: promptValue,
    schema: options.schema,
    requestedModel: options.model,
    requestedEffort: options.effort,
    isolation: options.isolation,
    agentType: options.agentType,
  });
  context.previousKey = key;
  const identity = {
    callSeq,
    callId: `call-${callSeq}`,
    key,
    previousKey,
  };
  const phase =
    depth === 1
      ? `child:${childName ?? "workflow"}`
      : (options.phase ?? context.phase);
  const reused = context.resumeCursor?.take(callSeq, key, previousKey);

  await context.options.store.appendCall(
    callRecord(context, identity, "scheduled"),
  );
  await emit(context, "call.scheduled", {
    callId: identity.callId,
    callSeq,
    prompt: preview(promptValue),
    ...(phase === undefined ? {} : { phase }),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (reused !== undefined) {
    await context.options.store.appendCall(
      callRecord(context, identity, "completed", {
        completed: {
          outcome: "result",
          origin: "reused",
          result: reused.result,
          value: reused.value as JsonValue,
          usage: reused.usage,
        },
      }),
    );
    await emit(context, "call.reused", {
      callId: identity.callId,
      callSeq,
      ...(phase === undefined ? {} : { phase }),
    });
    return { value: reused.value, budget: context.budget.snapshot() };
  }

  let started = false;
  let terminal = false;
  let isolated: IsolatedWorktree | undefined;
  let terminalUsage: ProviderUsage | undefined;
  try {
    const agentType = options.agentType ?? "workflow-subagent";
    const entry = await context.options.registry.resolveAgent(agentType);
    const selection = negotiateAgent(
      entry.agent,
      context.options.provider.id,
      context.options.provider.capabilities,
    );
    await context.state.addSources(sourcesForAgent(entry));
    const resolved = resolveModel({
      provider: context.options.provider.id,
      callOptionsModel: options.model,
      callOptionsEffort: options.effort,
      agentModel: selection.agentModel,
      agentEffort: selection.agentEffort,
      config: context.options.config.providers[context.options.config.provider],
    });
    const pinnedDefault = resolvedDefaultForImplicitCall(
      context.state.pin,
      resolved.modelSource,
    );

    const outcome = await context.scheduler.run(async () => {
      if (context.controller.signal.aborted)
        throw cancelled(context.options.runId);
      if (options.isolation === "worktree")
        isolated = await createAgentWorktree(context, identity.callId);
      if (context.controller.signal.aborted) {
        await isolated?.cleanup(false);
        throw cancelled(context.options.runId);
      }
      await context.options.store.appendCall(
        callRecord(context, identity, "started"),
      );
      started = true;
      await emit(context, "call.started", {
        callId: identity.callId,
        callSeq,
        prompt: preview(promptValue),
        ...(phase === undefined ? {} : { phase }),
        ...(resolved.model === undefined && pinnedDefault === undefined
          ? {}
          : { model: resolved.model ?? pinnedDefault }),
        ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
      });
      if (context.controller.signal.aborted)
        throw cancelled(context.options.runId);
      for (let attempt = 1; attempt <= PROVIDER_ATTEMPT_LIMIT; attempt += 1) {
        try {
          const outcome = captureProviderOutcome(
            await context.options.provider.run({
              prompt: promptValue,
              cwd: isolated?.cwd ?? context.options.canonicalCwd,
              ...(resolved.model === undefined && pinnedDefault === undefined
                ? {}
                : { model: resolved.model ?? pinnedDefault }),
              ...(resolved.effort === undefined
                ? {}
                : { effort: resolved.effort }),
              ...(providerSchema === undefined
                ? {}
                : { schema: providerSchema }),
              agent: selection.policy,
              signal: context.controller.signal,
              onRawEvent: context.options.store.rawEventSink(
                context.options.provider.id,
              ),
            }),
            context.options.provider,
          );
          if (
            attempt === PROVIDER_ATTEMPT_LIMIT ||
            !canRetryProviderOutcome(outcome)
          )
            return outcome;
          const delayMs = PROVIDER_RETRY_DELAYS_MS[attempt - 1];
          await emit(context, "call.retrying", {
            callId: identity.callId,
            callSeq,
            provider: context.options.provider.id,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: PROVIDER_ATTEMPT_LIMIT,
            delayMs,
            code: outcome.error.code,
          });
          await delay(delayMs, undefined, {
            signal: context.controller.signal,
          });
        } catch (error) {
          if (error instanceof AwslError) throw error;
          if (context.controller.signal.aborted)
            throw cancelled(context.options.runId);
          throw providerError(
            context.options.provider,
            "provider execution failed",
            error,
          );
        }
      }
      throw providerError(
        context.options.provider,
        "provider retry loop exhausted without an outcome",
      );
    }, context.controller.signal);

    terminalUsage = outcome.usage;
    context.budget.addUsage(terminalUsage);
    updateAllHostBudgets(context);
    if (context.controller.signal.aborted)
      throw cancelled(context.options.runId);
    await context.state.observeDefault(
      resolved.modelSource,
      outcome.observation?.resolvedModel,
    );
    if (
      terminalUsage.complete !== true ||
      terminalUsage.outputTokens === undefined
    ) {
      context.usageIndeterminate = true;
      await isolated?.cleanup(false);
      await context.options.store.appendCall(
        callRecord(context, identity, "indeterminate", {
          usage: terminalUsage,
        }),
      );
      terminal = true;
      const error =
        outcome.kind === "error"
          ? outcome.error
          : providerError(
              context.options.provider,
              "provider output-token usage is indeterminate",
            );
      await emit(context, "call.failed", {
        callId: identity.callId,
        callSeq,
        code: error.code,
        state: "indeterminate",
      });
      throw error;
    }

    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "compatibility-null") {
      await isolated?.cleanup(true);
      await context.options.store.appendCall(
        callRecord(context, identity, "completed", {
          completed: {
            outcome: "compatibility-null",
            origin: "live",
            result: null,
            value: null,
            usage: terminalUsage,
          },
        }),
      );
      terminal = true;
      await emit(context, "call.completed", {
        callId: identity.callId,
        callSeq,
        outcome: "compatibility-null",
      });
      return { value: null, budget: context.budget.snapshot() };
    }

    const result = outcome.result;
    let value: JsonValue;
    if (preparedSchema === undefined) {
      value = result.text;
    } else {
      if (
        !Object.prototype.hasOwnProperty.call(result, "data") ||
        !preparedSchema.matches(result.data)
      )
        throw new AwslError(
          "SCHEMA_ERROR",
          "provider structured result does not match the agent schema",
          {
            provider: context.options.provider.id,
            recoverable: false,
          },
        );
      value = asJson<JsonValue>(result.data, "structured agent result");
    }
    await isolated?.cleanup(true);
    await context.options.store.appendCall(
      callRecord(context, identity, "completed", {
        completed: {
          outcome: "result",
          origin: "live",
          result,
          value,
          usage: terminalUsage,
        },
      }),
    );
    terminal = true;
    await emit(context, "call.completed", {
      callId: identity.callId,
      callSeq,
      outcome: "result",
    });
    return { value, budget: context.budget.snapshot() };
  } catch (error) {
    let normalized =
      error instanceof AwslError ? error : normalizeError(error, context);
    try {
      await isolated?.cleanup(false);
    } catch (cleanupError) {
      normalized = persistenceError(cleanupError);
    }
    if (!terminal)
      await appendFailure(
        context,
        identity,
        started,
        normalized,
        terminalUsage,
      );
    throw normalized;
  }
}

async function resolveChild(
  context: RuntimeContext,
  reference: unknown,
): Promise<{
  readonly source: ResolvedWorkflowSource | RegistryWorkflowEntry;
  readonly registryReference: boolean;
}> {
  if (typeof reference === "string")
    return {
      source: await context.options.registry.resolveWorkflow(reference),
      registryReference: true,
    };
  return {
    source: await resolveChildWorkflow(
      reference as { scriptPath: string },
      context.options.canonicalCwd,
    ),
    registryReference: false,
  };
}

async function runWorker(
  context: RuntimeContext,
  source: ResolvedWorkflowSource | RegistryWorkflowEntry,
  args: unknown,
  depth: number,
): Promise<unknown> {
  const childName = depth === 1 ? source.meta.name : undefined;
  const host = new WorkerHost({
    budget: context.budget.snapshot(),
    agent: (prompt, options) =>
      trackOperation(
        context,
        executeAgent(context, prompt, options, depth, childName),
      ),
    workflow: (reference, childArgs) =>
      trackOperation(
        context,
        (async () => {
          if (depth >= 1)
            throw workflowError("child workflow nesting exceeds one level");
          const child = await resolveChild(context, reference);
          await context.state.addSources(
            sourcesForWorkflow(child.source, child.registryReference),
          );
          const value = await runWorker(
            context,
            child.source,
            childArgs,
            depth + 1,
          );
          return { value, budget: context.budget.snapshot() };
        })(),
      ),
    onPhase: (title) => {
      if (depth !== 0) return;
      context.phase = title;
      queueNotification(context, () =>
        emit(context, "phase.changed", { phase: title }),
      );
    },
    onLog: (message, level) => {
      queueNotification(context, () =>
        emit(context, "workflow.log", {
          message: preview(message),
          level,
          ...(childName === undefined ? {} : { phase: `child:${childName}` }),
        }),
      );
    },
  });
  context.hosts.add(host);
  try {
    return await host.run({
      ...source,
      args,
      runId: context.options.runId,
    });
  } finally {
    context.hosts.delete(host);
    await host.close();
  }
}

function initialSnapshot(
  options: RunWorkflowOptions,
  pin: ProviderPin,
  args: unknown,
  budget: BudgetSnapshot,
  worktreeBase: GitWorktreeBase | null,
  storedWorktrees: readonly JsonValue[],
): RunSnapshot {
  return runSnapshot({
    version: 1,
    runId: options.runId,
    status: "running",
    attempt: { id: options.attemptId, seq: options.attemptSeq },
    root: {
      reference: options.root.reference,
      realpath: options.root.realpath,
      sha256: options.root.sha256,
    },
    canonicalCwd: options.canonicalCwd,
    providerPin: pin,
    worktreeBase,
    argsPresent: options.args !== undefined,
    args: options.args === undefined ? null : args,
    budget,
    metrics: {
      agentCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      attemptOutputTokens: 0,
      usageComplete: true,
    },
    process: {
      pid: options.lockOwner.pid,
      processStartIdentity: options.lockOwner.processStartIdentity,
      nonce: options.lockOwner.nonce,
    },
    worktrees: storedWorktrees,
  });
}

async function revalidateStoredSource(
  source: RunSourceIdentityV1,
  options: RunWorkflowOptions,
  currentStatic: ProviderPin,
): Promise<RunSourceIdentityV1> {
  const alreadyCurrent = currentStatic.sources.find(
    (candidate) =>
      candidate.kind === source.kind &&
      candidate.reference === source.reference,
  );
  if (alreadyCurrent !== undefined) return alreadyCurrent;
  switch (source.kind) {
    case "config-path": {
      const current = await readRegularUtf8Text(
        source.reference,
        options.canonicalCwd,
      );
      return {
        kind: "config-path",
        reference: source.reference,
        realpath: current.realpath,
      };
    }
    case "workflow-path": {
      const current = await resolveRootWorkflow(
        source.reference,
        options.canonicalCwd,
      );
      return {
        kind: "workflow-path",
        reference: source.reference,
        realpath: current.realpath,
      };
    }
    case "workflow-registry": {
      const current = await options.registry.resolveWorkflow(source.reference);
      return {
        kind: "workflow-registry",
        reference: source.reference,
        realpath: current.realpath,
      };
    }
    case "agent-registry": {
      const current = await options.registry.resolveAgent(source.reference);
      if (current.source.tier === "builtin")
        throw new AwslError(
          "CONFIG_ERROR",
          "stored agent source identity changed",
          { recoverable: false },
        );
      return {
        kind: "agent-registry",
        reference: source.reference,
        realpath: current.source.realpath,
        sha256: current.source.sha256,
      };
    }
    case "builtin-agent": {
      const current = await options.registry.resolveAgent(source.reference);
      if (current.source.tier !== "builtin")
        throw new AwslError(
          "CONFIG_ERROR",
          "stored builtin agent source identity changed",
          { recoverable: false },
        );
      return {
        kind: "builtin-agent",
        reference: "workflow-subagent",
        realpath: null,
        sha256: current.source.sha256,
      };
    }
    case "plugin-manifest": {
      const current = options.registry.plugins.find(
        (plugin) => plugin.reference === source.reference,
      );
      if (current === undefined)
        throw new AwslError(
          "CONFIG_ERROR",
          "stored plugin source is no longer enabled",
          { recoverable: false },
        );
      return sourceForPlugin(current);
    }
  }
}

async function currentResumePin(
  options: RunWorkflowOptions,
  currentStatic: ProviderPin,
): Promise<ProviderPin> {
  if (options.resume === undefined) return currentStatic;
  const stored = parseProviderPin(options.resume.storedPin);
  const validated = await Promise.all(
    stored.sources.map((source) =>
      revalidateStoredSource(source, options, currentStatic),
    ),
  );
  return transitionProviderPinSources(currentStatic, validated).pin;
}

async function persistTerminalRun(
  context: RuntimeContext,
  status: RunStatus,
  result: JsonValue | undefined,
  error: AwslError | undefined,
): Promise<void> {
  const currentMetrics = metrics(context);
  await context.state.update({
    status,
    budget: context.budget.snapshot() as unknown as JsonValue,
    metrics: currentMetrics as unknown as JsonValue,
  });
  try {
    await context.options.store.writeResult(
      asJson(
        {
          version: 1,
          runId: context.options.runId,
          status,
          providerPin: context.state.pin,
          budget: context.budget.snapshot(),
          metrics: currentMetrics,
          worktreeBase: context.worktreeBase ?? null,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error: error.toJSON() }),
        },
        "run result snapshot",
      ),
    );
  } catch (writeError) {
    throw persistenceError(writeError);
  }
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
  validateIdentity(options);
  const currentStatic = parseProviderPinV2(options.providerPin);
  const currentForResume = await currentResumePin(options, currentStatic);
  const initialPin =
    options.resume === undefined
      ? currentStatic
      : verifyAndHydrateResumePin(options.resume.storedPin, currentForResume);
  const storedWorktreeBase =
    options.resume === undefined
      ? undefined
      : parseGitWorktreeBase(options.resume.storedWorktreeBase);
  const storedWorktrees =
    options.resume === undefined
      ? []
      : asJson<unknown>(options.resume.storedWorktrees, "stored worktrees");
  if (!Array.isArray(storedWorktrees))
    throw workflowError("stored worktrees must be an array");
  if (
    initialPin.canonicalCwd !== options.canonicalCwd ||
    initialPin.provider !== options.provider.id ||
    initialPin.executableRealpath !==
      options.provider.identity.executableRealpath ||
    initialPin.executableVersion !== options.provider.identity.version
  )
    throw new AwslError("CONFIG_ERROR", "runtime provider pin mismatch", {
      recoverable: false,
    });
  const args =
    options.args === undefined
      ? undefined
      : asJson<JsonValue>(options.args, "workflow args");
  const budget = new RunBudget(options.budget ?? null);
  const snapshot = initialSnapshot(
    options,
    initialPin,
    args,
    budget.snapshot(),
    storedWorktreeBase ?? null,
    storedWorktrees,
  );
  const state = new DurableRunState(options.store, initialPin, snapshot);
  const controller = new AbortController();
  const context: RuntimeContext = {
    options,
    scheduler: new Scheduler(options.concurrency ?? runtimeConcurrency()),
    budget,
    controller,
    hosts: new Set(),
    activeOperations: new Set(),
    events: [],
    state,
    agentCount: 0,
    callSeq: 0,
    previousKey: "",
    notificationTail: Promise.resolve(),
    usageIndeterminate: false,
    cumulativeBase: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      usageComplete: true,
    },
    ...(storedWorktreeBase === undefined || storedWorktreeBase === null
      ? {}
      : { worktreeBase: storedWorktreeBase }),
  };
  const abort = () => {
    const reason = cancelled(options.runId);
    if (!controller.signal.aborted) controller.abort(reason);
    for (const host of context.hosts) host.abort(reason);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  let lock: RunLock | undefined;
  let terminalEligible = false;
  let terminalCommitted = false;
  try {
    lock = await options.store.acquireRunLock(options.lockOwner);
    const source = await options.store.writeSourceSnapshot({
      runId: options.runId,
      attemptId: options.attemptId,
      attemptSeq: options.attemptSeq,
      sourcePath: options.root.realpath,
      source: options.root.source,
    });
    if (`sha256:${source.sha256}` !== options.root.sha256)
      throw new AwslError(
        "PERSISTENCE_ERROR",
        "root source snapshot hash mismatch",
        { recoverable: false },
      );
    await state.initialize();
    terminalEligible = true;
    await options.store.beginAttempt({
      version: 1,
      kind: "attempt",
      runId: options.runId,
      attemptId: options.attemptId,
      attemptSeq: options.attemptSeq,
      sourceSha256: source.sha256,
      sourcePath: options.root.realpath,
    });
    if (controller.signal.aborted) throw cancelled(options.runId);
    try {
      if (storedWorktreeBase === null)
        throw new AwslError(
          "WORKTREE_ERROR",
          "the original run did not have a pinned Git base",
          { recoverable: false },
        );
      const resolvedBase = await resolveGitWorktreeBase({
        canonicalCwd: options.canonicalCwd,
        ...(storedWorktreeBase === undefined
          ? {}
          : { baseCommit: storedWorktreeBase.baseCommit }),
      });
      if (
        storedWorktreeBase !== undefined &&
        (resolvedBase.repoRoot !== storedWorktreeBase.repoRoot ||
          resolvedBase.baseCommit !== storedWorktreeBase.baseCommit)
      )
        throw new AwslError(
          "WORKTREE_ERROR",
          "the stored Git base does not match the current repository",
          { recoverable: false },
        );
      context.worktreeBase = resolvedBase;
    } catch (error) {
      context.worktreeBaseError =
        error instanceof AwslError
          ? error
          : new AwslError("WORKTREE_ERROR", "could not pin the run Git base", {
              recoverable: false,
              cause: error,
            });
    }
    await state.update({
      worktreeBase: (context.worktreeBase ?? null) as unknown as JsonValue,
    });
    if (options.resume !== undefined) {
      const journal = await options.store.loadJournal();
      context.cumulativeBase = cumulativeUsage(journal, options.attemptSeq);
      context.resumeCursor = ResumeCursor.fromJournal(journal);
      await state.update({
        metrics: metrics(context) as unknown as JsonValue,
      });
    }
    await emit(context, "run.started", {
      attemptId: options.attemptId,
      attemptSeq: options.attemptSeq,
      resumed: options.resume !== undefined,
    });
    if (controller.signal.aborted) throw cancelled(options.runId);
    const result = asJson<JsonValue>(
      await runWorker(context, options.root, args, 0),
      "workflow result",
    );
    if (controller.signal.aborted) throw cancelled(options.runId);
    await context.notificationTail;
    if (controller.signal.aborted) throw cancelled(options.runId);
    await drainOperations(context);
    if (controller.signal.aborted) throw cancelled(options.runId);
    await persistTerminalRun(context, "completed", result, undefined);
    terminalCommitted = true;
    await emit(context, "run.completed", {
      status: "completed",
      metrics: metrics(context),
      result,
    });
    return Object.freeze({
      runId: options.runId,
      status: "completed",
      result,
      providerPin: context.state.pin,
      budget: context.budget.snapshot(),
      metrics: metrics(context),
      events: Object.freeze([...context.events]),
      worktreeBase: context.worktreeBase ?? null,
    });
  } catch (error) {
    if (!terminalEligible || terminalCommitted) throw error;
    const normalized = normalizeError(error, context);
    abort();
    await drainOperations(context);
    await context.notificationTail.catch(() => undefined);
    const status: RunStatus =
      normalized.code === "CANCELLED" ? cancelledStatus(options) : "failed";
    try {
      await persistTerminalRun(context, status, undefined, normalized);
      terminalCommitted = true;
    } catch (terminalError) {
      const durableError = persistenceError(terminalError);
      await emit(context, "run.failed", {
        status,
        code: durableError.code,
        originalCode: normalized.code,
      }).catch(() => undefined);
      throw durableError;
    }
    await emit(
      context,
      normalized.code === "CANCELLED" ? `run.${status}` : "run.failed",
      {
        status,
        code: normalized.code,
      },
    ).catch(() => undefined);
    throw normalized;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    for (const host of context.hosts) host.abort(cancelled(options.runId));
    await drainOperations(context);
    await Promise.all([...context.hosts].map((host) => host.close()));
    await lock?.release();
  }
}

export function resumeWorkflow(
  options: RunWorkflowOptions & { readonly resume: ResumeWorkflowOptions },
): Promise<RunWorkflowResult> {
  return runWorkflow(options);
}
