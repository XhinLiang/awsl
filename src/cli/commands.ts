import { execFile as nodeExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { Command, CommanderError } from "commander";

import {
  type AgentRegistry,
  createRegistry,
} from "../compat/agent-registry.js";
import { loadConfig } from "../config/load.js";
import { canonicalCwd, resolveProjectRoot } from "../config/paths.js";
import {
  providerVersionSupport,
  resolveProviderIdentity,
} from "../config/provider-identity.js";
import {
  type ProviderPinV2,
  type RunSourceIdentityV1,
  createProviderPin,
} from "../config/provider-pin.js";
import type { LoadedConfig, ResolvedAwslConfig } from "../config/types.js";
import {
  type ResolvedWorkflowSource,
  resolveRootWorkflow,
} from "../config/workflow-resolver.js";
import { canonicalJson } from "../core/canonical-json.js";
import { AwslError, type AwslErrorCode } from "../core/errors.js";
import { createEvent } from "../core/events.js";
import { strictJsonClone } from "../core/strict-json.js";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderIdentity,
} from "../core/types.js";
import { ClaudeAdapter } from "../providers/claude.js";
import { CodexAdapter } from "../providers/codex.js";
import {
  type RunProviderProcessOptions,
  runProviderProcess,
} from "../providers/process.js";
import { runWorkflow } from "../runtime/engine.js";
import { redactJson } from "../store/redact.js";
import { FileRunStore } from "../store/run-store.js";
import type { LockOwner } from "../store/types.js";
import {
  type OutputFormat,
  type ResolvedArgsInput,
  parseBudget,
  parseOutputFormat,
  parseResume,
  resolveArgsInput,
} from "./args.js";
import { createOutputController } from "./output.js";
import {
  completedStopIntent,
  currentProcessStartIdentity,
  inspectProcess,
  installRunSignalHandlers,
  sendVerifiedSignal,
} from "./signals.js";
import {
  type ProjectState,
  type ReconciledRun,
  type StoredRunSnapshot,
  assertRunId,
  ensureProjectState,
  listRunIds,
  openProjectState,
  parseStoredRunResultSnapshot,
  parseStoredRunSnapshot,
  reconcileRun,
} from "./state.js";

const execFile = promisify(nodeExecFile);
const packageManifest = createRequire(import.meta.url)(
  "../../package.json",
) as unknown;
if (
  packageManifest === null ||
  typeof packageManifest !== "object" ||
  typeof (packageManifest as { version?: unknown }).version !== "string"
)
  throw new Error("invalid awsl package version");
const packageVersion = (packageManifest as { version: string }).version;
const knownCommands = new Set([
  "run",
  "resume",
  "runs",
  "doctor",
  "config",
  "workflow",
  "help",
]);
const nestedCommands: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    runs: new Set(["list", "show", "pause"]),
    config: new Set(["show"]),
    workflow: new Set(["inspect"]),
  });
const diagnosticText: Record<AwslErrorCode, string> = {
  USAGE_ERROR: "invalid command line",
  CONFIG_ERROR: "configuration validation failed",
  COMPATIBILITY_ERROR: "workflow or provider is incompatible",
  WORKFLOW_ERROR: "workflow execution failed",
  PROVIDER_ERROR: "provider execution failed",
  SCHEMA_ERROR: "structured result validation failed",
  BUDGET_EXCEEDED: "workflow budget was exhausted",
  CANCELLED: "workflow execution was cancelled",
  PERSISTENCE_ERROR: "durable run state operation failed",
  WORKTREE_ERROR: "worktree operation failed",
};

export interface CliStdin {
  readonly isTTY: boolean;
  read(): Promise<string>;
}

export interface CliContext {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly stdoutIsTTY?: boolean;
  readonly stdin: CliStdin;
  writeStdout(value: string): void | Promise<void>;
  writeStderr(value: string): void | Promise<void>;
}

interface NormalizedContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly stdoutIsTTY: boolean;
  readonly stdin: CliStdin;
  writeStdout(value: string): Promise<void>;
  writeStderr(value: string): Promise<void>;
}

interface RunCommandOptions {
  readonly provider?: string;
  readonly args?: string;
  readonly argsFile?: string;
  readonly cwd?: string;
  readonly budget?: string;
  readonly format?: string;
}

interface ResumeCommandOptions {
  readonly args?: string;
  readonly argsFile?: string;
  readonly budget?: string;
  readonly format?: string;
}

interface FormatCommandOptions {
  readonly format?: string;
}

interface PreparedRuntime {
  readonly loaded: LoadedConfig;
  readonly canonicalCwd: string;
  readonly projectRoot: string;
  readonly root: ResolvedWorkflowSource;
  readonly registry: AgentRegistry;
  readonly identity: ProviderIdentity;
  readonly provider: ProviderAdapter;
  readonly providerPin: ProviderPinV2;
}

function normalizeContext(context: CliContext): NormalizedContext {
  return {
    cwd: context.cwd ?? process.cwd(),
    env: context.env ?? process.env,
    homeDir: context.homeDir ?? homedir(),
    stdoutIsTTY: context.stdoutIsTTY === true,
    stdin: context.stdin,
    writeStdout: async (value) => {
      await context.writeStdout(value);
    },
    writeStderr: async (value) => {
      await context.writeStderr(value);
    },
  };
}

function usage(message = "invalid command line"): never {
  throw new AwslError("USAGE_ERROR", message, { recoverable: false });
}

function provider(value: string | undefined): ProviderId | undefined {
  if (value === undefined) return undefined;
  if (value !== "codex" && value !== "claude")
    throw new AwslError("CONFIG_ERROR", "provider is invalid", {
      recoverable: false,
    });
  return value;
}

function safeJson(value: unknown, label: string): unknown {
  try {
    return strictJsonClone(
      redactJson(strictJsonClone(value, label)),
      `redacted ${label}`,
    );
  } catch {
    throw new AwslError("PERSISTENCE_ERROR", "could not render output safely", {
      recoverable: false,
    });
  }
}

async function writeValue(
  context: NormalizedContext,
  value: unknown,
  requested: string | undefined,
): Promise<void> {
  const format = parseOutputFormat(requested ?? "auto");
  const resolved =
    format === "auto" ? (context.stdoutIsTTY ? "pretty" : "jsonl") : format;
  const result = safeJson(value, "command result");
  if (resolved === "pretty") {
    await context.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (resolved === "jsonl") {
    await context.writeStdout(
      `${canonicalJson(createEvent("command.completed", "cli", result))}\n`,
    );
    return;
  }
  await context.writeStdout(`${canonicalJson(result)}\n`);
}

function errorExitCode(error: AwslError): 1 | 2 {
  return error.code === "USAGE_ERROR" ||
    error.code === "CONFIG_ERROR" ||
    error.code === "COMPATIBILITY_ERROR"
    ? 2
    : 1;
}

async function writeDiagnostic(
  context: NormalizedContext,
  error: unknown,
): Promise<1 | 2> {
  const normalized =
    error instanceof AwslError
      ? error
      : new AwslError("PERSISTENCE_ERROR", "command failed", {
          recoverable: false,
        });
  await context.writeStderr(
    `${normalized.code}: ${diagnosticText[normalized.code]}\n`,
  );
  return errorExitCode(normalized);
}

function rewriteLeadingWorkflow(argv: readonly string[]): string[] {
  if (argv.length === 0) return [];
  const first = argv[0] as string;
  if (first.startsWith("-") || knownCommands.has(first)) return [...argv];
  return ["run", ...argv];
}

function rewriteHelpPath(argv: readonly string[]): string[] {
  if (argv[0] !== "help" || argv.length === 1) return [...argv];
  const command = argv[1] as string;
  if (!knownCommands.has(command) || command === "help") usage();
  const children = nestedCommands[command];
  if (children === undefined) {
    if (argv.length !== 2) usage();
    return [command, "--help"];
  }
  if (argv.length === 2) return [command, "--help"];
  const child = argv[2] as string;
  if (argv.length !== 3 || !children.has(child)) usage();
  return [command, child, "--help"];
}

function rejectUnknownNestedCommand(argv: readonly string[]): void {
  const children = nestedCommands[argv[0] as string];
  const child = argv[1];
  if (
    children !== undefined &&
    child !== undefined &&
    !child.startsWith("-") &&
    child !== "help" &&
    !children.has(child)
  )
    usage();
}

function rejectDuplicateLongOptions(argv: readonly string[]): void {
  const seen = new Set<string>();
  for (const token of argv) {
    if (!token.startsWith("--") || token === "--") continue;
    const name = token.slice(
      0,
      token.indexOf("=") === -1 ? undefined : token.indexOf("="),
    );
    if (seen.has(name)) usage();
    seen.add(name);
  }
}

function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

async function lockOwner(): Promise<LockOwner> {
  return Object.freeze({
    nonce: randomToken("lock"),
    pid: process.pid,
    processStartIdentity: await currentProcessStartIdentity(),
  });
}

function adapter(
  config: ResolvedAwslConfig,
  identity: ProviderIdentity,
  env: NodeJS.ProcessEnv,
): ProviderAdapter {
  const selected = config.providers[config.provider];
  const processRunner = (options: RunProviderProcessOptions) =>
    runProviderProcess({ ...options, env });
  return config.provider === "codex"
    ? new CodexAdapter({
        identity,
        configuredArgs: selected.args,
        ...(config.providers.codex.profile === undefined
          ? {}
          : { profile: config.providers.codex.profile }),
        processRunner,
      })
    : new ClaudeAdapter({
        identity,
        configuredArgs: selected.args,
        processRunner,
      });
}

function initialSources(
  loaded: LoadedConfig,
  root: ResolvedWorkflowSource,
): readonly RunSourceIdentityV1[] {
  return Object.freeze([
    ...loaded.configSources.map(
      (source): RunSourceIdentityV1 => ({
        kind: "config-path",
        reference: source.requestedPath,
        realpath: source.realpath,
      }),
    ),
    {
      kind: "workflow-path",
      reference: root.reference,
      realpath: root.realpath,
    },
  ]);
}

async function prepareRuntime(options: {
  readonly context: NormalizedContext;
  readonly cwd: string;
  readonly workflow: string;
  readonly providerOverride?: ProviderId;
}): Promise<PreparedRuntime> {
  const canonical = await canonicalCwd(options.cwd);
  const loaded = await loadConfig({
    cwd: canonical,
    env: options.context.env,
    ...(options.providerOverride === undefined
      ? {}
      : { cli: { provider: options.providerOverride } }),
  });
  const root = await resolveRootWorkflow(options.workflow, canonical);
  const projectRoot = await resolveProjectRoot(canonical);
  const registry = await createRegistry({
    cwd: canonical,
    provider: loaded.value.provider,
    pluginDirs: loaded.value.registry.pluginDirs,
    homeDir: options.context.homeDir,
    claudeConfigDir:
      options.context.env.CLAUDE_CONFIG_DIR ||
      `${options.context.homeDir}/.claude`,
    codexConfigDir:
      options.context.env.CODEX_HOME || `${options.context.homeDir}/.codex`,
  });
  const selected = loaded.value.providers[loaded.value.provider];
  const identity = await resolveProviderIdentity({
    provider: loaded.value.provider,
    executable: selected.executable,
    cwd: canonical,
    env: options.context.env,
  });
  const providerAdapter = adapter(loaded.value, identity, options.context.env);
  const providerPin = await createProviderPin({
    identity,
    config: loaded.value,
    canonicalCwd: canonical,
    sources: initialSources(loaded, root),
    enabledPluginRoots: registry.plugins.map((plugin) => plugin.rootRealpath),
    homeDir: options.context.homeDir,
    env: options.context.env,
  });
  return Object.freeze({
    loaded,
    canonicalCwd: canonical,
    projectRoot,
    root,
    registry,
    identity,
    provider: providerAdapter,
    providerPin,
  });
}

async function createRunStore(
  state: ProjectState,
  rawCapture: boolean,
): Promise<{ readonly runId: string; readonly store: FileRunStore }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const runId = randomToken(`wf-${Date.now().toString(36)}`);
    try {
      return {
        runId,
        store: await FileRunStore.create({
          root: state.runsRoot,
          runId,
          rawCapture,
        }),
      };
    } catch (error) {
      if (
        !(error instanceof AwslError) ||
        error.code !== "PERSISTENCE_ERROR" ||
        error.message !== "run state already exists"
      )
        throw error;
    }
  }
  throw new AwslError("PERSISTENCE_ERROR", "could not allocate run state", {
    recoverable: false,
  });
}

async function executeWorkflowRun(options: {
  readonly context: NormalizedContext;
  readonly runtime: PreparedRuntime;
  readonly store: FileRunStore;
  readonly runId: string;
  readonly attemptSeq: number;
  readonly args: ResolvedArgsInput;
  readonly budget?: number | null;
  readonly format: OutputFormat;
  readonly resume?: {
    readonly stored: StoredRunSnapshot;
  };
}): Promise<number> {
  const output = createOutputController({
    format: options.format,
    stdoutIsTTY: options.context.stdoutIsTTY,
    writeStdout: options.context.writeStdout,
    writeStderr: options.context.writeStderr,
  });
  const controller = new AbortController();
  const signals = installRunSignalHandlers({ controller });
  const owner = await lockOwner();
  try {
    const result = await runWorkflow({
      runId: options.runId,
      attemptId: randomToken(`attempt-${options.attemptSeq}`),
      attemptSeq: options.attemptSeq,
      root: options.runtime.root,
      ...(options.args.present ? { args: options.args.value } : {}),
      canonicalCwd: options.runtime.canonicalCwd,
      provider: options.runtime.provider,
      config: options.runtime.loaded.value,
      providerPin: options.runtime.providerPin,
      registry: options.runtime.registry,
      store: options.store,
      lockOwner: owner,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      signal: controller.signal,
      cancellationStatus: () => signals.intent()?.status ?? "killed",
      runDir: options.store.paths.runDir,
      eventSink: output.event,
      ...(options.resume === undefined
        ? {}
        : {
            resume: {
              storedPin: options.resume.stored.providerPin,
              storedWorktreeBase: options.resume.stored.worktreeBase,
              storedWorktrees: options.resume.stored.worktrees,
            },
          }),
    });
    await output.complete({
      runId: result.runId,
      status: result.status,
      result: result.result,
      budget: result.budget,
      metrics: result.metrics,
    });
    return 0;
  } catch (error) {
    const intent = completedStopIntent(error, signals.intent());
    const terminal =
      error instanceof AwslError && error.code !== "PERSISTENCE_ERROR"
        ? await durableTerminalEnvelope(options.store, options.runId, owner)
        : undefined;
    if (intent !== undefined) {
      if (terminal?.status !== intent.status)
        throw new AwslError(
          "PERSISTENCE_ERROR",
          "cooperative stop did not reach a durable terminal state",
          { recoverable: false },
        );
      await output.complete(terminal);
      return intent.exitCode;
    }
    if (terminal !== undefined) await output.complete(terminal);
    throw error;
  } finally {
    signals.dispose();
  }
}

async function durableTerminalEnvelope(
  store: FileRunStore,
  runId: string,
  owner: LockOwner,
): Promise<
  | {
      readonly runId: string;
      readonly status: "paused" | "completed" | "failed" | "killed";
      readonly result?: unknown;
      readonly budget: unknown;
      readonly metrics: unknown;
      readonly error?: { readonly code: AwslErrorCode };
    }
  | undefined
> {
  let snapshot: StoredRunSnapshot;
  try {
    snapshot = parseStoredRunSnapshot(await store.readRun());
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const rawResult = await store.readResult();
  if (
    snapshot.runId !== runId ||
    snapshot.status === "running" ||
    snapshot.process.pid !== owner.pid ||
    snapshot.process.processStartIdentity !== owner.processStartIdentity ||
    snapshot.process.nonce !== owner.nonce ||
    rawResult === undefined
  )
    return undefined;
  try {
    await store.readLockOwner();
  } catch (error) {
    if (!missing(error)) throw error;
    const result = parseStoredRunResultSnapshot(rawResult, snapshot);
    return Object.freeze({
      runId,
      status: result.status,
      ...(result.result === undefined ? {} : { result: result.result }),
      budget: result.budget,
      metrics: result.metrics,
      ...(result.error === undefined
        ? {}
        : { error: { code: result.error.code } }),
    });
  }
  return undefined;
}

async function runCommand(
  workflow: string,
  rawOptions: RunCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const cwd = rawOptions.cwd ?? context.cwd;
  const canonical = await canonicalCwd(cwd);
  const args = await resolveArgsInput({
    cwd: canonical,
    argsText: rawOptions.args,
    argsFile: rawOptions.argsFile,
    stdin: context.stdin,
  });
  const budget =
    rawOptions.budget === undefined
      ? undefined
      : parseBudget(rawOptions.budget);
  const format = parseOutputFormat(rawOptions.format ?? "auto");
  const runtime = await prepareRuntime({
    context,
    cwd: canonical,
    workflow,
    providerOverride: provider(rawOptions.provider),
  });
  const state = await ensureProjectState(runtime.loaded.value.stateDir, {
    projectRoot: runtime.projectRoot,
  });
  const created = await createRunStore(
    state,
    runtime.loaded.value.rawProviderEvents,
  );
  return executeWorkflowRun({
    context,
    runtime,
    store: created.store,
    runId: created.runId,
    attemptSeq: 0,
    args,
    ...(budget === undefined ? {} : { budget }),
    format,
  });
}

async function locateRun(
  runId: string,
  context: NormalizedContext,
): Promise<{
  readonly loaded: LoadedConfig;
  readonly projectRoot: string;
  readonly state: ProjectState;
  readonly store: FileRunStore;
  readonly reconciliation: ReconciledRun;
}> {
  assertRunId(runId);
  const cwd = await canonicalCwd(context.cwd);
  const loaded = await loadConfig({ cwd, env: context.env });
  const projectRoot = await resolveProjectRoot(cwd);
  const state = await openProjectState(loaded.value.stateDir, { projectRoot });
  if (state === undefined)
    throw new AwslError("PERSISTENCE_ERROR", "run state was not found", {
      recoverable: false,
    });
  const inspectionStore = await FileRunStore.openExisting({
    root: state.runsRoot,
    runId,
  });
  const reconciliation = await reconcileRun(inspectionStore, {
    inspectProcess,
    repairOwner: await lockOwner(),
  });
  return {
    loaded,
    projectRoot,
    state,
    store: await FileRunStore.openExisting({
      root: state.runsRoot,
      runId,
    }),
    reconciliation,
  };
}

function nextAttemptSeq(
  records: readonly {
    readonly kind: "attempt" | "call";
    readonly attemptSeq: number;
  }[],
): number {
  const attempts = records.filter((record) => record.kind === "attempt");
  if (attempts.length === 0)
    throw new AwslError("PERSISTENCE_ERROR", "run journal has no attempt", {
      recoverable: false,
    });
  return Math.max(...attempts.map((record) => record.attemptSeq)) + 1;
}

async function resumeCommand(
  runId: string,
  rawOptions: ResumeCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const located = await locateRun(runId, context);
  if (located.reconciliation.active)
    throw new AwslError("PERSISTENCE_ERROR", "run is already active", {
      recoverable: false,
    });
  const stored = located.reconciliation.snapshot;
  const storedProject = await resolveProjectRoot(stored.canonicalCwd);
  if (storedProject !== located.projectRoot)
    throw new AwslError("CONFIG_ERROR", "stored run project does not match", {
      recoverable: false,
    });
  if (located.reconciliation.atLeastOnce)
    await context.writeStderr(
      "PERSISTENCE_WARNING: prior started calls may execute at least once\n",
    );
  const replacement = await resolveArgsInput({
    cwd: stored.canonicalCwd,
    argsText: rawOptions.args,
    argsFile: rawOptions.argsFile,
    stdin: context.stdin,
  });
  const args: ResolvedArgsInput = replacement.present
    ? replacement
    : stored.argsPresent
      ? { present: true, value: stored.args }
      : { present: false };
  const budget =
    rawOptions.budget === undefined
      ? stored.budget.total
      : parseBudget(rawOptions.budget);
  const runtime = await prepareRuntime({
    context,
    cwd: stored.canonicalCwd,
    workflow: stored.root.reference,
  });
  const records = await located.store.loadJournal();
  const store = await FileRunStore.openExisting({
    root: located.state.runsRoot,
    runId,
    rawCapture: runtime.loaded.value.rawProviderEvents,
  });
  return executeWorkflowRun({
    context,
    runtime,
    store,
    runId,
    attemptSeq: nextAttemptSeq(records),
    args,
    budget,
    format: parseOutputFormat(rawOptions.format ?? "auto"),
    resume: { stored },
  });
}

async function runsListCommand(
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const cwd = await canonicalCwd(context.cwd);
  const loaded = await loadConfig({ cwd, env: context.env });
  const projectRoot = await resolveProjectRoot(cwd);
  const state = await openProjectState(loaded.value.stateDir, { projectRoot });
  if (state === undefined) {
    await writeValue(context, { runs: [] }, rawOptions.format);
    return 0;
  }
  const processIdentity = await currentProcessStartIdentity();
  const runs = [];
  for (const runId of await listRunIds(state.runsRoot)) {
    const store = await FileRunStore.openExisting({
      root: state.runsRoot,
      runId,
    });
    const reconciled = await reconcileRun(store, {
      inspectProcess,
      repairOwner: {
        nonce: randomToken("repair"),
        pid: process.pid,
        processStartIdentity: processIdentity,
      },
    });
    runs.push({
      runId,
      status: reconciled.snapshot.status,
      attemptSeq: reconciled.snapshot.attempt.seq,
      active: reconciled.active,
      ...(reconciled.snapshot.statusReason === undefined
        ? {}
        : { statusReason: reconciled.snapshot.statusReason }),
      atLeastOnce: reconciled.atLeastOnce,
    });
  }
  await writeValue(
    context,
    { projectId: state.projectId, runs },
    rawOptions.format,
  );
  return 0;
}

async function runsShowCommand(
  runId: string,
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const located = await locateRun(runId, context);
  const rawResult = await located.store.readResult();
  const result =
    rawResult === undefined ||
    located.reconciliation.snapshot.status === "running"
      ? undefined
      : parseStoredRunResultSnapshot(
          rawResult,
          located.reconciliation.snapshot,
        );
  await writeValue(
    context,
    {
      run: located.reconciliation.snapshot,
      result: result ?? null,
      active: located.reconciliation.active,
      atLeastOnce: located.reconciliation.atLeastOnce,
    },
    rawOptions.format,
  );
  return 0;
}

function missing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    (Object.hasOwn(error, "cause") &&
      missing((error as { cause?: unknown }).cause))
  );
}

async function runsPauseCommand(
  runId: string,
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const located = await locateRun(runId, context);
  if (!located.reconciliation.active)
    throw new AwslError("PERSISTENCE_ERROR", "run is not active", {
      recoverable: false,
    });
  const owner = await located.store.readLockOwner();
  await sendVerifiedSignal(owner, "SIGUSR2");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const store = await FileRunStore.openExisting({
      root: located.state.runsRoot,
      runId,
    });
    const snapshot = parseStoredRunSnapshot(await store.readRun());
    let lockExists = true;
    try {
      await store.readLockOwner();
    } catch (error) {
      if (!missing(error)) throw error;
      lockExists = false;
    }
    if (snapshot.status === "paused" && !lockExists) {
      await writeValue(context, { runId, status: "paused" }, rawOptions.format);
      return 0;
    }
    if (snapshot.status !== "running" && snapshot.status !== "paused")
      throw new AwslError(
        "PERSISTENCE_ERROR",
        "run stopped without becoming paused",
        { recoverable: false },
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new AwslError("PERSISTENCE_ERROR", "pause was not confirmed", {
    recoverable: false,
  });
}

async function workflowInspectCommand(
  file: string,
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const cwd = await canonicalCwd(context.cwd);
  const root = await resolveRootWorkflow(file, cwd);
  await writeValue(
    context,
    {
      reference: root.reference,
      realpath: root.realpath,
      sha256: root.sha256,
      workflowAbi: root.workflowAbi,
      meta: root.meta,
    },
    rawOptions.format,
  );
  return 0;
}

async function configShowCommand(
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const cwd = await canonicalCwd(context.cwd);
  const loaded = await loadConfig({ cwd, env: context.env });
  await writeValue(
    context,
    {
      value: loaded.value,
      provenance: loaded.provenance,
      configSources: loaded.configSources,
    },
    rawOptions.format,
  );
  return 0;
}

async function doctorCommand(
  rawOptions: FormatCommandOptions,
  context: NormalizedContext,
): Promise<number> {
  const cwd = await canonicalCwd(context.cwd);
  const loaded = await loadConfig({ cwd, env: context.env });
  const providerCheck = async (id: ProviderId) => {
    try {
      const identity = await resolveProviderIdentity({
        provider: id,
        executable: loaded.value.providers[id].executable,
        cwd,
        env: context.env,
      });
      return {
        available: true,
        version: identity.version,
        support: providerVersionSupport(id, identity.version),
      };
    } catch (error) {
      return {
        available: false,
        code: error instanceof AwslError ? error.code : "PERSISTENCE_ERROR",
      };
    }
  };
  const gitCheck = async () => {
    try {
      const result = await execFile("git", ["--version"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 4_096,
      });
      return {
        available: true,
        version: result.stdout.trim().slice(0, 256),
      };
    } catch {
      return { available: false };
    }
  };
  const [git, codex, claude] = await Promise.all([
    gitCheck(),
    providerCheck("codex"),
    providerCheck("claude"),
  ]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const node = {
    available: Number.isSafeInteger(nodeMajor) && nodeMajor >= 22,
    version: process.versions.node,
  };
  const checks = { node, git, codex, claude };
  const selectedProvider = loaded.value.provider;
  const selected = checks[selectedProvider];
  await writeValue(
    context,
    {
      status:
        node.available && git.available && selected.available
          ? "ok"
          : "degraded",
      selectedProvider,
      checks,
    },
    rawOptions.format,
  );
  return 0;
}

function addFormat(command: Command): Command {
  return command.option(
    "--format <format>",
    "auto, pretty, jsonl, or json",
    "auto",
  );
}

function buildProgram(
  context: NormalizedContext,
  setExitCode: (value: number) => void,
  helpWrites: Promise<void>[],
): Command {
  const program = new Command();
  program
    .name("awsl")
    .description("Run durable JavaScript workflows with Codex or Claude")
    .version(packageVersion)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        helpWrites.push(context.writeStdout(value));
      },
      writeErr: () => {},
      outputError: () => {},
    })
    .addHelpText(
      "after",
      `
Start here:
  awsl doctor
  awsl workflow inspect <workflow>
  awsl run <workflow> --provider codex --args '{"key":"value"}'

Workflow contract:
  Start with a pure literal "export const meta = { name, description }".
  Available globals include args, agent, parallel, pipeline, phase, log,
  workflow, budget, setTimeout, and clearTimeout.

Use "awsl help <command>" or "awsl help <group> <command>" for details.
Workflow files are trusted code. A run uses one provider and never falls back.`,
    );

  const run = addFormat(
    program
      .command("run")
      .description("run a workflow")
      .argument("<workflow>")
      .option("--provider <provider>", "codex or claude")
      .option("--args <json>", "workflow arguments")
      .option("--args-file <path>", "workflow arguments file or -")
      .option("--cwd <path>", "session working directory")
      .option("--budget <tokens>", "output token budget"),
  ).addHelpText(
    "after",
    `
Arguments:
  --args, --args-file, and non-empty piped stdin are mutually exclusive.
  JSON is strict, rejects duplicate keys, and is limited to 512 KiB.

Output:
  auto uses pretty on a TTY and jsonl otherwise. json emits one terminal envelope.
  A run uses one provider for the complete workflow tree and never falls back.

Examples:
  awsl run review.js --provider codex --args '{"request":"review auth"}'
  awsl review.js --args-file input.json --format json`,
  );
  run.action(async (workflow: string, options: RunCommandOptions) => {
    setExitCode(await runCommand(workflow, options, context));
  });

  const resume = addFormat(
    program
      .command("resume")
      .description("resume a durable run")
      .argument("<run-id>")
      .option("--args <json>", "replacement workflow arguments")
      .option("--args-file <path>", "replacement arguments file or -")
      .option("--budget <tokens>", "replacement output token budget"),
  ).addHelpText(
    "after",
    `
Resume reuses the longest valid journal prefix. Provider, executable version,
working directory, workflow sources, and model policy remain pinned.

Example:
  awsl resume <run-id> --args-file input.json --format json`,
  );
  resume.action(async (runId: string, options: ResumeCommandOptions) => {
    setExitCode(await resumeCommand(runId, options, context));
  });

  const runs = program
    .command("runs")
    .description("inspect durable runs")
    .addHelpText(
      "after",
      `
Run IDs are scoped to the current project and configured state directory.
Use "awsl help runs <command>" for command-specific help.`,
    );
  const runsList = addFormat(
    runs.command("list").description("list runs"),
  ).addHelpText(
    "after",
    `
Lists durable runs for the current project, including status, active ownership,
attempt number, and whether interrupted work may execute at least once.`,
  );
  runsList.action(async (options: FormatCommandOptions) => {
    setExitCode(await runsListCommand(options, context));
  });
  const runsShow = addFormat(
    runs.command("show").description("show one run").argument("<run-id>"),
  ).addHelpText(
    "after",
    `
Shows the durable run snapshot, terminal result when present, active ownership,
and at-least-once warning state for the current project.`,
  );
  runsShow.action(async (runId: string, options: FormatCommandOptions) => {
    setExitCode(await runsShowCommand(runId, options, context));
  });
  const runsPause = addFormat(
    runs
      .command("pause")
      .description("cooperatively pause one active run")
      .argument("<run-id>"),
  ).addHelpText(
    "after",
    `
Verifies the recorded process identity, requests a cooperative pause, and waits
for durable confirmation. Continue later with "awsl resume <run-id>".`,
  );
  runsPause.action(async (runId: string, options: FormatCommandOptions) => {
    setExitCode(await runsPauseCommand(runId, options, context));
  });

  const doctor = addFormat(
    program.command("doctor").description("check local capabilities"),
  ).addHelpText(
    "after",
    `
Doctor checks Node, Git, Codex, and Claude without invoking a model. Overall
status follows the selected provider; an unavailable unused provider does not
block a run. New provider versions are reported as unverified, not rejected.`,
  );
  doctor.action(async (options: FormatCommandOptions) => {
    setExitCode(await doctorCommand(options, context));
  });

  const config = program
    .command("config")
    .description("inspect configuration")
    .addHelpText(
      "after",
      `
Configuration precedence is CLI, AWSL_ environment, project config, user
config, then defaults. "config show" includes field provenance.`,
    );
  const configShow = addFormat(
    config.command("show").description("show merged configuration"),
  ).addHelpText(
    "after",
    `
Reports resolved configuration, per-field provenance, and hashed config source
identities with defensive secret redaction.`,
  );
  configShow.action(async (options: FormatCommandOptions) => {
    setExitCode(await configShowCommand(options, context));
  });

  const workflow = program
    .command("workflow")
    .description("inspect workflows")
    .addHelpText(
      "after",
      `
Inspection validates trusted JavaScript without probing a provider or invoking
a model. It reports the normalized awsl Workflow ABI and metadata.`,
    );
  const workflowInspect = addFormat(
    workflow
      .command("inspect")
      .description("validate and inspect a workflow")
      .argument("<file>"),
  ).addHelpText(
    "after",
    `
Parses and validates the file locally, then reports its canonical path, source
hash, metadata, and normalized Workflow ABI. No provider or model is invoked.`,
  );
  workflowInspect.action(
    async (file: string, options: FormatCommandOptions) => {
      setExitCode(await workflowInspectCommand(file, options, context));
    },
  );
  return program;
}

export async function executeCli(
  argv: readonly string[],
  rawContext: CliContext,
): Promise<number> {
  const context = normalizeContext(rawContext);
  let exitCode = 0;
  const helpWrites: Promise<void>[] = [];
  try {
    const requested = argv.length === 0 ? ["help"] : argv;
    const rewritten = rewriteLeadingWorkflow(rewriteHelpPath(requested));
    rejectUnknownNestedCommand(rewritten);
    rejectDuplicateLongOptions(rewritten);
    if (
      rewritten[0] === "resume" &&
      rewritten[1] !== "--help" &&
      rewritten[1] !== "-h"
    )
      parseResume(rewritten.slice(1));
    const program = buildProgram(
      context,
      (value) => {
        exitCode = value;
      },
      helpWrites,
    );
    await program.parseAsync(rewritten, { from: "user" });
    await Promise.all(helpWrites);
    return exitCode;
  } catch (error) {
    await Promise.allSettled(helpWrites);
    if (
      error instanceof CommanderError &&
      (error.code === "commander.help" ||
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    )
      return 0;
    if (error instanceof CommanderError)
      return writeDiagnostic(
        context,
        new AwslError("USAGE_ERROR", "invalid command line", {
          recoverable: false,
        }),
      );
    return writeDiagnostic(context, error);
  }
}
