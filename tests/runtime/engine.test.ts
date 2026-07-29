import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

import {
  type AgentRegistry,
  createRegistry,
} from "../../src/compat/agent-registry.js";
import { COMPATIBILITY_PROFILE } from "../../src/compat/profile.js";
import {
  type ProviderPinV1,
  type ProviderPinV2,
  parseProviderPinV1,
  parseProviderPinV2,
} from "../../src/config/provider-pin.js";
import type { ResolvedAwslConfig } from "../../src/config/types.js";
import type { ResolvedWorkflowSource } from "../../src/config/workflow-resolver.js";
import { resolveRootWorkflow } from "../../src/config/workflow-resolver.js";
import { AwslError } from "../../src/core/errors.js";
import type { AwslEvent } from "../../src/core/events.js";
import type {
  ProviderAdapter,
  ProviderOutcome,
  ProviderRequest,
} from "../../src/core/types.js";
import {
  type ResumeWorkflowOptions,
  runWorkflow,
} from "../../src/runtime/engine.js";
import { journalKeyV2 } from "../../src/store/canonical-json.js";
import { validateJournalRecords } from "../../src/store/jsonl.js";
import { FileRunStore } from "../../src/store/run-store.js";
import type {
  DurableJournalRecord,
  JournalAttemptRecordV1,
  JournalCallRecordV1,
  JournalRecordV1,
  LockOwner,
  RunLock,
  RunResultSnapshot,
  RunSnapshot,
  RunStore,
  SourceSnapshot,
  SourceSnapshotInput,
} from "../../src/store/types.js";

const fixtures = dirname(
  fileURLToPath(
    new URL("../fixtures/workflows/nested/basic-agent.js", import.meta.url),
  ),
);
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;
const HASH_D = `sha256:${"d".repeat(64)}` as const;
const execFile = promisify(nodeExecFile);

class RecordingStore implements RunStore {
  readonly events: AwslEvent[] = [];
  readonly records: JournalRecordV1[] = [];
  readonly snapshots: RunSnapshot[] = [];
  readonly results: RunResultSnapshot[] = [];
  readonly order: string[] = [];
  loadCalls = 0;
  lockCalls = 0;
  failBeginAttempt = false;
  failSnapshotWhen?: (snapshot: RunSnapshot) => boolean;
  failEventWhen?: (event: AwslEvent) => boolean;
  private priorDefault: unknown = undefined;
  private hasPriorDefault = false;
  private priorSources = "";
  private hasPriorSources = false;

  constructor(records: readonly JournalRecordV1[] = []) {
    this.records.push(...records);
  }

  async beginAttempt(
    record: Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    if (this.failBeginAttempt)
      throw new AwslError(
        "PERSISTENCE_ERROR",
        "attempt journal persistence failed",
        { recoverable: false },
      );
    return this.append(record);
  }

  async appendCall(
    record: Omit<JournalCallRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    return this.append(record);
  }

  async loadJournal(): Promise<readonly JournalRecordV1[]> {
    this.loadCalls += 1;
    this.order.push("journal.load");
    return this.records;
  }

  async writeRun(snapshot: RunSnapshot): Promise<void> {
    if (this.failSnapshotWhen?.(snapshot)) throw new Error("snapshot failed");
    const copy = JSON.parse(JSON.stringify(snapshot)) as RunSnapshot;
    this.snapshots.push(copy);
    const providerPin = copy.providerPin as {
      resolvedDefaultModel?: unknown;
      sources?: Array<{ kind?: unknown; reference?: unknown }>;
    };
    const nextDefault = providerPin?.resolvedDefaultModel;
    const nextSources = JSON.stringify(providerPin.sources ?? []);
    this.order.push(
      this.hasPriorDefault && this.priorDefault !== nextDefault
        ? `snapshot:default-change:${String(nextDefault)}`
        : this.hasPriorSources && this.priorSources !== nextSources
          ? `snapshot:sources:${(providerPin.sources ?? [])
              .map(
                ({ kind, reference }) => `${String(kind)}:${String(reference)}`,
              )
              .join("|")}`
          : "snapshot",
    );
    this.priorDefault = nextDefault;
    this.hasPriorDefault = true;
    this.priorSources = nextSources;
    this.hasPriorSources = true;
  }

  async writeResult(snapshot: RunResultSnapshot): Promise<void> {
    this.results.push(
      JSON.parse(JSON.stringify(snapshot)) as RunResultSnapshot,
    );
  }

  async writeSourceSnapshot(
    input: SourceSnapshotInput,
  ): Promise<SourceSnapshot> {
    this.order.push("source.snapshot");
    return {
      path: join("/state/scripts", `${input.attemptSeq}-${input.attemptId}.js`),
      manifestPath: join(
        "/state/scripts",
        `${input.attemptSeq}-${input.attemptId}.manifest.json`,
      ),
      sha256: rootHash(input.source),
      sourcePath: input.sourcePath,
      runId: input.runId,
      attemptId: input.attemptId,
      attemptSeq: input.attemptSeq,
    };
  }

  async appendEvent(event: AwslEvent): Promise<void> {
    if (this.failEventWhen?.(event))
      throw new AwslError("PERSISTENCE_ERROR", "event persistence failed", {
        recoverable: false,
      });
    this.events.push(JSON.parse(JSON.stringify(event)) as AwslEvent);
    this.order.push(`event:${event.type}`);
  }

  rawEventSink(): undefined {
    return undefined;
  }

  async acquireRunLock(_owner: LockOwner): Promise<RunLock> {
    this.lockCalls += 1;
    this.order.push("lock.acquire");
    return {
      release: async () => {
        this.order.push("lock.release");
      },
    };
  }

  private async append(
    record:
      | Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">
      | Omit<JournalCallRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    const assigned = {
      ...record,
      recordSeq: this.records.length,
      recordedAt: new Date(0).toISOString(),
    } as JournalRecordV1;
    this.records.push(assigned);
    this.order.push(
      assigned.kind === "attempt"
        ? `attempt:${assigned.attemptSeq}`
        : `call:${assigned.callSeq}:${assigned.state}`,
    );
    return { record: assigned, durable: true };
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "codex" as const;
  readonly identity = {
    id: "codex" as const,
    executableRealpath: "/opt/awsl/codex",
    version: "0.145.0",
  };
  readonly capabilities = {
    systemPrompt: "prompt-prefix" as const,
    tools: { allowlist: false, denylist: false, denyAll: false },
    mcp: { additive: false, strictReplacement: false, denyAll: false },
    permissionModes: [] as readonly string[],
    sandboxModes: [] as const,
    skills: false as const,
    structuredAttemptEvents: true,
    resolvedModelEvents: true,
  };
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly handler: (
      request: ProviderRequest,
      index: number,
    ) => ProviderOutcome | Promise<ProviderOutcome>,
  ) {}

  async run(request: ProviderRequest): Promise<ProviderOutcome> {
    this.calls.push(request);
    return this.handler(request, this.calls.length - 1);
  }
}

function rootHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function config(canonicalCwd: string): ResolvedAwslConfig {
  const tiers = {
    fast: { model: "gpt-5.6-terra", effort: "low" as const },
    balanced: { model: "gpt-5.6-terra", effort: "medium" as const },
    strong: { model: "gpt-5.6-sol", effort: "high" as const },
  };
  return {
    provider: "codex",
    stateDir: join(canonicalCwd, ".state"),
    rawProviderEvents: false,
    providers: {
      codex: {
        id: "codex",
        executable: "codex",
        args: [],
        nativeModels: [],
        tiers,
        models: {},
      },
      claude: {
        id: "claude",
        executable: "claude",
        args: [],
        nativeModels: [],
        tiers: {
          fast: { model: "haiku", effort: "low" },
          balanced: { model: "sonnet", effort: "medium" },
          strong: { model: "opus", effort: "high" },
        },
        models: {},
      },
    },
    registry: { pluginDirs: [] },
  };
}

function pin(
  canonicalCwd: string,
  root: ResolvedWorkflowSource,
  overrides: Record<string, unknown> = {},
): ProviderPinV2 {
  return parseProviderPinV2({
    version: 2,
    provider: "codex",
    compatibilityProfile: "claude-code@2.1.218",
    executableRealpath: "/opt/awsl/codex",
    executableVersion: "0.145.0",
    explicitDefaultModel: null,
    resolvedDefaultModel: null,
    providerProfile: null,
    canonicalCwd,
    sources: [
      {
        kind: "workflow-path",
        reference: root.reference,
        realpath: root.realpath,
      },
    ],
    awslBehaviorFingerprint: HASH_A,
    modelMapFingerprint: HASH_B,
    nativeRoutingFingerprint: HASH_C,
    configuredNativeModels: [],
    ...overrides,
  });
}

function legacyPin(
  canonicalCwd: string,
  root: ResolvedWorkflowSource,
  overrides: Record<string, unknown> = {},
): ProviderPinV1 {
  const current = pin(canonicalCwd, root, overrides);
  const { configuredNativeModels: _configuredNativeModels, ...common } =
    current;
  return parseProviderPinV1({ ...common, version: 1 });
}

async function harness(
  fixtureName: string,
  provider: RecordingProvider,
  store = new RecordingStore(),
) {
  const canonicalCwd = await realpath(fixtures);
  const root = await resolveRootWorkflow(
    join(fixtures, fixtureName),
    canonicalCwd,
  );
  const home = await mkdtemp(join(tmpdir(), "awsl-engine-home-"));
  const registry = await createRegistry({
    cwd: canonicalCwd,
    provider: "claude",
    homeDir: home,
    claudeConfigDir: join(home, "missing"),
  });
  return {
    canonicalCwd,
    root,
    registry,
    providerPin: pin(canonicalCwd, root),
    config: config(canonicalCwd),
    provider,
    store,
  };
}

async function namedAgentHarness(
  workflowSource: string,
  agentNames: readonly string[],
  provider: RecordingProvider,
  store = new RecordingStore(),
) {
  const sandbox = await mkdtemp(join(tmpdir(), "awsl-engine-registry-"));
  const project = join(sandbox, "project");
  const agentRoot = join(project, ".claude", "agents");
  const home = join(sandbox, "home");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(agentRoot, { recursive: true });
  await mkdir(home);
  const workflowPath = join(project, "workflow.js");
  await writeFile(workflowPath, workflowSource);
  for (const name of agentNames)
    await writeFile(
      join(agentRoot, `${name}.md`),
      `---
name: ${name}
description: ${name} agent
---
Run the ${name} branch.
`,
    );
  const canonicalCwd = await realpath(project);
  const root = await resolveRootWorkflow(workflowPath, canonicalCwd);
  const registry = await createRegistry({
    cwd: canonicalCwd,
    provider: "claude",
    homeDir: home,
    claudeConfigDir: join(home, "missing"),
  });
  return {
    sandbox,
    options: {
      canonicalCwd,
      root,
      registry,
      providerPin: pin(canonicalCwd, root),
      config: config(canonicalCwd),
      provider,
      store,
    },
  };
}

const lockOwner: LockOwner = {
  nonce: "engine-test",
  pid: process.pid,
  processStartIdentity: "engine-test-process",
};

describe("runtime engine", () => {
  test("rejects a legacy V1 pin for a fresh run before locking or provider use", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("provider must not launch");
    });
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);

    await expect(
      runWorkflow({
        ...options,
        providerPin: legacyPin(
          options.canonicalCwd,
          options.root,
        ) as unknown as ProviderPinV2,
        runId: "fresh-v1-pin",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    expect(store.lockCalls).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  test("executes one pinned provider and preserves a business status field", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt.toUpperCase() },
      usage: { inputTokens: 2, outputTokens: 1, complete: true },
    }));
    const options = await harness("basic-agent.js", provider);

    const run = await runWorkflow({
      ...options,
      runId: "basic-run",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { prompt: "hello" },
      lockOwner,
    });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual({
      answer: "HELLO",
      requestedStatus: "failed",
    });
    expect(provider.calls).toHaveLength(1);
    expect(run.metrics).toMatchObject({
      agentCount: 1,
      inputTokens: 2,
      attemptOutputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
    });
  });

  test("validates structured results again before completing the call", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "completed",
      result: { text: "json", data: { answer: "ok" } },
      usage: { outputTokens: 1, complete: true },
    }));
    const options = await harness("structured-agent.js", provider);
    const run = await runWorkflow({
      ...options,
      runId: "schema-run",
      attemptId: "attempt-0",
      attemptSeq: 0,
      lockOwner,
    });

    expect(run.result).toEqual({ answer: "ok" });
    expect(provider.calls[0]?.schema).toEqual(
      expect.objectContaining({ type: "object" }),
    );

    const invalidProvider = new RecordingProvider(() => ({
      kind: "completed",
      result: { text: "json", data: { answer: 7 } },
      usage: { outputTokens: 1, complete: true },
    }));
    const invalid = await harness("structured-agent.js", invalidProvider);
    await expect(
      runWorkflow({
        ...invalid,
        runId: "schema-invalid",
        attemptId: "attempt-0",
        attemptSeq: 0,
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_ERROR" });
    expect(
      invalid.store.records.some(
        (record) => record.kind === "call" && record.state === "completed",
      ),
    ).toBe(false);
  });

  test("shares budget, counters, run identity, and a forced child phase", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt.toUpperCase() },
      usage: {
        inputTokens: 1,
        outputTokens: 3,
        reasoningTokens: 2,
        complete: true,
      },
    }));
    const options = await harness("parent.js", provider);
    const run = await runWorkflow({
      ...options,
      runId: "child-run",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { childPath: join(fixtures, "child.js") },
      lockOwner,
    });

    expect(run.result).toEqual({
      parent: "PARENT",
      child: { child: "CHILD", spent: 6 },
      spent: 6,
    });
    expect(run.metrics).toMatchObject({
      agentCount: 2,
      attemptOutputTokens: 6,
      reasoningTokens: 4,
    });
    expect(new Set(run.events.map((event) => event.runId))).toEqual(
      new Set(["child-run"]),
    );
    const childStarted = run.events.find(
      (event) =>
        event.type === "call.started" &&
        (event.data as { prompt?: string }).prompt === "child",
    );
    expect((childStarted?.data as { phase?: string }).phase).toBe(
      "child:child",
    );
    expect(
      run.events.some(
        (event) =>
          event.type === "phase.changed" &&
          (event.data as { phase?: string }).phase === "ignored-child-phase",
      ),
    ).toBe(false);
  });

  test("runs project and namespaced plugin workflows in the parent run", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "awsl-engine-workflows-"));
    const project = join(sandbox, "project");
    const projectWorkflows = join(project, ".claude", "workflows");
    const plugin = join(sandbox, "plugin");
    const pluginWorkflows = join(plugin, "workflows");
    const home = join(sandbox, "home");
    const rootPath = join(project, "root.js");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(projectWorkflows, { recursive: true });
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(pluginWorkflows, { recursive: true });
    await mkdir(home);
    await writeFile(
      rootPath,
      `export const meta = {
  name: "registry-parent",
  description: "Run registered child workflows",
}

phase("Parent")
const project = await workflow("project-child", { prompt: "project" })
const plugin = await workflow("sample:plugin-child", { prompt: "plugin" })
return { project, plugin, spent: budget.spent() }
`,
    );
    await writeFile(
      join(projectWorkflows, "project.js"),
      `export const meta = {
  name: "project-child",
  description: "Project child",
}

phase("ignored-project-phase")
return { value: await agent(args.prompt), spent: budget.spent() }
`,
    );
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      '{"name":"sample"}',
    );
    await writeFile(
      join(pluginWorkflows, "plugin.js"),
      `export const meta = {
  name: "plugin-child",
  description: "Plugin child",
}

phase("ignored-plugin-phase")
return { value: await agent(args.prompt), spent: budget.spent() }
`,
    );
    try {
      const canonicalCwd = await realpath(project);
      const root = await resolveRootWorkflow(rootPath, canonicalCwd);
      const registry = await createRegistry({
        cwd: canonicalCwd,
        provider: "claude",
        homeDir: home,
        claudeConfigDir: join(home, "missing"),
        pluginDirs: [plugin],
      });
      const provider = new RecordingProvider((request) => ({
        kind: "completed",
        result: { text: request.prompt.toUpperCase() },
        usage: { outputTokens: 2, complete: true },
      }));

      const run = await runWorkflow({
        canonicalCwd,
        root,
        registry,
        providerPin: pin(canonicalCwd, root),
        config: {
          ...config(canonicalCwd),
          registry: { pluginDirs: [plugin] },
        },
        provider,
        store: new RecordingStore(),
        runId: "registry-child-run",
        attemptId: "attempt-0",
        attemptSeq: 0,
        lockOwner,
      });

      expect(run.result).toEqual({
        project: { value: "PROJECT", spent: 2 },
        plugin: { value: "PLUGIN", spent: 4 },
        spent: 4,
      });
      expect(run.metrics).toMatchObject({
        agentCount: 2,
        attemptOutputTokens: 4,
      });
      expect(provider.calls.map(({ prompt }) => prompt)).toEqual([
        "project",
        "plugin",
      ]);
      expect(
        run.events
          .filter((event) => event.type === "call.started")
          .map((event) => {
            const data = event.data as { phase?: string; prompt?: string };
            return { phase: data.phase, prompt: data.prompt };
          }),
      ).toEqual([
        { phase: "child:project-child", prompt: "project" },
        { phase: "child:plugin-child", prompt: "plugin" },
      ]);
      expect(run.providerPin.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "workflow-registry",
            reference: "project-child",
          }),
          expect.objectContaining({
            kind: "workflow-registry",
            reference: "sample:plugin-child",
          }),
          expect.objectContaining({
            kind: "plugin-manifest",
            reference: plugin,
          }),
        ]),
      );
      expect(
        run.events.some(
          (event) =>
            event.type === "phase.changed" &&
            ["ignored-project-phase", "ignored-plugin-phase"].includes(
              String((event.data as { phase?: string }).phase),
            ),
        ),
      ).toBe(false);
      expect(new Set(run.events.map(({ runId }) => runId))).toEqual(
        new Set(["registry-child-run"]),
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("allows active calls to overshoot, then gates later work", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new RecordingProvider(async (request, index) => {
      if (index === 1) release();
      await barrier;
      return {
        kind: "completed",
        result: { text: request.prompt },
        usage: { outputTokens: 2, complete: true },
      };
    });
    const options = await harness("parallel-budget.js", provider);
    const run = await runWorkflow({
      ...options,
      runId: "budget-run",
      attemptId: "attempt-0",
      attemptSeq: 0,
      budget: 3,
      concurrency: 2,
      lockOwner,
    });

    expect(run.result).toEqual({
      first: ["one", "two"],
      thirdError: "BUDGET_EXCEEDED",
      spent: 4,
    });
    expect(provider.calls).toHaveLength(2);
    expect(run.metrics.agentCount).toBe(3);
    expect(run.budget).toEqual({ total: 3, spent: 4 });
  });

  test("returns null for a failed provider branch without failing parallel", async () => {
    const provider = new RecordingProvider((request, index) =>
      index === 0
        ? {
            kind: "completed",
            result: { text: request.prompt },
            usage: { outputTokens: 1, complete: true },
          }
        : {
            kind: "error",
            error: new AwslError("PROVIDER_ERROR", "branch failed", {
              provider: "codex",
              recoverable: false,
            }),
            usage: { outputTokens: 1, complete: true },
          },
    );
    const store = new RecordingStore();
    const options = await harness("parallel-two.js", provider, store);

    const run = await runWorkflow({
      ...options,
      runId: "parallel-provider-failure",
      attemptId: "attempt-0",
      attemptSeq: 0,
      concurrency: 2,
      lockOwner,
    });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual(["one", null]);
    expect(provider.calls).toHaveLength(2);
    expect(
      store.records.filter(
        (record) => record.kind === "call" && record.state === "completed",
      ),
    ).toHaveLength(1);
    expect(
      store.records.filter(
        (record) => record.kind === "call" && record.state === "failed",
      ),
    ).toHaveLength(1);
  });

  test("serializes concurrent source additions before either call completes", async () => {
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new RecordingProvider(async (request, index) => {
      if (index === 1) release();
      await bothStarted;
      return {
        kind: "completed",
        result: { text: request.prompt },
        usage: { outputTokens: 1, complete: true },
      };
    });
    const store = new RecordingStore();
    const fixture = await namedAgentHarness(
      `export const meta = {
  name: "concurrent-sources",
  description: "Resolve two agent definitions concurrently",
}

return await parallel([
  () => agent("one", { agentType: "alpha" }),
  () => agent("two", { agentType: "beta" }),
])
`,
      ["alpha", "beta"],
      provider,
      store,
    );
    try {
      const run = await runWorkflow({
        ...fixture.options,
        runId: "concurrent-sources",
        attemptId: "attempt-0",
        attemptSeq: 0,
        concurrency: 2,
        lockOwner,
      });

      expect(run.result).toEqual(["one", "two"]);
      expect(run.providerPin.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent-registry",
            reference: "alpha",
          }),
          expect.objectContaining({
            kind: "agent-registry",
            reference: "beta",
          }),
        ]),
      );
      const bothSources = store.order.findIndex(
        (entry) =>
          entry.startsWith("snapshot:sources:") &&
          entry.includes("agent-registry:alpha") &&
          entry.includes("agent-registry:beta"),
      );
      expect(bothSources).toBeGreaterThanOrEqual(0);
      for (const terminal of store.order
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.endsWith(":completed")))
        expect(terminal.index).toBeGreaterThan(bothSources);
    } finally {
      await rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  test("fails a repeated source identity drift before a second provider launch", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt },
      usage: { outputTokens: 1, complete: true },
    }));
    const store = new RecordingStore();
    const fixture = await namedAgentHarness(
      `export const meta = {
  name: "source-drift",
  description: "Resolve the same agent twice",
}

await agent("one", { agentType: "drift" })
return await agent("two", { agentType: "drift" })
`,
      ["drift"],
      provider,
      store,
    );
    let resolutions = 0;
    const stableRegistry = fixture.options.registry;
    const driftingRegistry: AgentRegistry = {
      workflows: stableRegistry.workflows,
      agents: stableRegistry.agents,
      plugins: stableRegistry.plugins,
      resolveWorkflow: (key) => stableRegistry.resolveWorkflow(key),
      resolveAgent: async (key) => {
        const entry = await stableRegistry.resolveAgent(key);
        resolutions += 1;
        return resolutions === 1
          ? entry
          : {
              ...entry,
              source: { ...entry.source, sha256: HASH_D },
            };
      },
    };
    try {
      await expect(
        runWorkflow({
          ...fixture.options,
          registry: driftingRegistry,
          runId: "source-drift",
          attemptId: "attempt-0",
          attemptSeq: 0,
          lockOwner,
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        message: "provider pin source identity drift",
      });
      expect(provider.calls).toHaveLength(1);
      expect(
        store.records.filter(
          (record) => record.kind === "call" && record.state === "completed",
        ),
      ).toHaveLength(1);
      expect(
        store.records.filter(
          (record) => record.kind === "call" && record.state === "failed",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  test("serializes one agreeing default CAS before concurrent completions", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt },
      usage: { outputTokens: 1, complete: true },
      observation: { resolvedModel: "gpt-5.6-sol" },
    }));
    const store = new RecordingStore();
    const options = await harness("parallel-two.js", provider, store);
    const run = await runWorkflow({
      ...options,
      runId: "default-cas",
      attemptId: "attempt-0",
      attemptSeq: 0,
      concurrency: 2,
      lockOwner,
    });

    expect(run.providerPin.resolvedDefaultModel).toBe("gpt-5.6-sol");
    expect(
      store.order.filter(
        (entry) => entry === "snapshot:default-change:gpt-5.6-sol",
      ),
    ).toHaveLength(1);
    const pinWrite = store.order.indexOf("snapshot:default-change:gpt-5.6-sol");
    for (const terminal of store.order
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.endsWith(":completed")))
      expect(terminal.index).toBeGreaterThan(pinWrite);
  });

  test("durably discovers and resumes a configured native default", async () => {
    const configuredModel = "private-configured-extension";
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.model ?? "implicit" },
      usage: { outputTokens: 1, complete: true },
      observation: { resolvedModel: configuredModel },
    }));
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const runtimeConfig = {
      ...options.config,
      providers: {
        ...options.config.providers,
        codex: {
          ...options.config.providers.codex,
          nativeModels: [configuredModel],
        },
      },
    };
    const providerPin = parseProviderPinV2({
      ...options.providerPin,
      version: 2,
      configuredNativeModels: [configuredModel],
    });

    const first = await runWorkflow({
      ...options,
      config: runtimeConfig,
      providerPin,
      runId: "configured-native-default",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { prompt: "first" },
      lockOwner,
    });

    expect(first.providerPin).toMatchObject({
      version: 2,
      configuredNativeModels: [configuredModel],
      resolvedDefaultModel: configuredModel,
    });
    expect(
      store.order.indexOf(`snapshot:default-change:${configuredModel}`),
    ).toBeLessThan(store.order.indexOf("call:0:completed"));

    const resumed = await runWorkflow({
      ...options,
      config: runtimeConfig,
      providerPin,
      runId: "configured-native-default",
      attemptId: "attempt-1",
      attemptSeq: 1,
      args: { prompt: "second" },
      lockOwner: { ...lockOwner, nonce: "configured-native-attempt-1" },
      resume: {
        storedPin: first.providerPin,
        storedWorktreeBase: first.worktreeBase,
        storedWorktrees: [],
      },
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.model).toBeUndefined();
    expect(provider.calls[1]?.model).toBe(configuredModel);
    expect(resumed.result).toMatchObject({ answer: configuredModel });
    expect(resumed.providerPin.resolvedDefaultModel).toBe(configuredModel);
  });

  test("fails one conflicting default observation without publishing a replayable completion", async () => {
    const provider = new RecordingProvider((request, index) => ({
      kind: "completed",
      result: { text: request.prompt },
      usage: { outputTokens: 1, complete: true },
      observation: {
        resolvedModel: index === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
      },
    }));
    const store = new RecordingStore();
    const options = await harness("parallel-two.js", provider, store);
    const run = await runWorkflow({
      ...options,
      runId: "default-conflict",
      attemptId: "attempt-0",
      attemptSeq: 0,
      concurrency: 2,
      lockOwner,
    });

    expect(
      (run.result as Array<unknown>).filter((value) => value === null),
    ).toHaveLength(1);
    expect(
      store.records.filter(
        (record) => record.kind === "call" && record.state === "completed",
      ),
    ).toHaveLength(1);
    expect(
      store.records.filter(
        (record) => record.kind === "call" && record.state === "failed",
      ),
    ).toHaveLength(1);
    expect(run.providerPin.resolvedDefaultModel).toMatch(
      /^gpt-5\.6-(?:sol|terra)$/,
    );
  });

  test("does not append a terminal call when the required pin snapshot fails", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt },
      usage: { outputTokens: 1, complete: true },
      observation: { resolvedModel: "gpt-5.6-sol" },
    }));
    const store = new RecordingStore();
    store.failSnapshotWhen = (snapshot) =>
      (snapshot.providerPin as { resolvedDefaultModel?: unknown })
        .resolvedDefaultModel !== null;
    const options = await harness("basic-agent.js", provider, store);

    await expect(
      runWorkflow({
        ...options,
        runId: "snapshot-failure",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(
      store.records.filter(
        (record) =>
          record.kind === "call" &&
          ["completed", "failed", "indeterminate"].includes(record.state),
      ),
    ).toHaveLength(0);
  });

  test("marks incomplete output-token usage indeterminate and never reusable", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "completed",
      result: { text: "unaccounted" },
      usage: { inputTokens: 2, complete: false },
    }));
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);

    await expect(
      runWorkflow({
        ...options,
        runId: "usage-indeterminate",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "provider output-token usage is indeterminate",
    });
    expect(
      store.records.filter(
        (record) => record.kind === "call" && record.state === "indeterminate",
      ),
    ).toHaveLength(1);
    expect(
      store.records.some(
        (record) => record.kind === "call" && record.state === "completed",
      ),
    ).toBe(false);
    expect(store.results.at(-1)?.metrics).toMatchObject({
      inputTokens: 2,
      usageComplete: false,
    });
  });

  test("rejects a proxied provider outcome without invoking any trap", async () => {
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("provider outcome trap must not run");
    };
    const outcome = new Proxy(
      {
        kind: "completed",
        result: { text: "unsafe" },
        usage: { outputTokens: 1, complete: true },
      },
      {
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
      },
    ) as unknown as ProviderOutcome;
    const provider = new RecordingProvider(() => outcome);
    const options = await harness("basic-agent.js", provider);

    await expect(
      runWorkflow({
        ...options,
        runId: "proxied-outcome",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "provider outcome is invalid",
    });
    expect(trapCalls).toBe(0);
  });

  test("rejects a proxied nested provider error without invoking any trap", async () => {
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error("nested provider error trap must not run");
    };
    const error = new Proxy(
      new AwslError("PROVIDER_ERROR", "unsafe", {
        provider: "codex",
        recoverable: false,
      }),
      {
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
      },
    );
    const provider = new RecordingProvider(
      () =>
        ({
          kind: "error",
          error,
          usage: { outputTokens: 1, complete: true },
        }) as ProviderOutcome,
    );
    const options = await harness("basic-agent.js", provider);

    await expect(
      runWorkflow({
        ...options,
        runId: "proxied-nested-error",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "provider outcome is invalid",
    });
    expect(trapCalls).toBe(0);
  });

  test("fails closed when persisting a failed run status is itself unsuccessful", async () => {
    const original = new AwslError("PROVIDER_ERROR", "provider failed", {
      provider: "codex",
      recoverable: false,
    });
    const provider = new RecordingProvider(() => ({
      kind: "error",
      error: original,
      usage: { outputTokens: 1, complete: true },
    }));
    const store = new RecordingStore();
    store.failSnapshotWhen = (snapshot) => snapshot.status === "failed";
    const options = await harness("basic-agent.js", provider, store);

    await expect(
      runWorkflow({
        ...options,
        runId: "failed-status-persistence",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  test("revalidates dynamically added sources before replaying a real prior run", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt.toUpperCase() },
      usage: { outputTokens: 1, complete: true },
    }));
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const first = await runWorkflow({
      ...options,
      runId: "dynamic-resume",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { prompt: "hello" },
      lockOwner,
    });
    expect(first.providerPin.sources).toContainEqual(
      expect.objectContaining({ kind: "builtin-agent" }),
    );

    const second = await runWorkflow({
      ...options,
      runId: "dynamic-resume",
      attemptId: "attempt-1",
      attemptSeq: 1,
      args: { prompt: "hello" },
      lockOwner,
      resume: {
        storedPin: first.providerPin,
        storedWorktreeBase: first.worktreeBase,
        storedWorktrees: [],
      },
    });

    expect(second.result).toEqual(first.result);
    expect(provider.calls).toHaveLength(1);
    expect(second.metrics).toMatchObject({
      attemptOutputTokens: 0,
      outputTokens: 1,
      usageComplete: true,
    });
    expect(
      store.events.some(
        (event) =>
          event.type === "call.reused" &&
          (event.data as { callSeq?: number }).callSeq === 0,
      ),
    ).toBe(true);
  });

  test("writes a validator-clean file journal and resumes its longest prefix", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.prompt.toUpperCase() },
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        reasoningTokens: 1,
        complete: true,
      },
    }));
    const base = await harness("basic-agent.js", provider);
    const stateRoot = await mkdtemp(join(tmpdir(), "awsl-engine-store-"));
    try {
      const firstStore = await FileRunStore.open({
        root: stateRoot,
        runId: "file-resume",
      });
      const first = await runWorkflow({
        ...base,
        store: firstStore,
        runDir: firstStore.paths.runDir,
        runId: "file-resume",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        lockOwner: { ...lockOwner, nonce: "file-attempt-0" },
      });
      validateJournalRecords(await firstStore.loadJournal());

      const secondStore = await FileRunStore.open({
        root: stateRoot,
        runId: "file-resume",
      });
      const second = await runWorkflow({
        ...base,
        store: secondStore,
        runDir: secondStore.paths.runDir,
        runId: "file-resume",
        attemptId: "attempt-1",
        attemptSeq: 1,
        args: { prompt: "hello" },
        lockOwner: { ...lockOwner, nonce: "file-attempt-1" },
        resume: {
          storedPin: first.providerPin,
          storedWorktreeBase: first.worktreeBase,
          storedWorktrees: [],
        },
      });
      const journal = await secondStore.loadJournal();
      validateJournalRecords(journal);

      expect(second.result).toEqual(first.result);
      expect(provider.calls).toHaveLength(1);
      expect(
        journal.some(
          (record) =>
            record.kind === "call" &&
            record.attemptSeq === 1 &&
            record.state === "completed" &&
            record.completed?.origin === "reused",
        ),
      ).toBe(true);
      expect(second.metrics).toMatchObject({
        inputTokens: 2,
        outputTokens: 1,
        reasoningTokens: 1,
        attemptOutputTokens: 0,
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("waits for an aborted child agent to become indeterminate before releasing the run lock", async () => {
    let childStarted!: () => void;
    const activeChild = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const provider = new RecordingProvider((request) => {
      if (request.prompt === "parent")
        return {
          kind: "completed",
          result: { text: "PARENT" },
          usage: { outputTokens: 1, complete: true },
        };
      childStarted();
      return new Promise<ProviderOutcome>((_resolve, reject) => {
        const stop = () =>
          reject(
            new AwslError("CANCELLED", "provider cancelled", {
              provider: "codex",
              recoverable: false,
            }),
          );
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      });
    });
    const store = new RecordingStore();
    const options = await harness("parent.js", provider, store);
    const controller = new AbortController();
    const running = runWorkflow({
      ...options,
      runId: "child-cancel",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { childPath: join(fixtures, "child.js") },
      signal: controller.signal,
      lockOwner,
    });
    await activeChild;
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store.order).toContain("call:1:indeterminate");
    expect(store.order.indexOf("call:1:indeterminate")).toBeLessThan(
      store.order.indexOf("lock.release"),
    );
    expect(store.order.slice(store.order.indexOf("lock.release") + 1)).toEqual(
      [],
    );
  });

  test("aborts active providers when the root worker fails terminally", async () => {
    let providerStarted!: () => void;
    const activeProvider = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let providerAborted = false;
    const provider = new RecordingProvider(async (request) => {
      if (request.prompt === "barrier") {
        await activeProvider;
        return {
          kind: "completed",
          result: { text: "barrier-complete" },
          usage: { outputTokens: 1, complete: true },
        };
      }
      return new Promise<ProviderOutcome>((resolve, reject) => {
        providerStarted();
        const fallback = setTimeout(
          () =>
            resolve({
              kind: "completed",
              result: { text: "late" },
              usage: { outputTokens: 1, complete: true },
            }),
          300,
        );
        const stop = () => {
          providerAborted = true;
          clearTimeout(fallback);
          reject(
            new AwslError("CANCELLED", "provider cancelled", {
              provider: "codex",
              recoverable: false,
            }),
          );
        };
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      });
    });
    const store = new RecordingStore();
    const fixture = await namedAgentHarness(
      `export const meta = {
  name: "terminal-worker-failure",
  description: "Fail while a provider request is active",
}

void agent("slow")
await agent("barrier")
throw new Error("root worker exploded")
`,
      [],
      provider,
      store,
    );
    try {
      const running = runWorkflow({
        ...fixture.options,
        runId: "terminal-worker-failure",
        attemptId: "attempt-0",
        attemptSeq: 0,
        concurrency: 2,
        lockOwner,
      });
      await activeProvider;

      await expect(running).rejects.toMatchObject({
        code: "WORKFLOW_ERROR",
        message: expect.stringContaining("root worker exploded"),
      });
      expect(providerAborted).toBe(true);
      expect(store.records).toContainEqual(
        expect.objectContaining({
          kind: "call",
          state: "indeterminate",
        }),
      );
      expect(
        store.order.indexOf("call:0:indeterminate"),
      ).toBeGreaterThanOrEqual(0);
      expect(store.order.indexOf("call:0:indeterminate")).toBeLessThan(
        store.order.indexOf("lock.release"),
      );
      expect(store.results.at(-1)).toMatchObject({
        status: "failed",
        error: {
          code: "WORKFLOW_ERROR",
          message: expect.stringContaining("root worker exploded"),
        },
      });
    } finally {
      await rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  test("persists cooperative pause separately from a killed cancellation", async () => {
    let providerStarted!: () => void;
    const activeProvider = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider = new RecordingProvider((request) => {
      providerStarted();
      return new Promise<ProviderOutcome>((_resolve, reject) => {
        const stop = () =>
          reject(
            new AwslError("CANCELLED", "provider cancelled", {
              provider: "codex",
              recoverable: false,
            }),
          );
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      });
    });
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const controller = new AbortController();
    const running = runWorkflow({
      ...options,
      runId: "paused-run",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { prompt: "hello" },
      signal: controller.signal,
      cancellationStatus: () => "paused",
      lockOwner,
    });
    await activeProvider;
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store.snapshots.at(-1)).toMatchObject({ status: "paused" });
    expect(store.results.at(-1)).toMatchObject({ status: "paused" });
    expect(store.events.at(-1)).toMatchObject({
      type: "run.paused",
      data: { status: "paused", code: "CANCELLED" },
    });
    expect(store.order.indexOf("event:run.paused")).toBeLessThan(
      store.order.indexOf("lock.release"),
    );
  });

  test("durably initializes a pre-aborted attempt before persisting killed", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("a pre-aborted run must not launch a provider");
    });
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWorkflow({
        ...options,
        runId: "pre-aborted-run",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: { prompt: "hello" },
        signal: controller.signal,
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(provider.calls).toHaveLength(0);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      kind: "attempt",
      runId: "pre-aborted-run",
      attemptId: "attempt-0",
    });
    expect(store.snapshots[0]).toMatchObject({ status: "running" });
    expect(store.snapshots.at(-1)).toMatchObject({ status: "killed" });
    expect(store.results.at(-1)).toMatchObject({
      status: "killed",
      error: { code: "CANCELLED" },
    });
    expect(store.events.at(-1)).toMatchObject({ type: "run.killed" });
    expect(store.order.indexOf("source.snapshot")).toBeLessThan(
      store.order.indexOf("lock.release"),
    );
    expect(store.order.indexOf("attempt:0")).toBeLessThan(
      store.order.indexOf("lock.release"),
    );
  });

  test("redacts event data before persistence, callbacks, and returned events", async () => {
    const secret = "EVENT_SECRET_CANARY";
    const provider = new RecordingProvider(() => ({
      kind: "completed",
      result: { text: "ok" },
      usage: { outputTokens: 1, complete: true },
    }));
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const observed: AwslEvent[] = [];

    const run = await runWorkflow({
      ...options,
      runId: "redacted-events",
      attemptId: "attempt-0",
      attemptSeq: 0,
      args: { prompt: `token=${secret}` },
      eventSink: (event) => {
        observed.push(event);
      },
      lockOwner,
    });

    for (const collection of [store.events, observed, run.events]) {
      const encoded = JSON.stringify(collection);
      expect(encoded).not.toContain(secret);
      expect(encoded).toContain("[REDACTED]");
    }
  });

  test("does not launch a provider when cancellation arrives during worktree setup", async () => {
    const repoRoot = await realpath(join(fixtures, "../../../.."));
    const root = await resolveRootWorkflow(
      join(fixtures, "worktree-agent.js"),
      repoRoot,
    );
    const home = await mkdtemp(join(tmpdir(), "awsl-worktree-home-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "awsl-worktree-state-"));
    const runDir = join(stateRoot, "run");
    await mkdir(runDir);
    const registry = await createRegistry({
      cwd: repoRoot,
      provider: "claude",
      homeDir: home,
      claudeConfigDir: join(home, "missing"),
    });
    const provider = new RecordingProvider(() => {
      throw new Error("provider must not launch");
    });
    const store = new RecordingStore();
    const controller = new AbortController();
    let retainedPath: string | undefined;
    try {
      const running = runWorkflow({
        runId: "worktree-cancel",
        attemptId: "attempt-0",
        attemptSeq: 0,
        root,
        canonicalCwd: repoRoot,
        config: config(repoRoot),
        provider,
        providerPin: pin(repoRoot, root),
        registry,
        store,
        runDir,
        signal: controller.signal,
        eventSink: (event) => {
          if (event.type === "worktree.created") controller.abort();
        },
        lockOwner,
      });

      await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
      expect(provider.calls).toHaveLength(0);
      const retained = store.events.find(
        (event) => event.type === "worktree.retained",
      );
      retainedPath = (retained?.data as { path?: string }).path;
      expect(retainedPath).toBeTruthy();
      await expect(access(retainedPath as string)).resolves.toBeUndefined();
      expect(
        store.records.some(
          (record) => record.kind === "call" && record.state === "started",
        ),
      ).toBe(false);
    } finally {
      if (retainedPath)
        await execFile(
          "git",
          ["-C", repoRoot, "worktree", "remove", "--force", retainedPath],
          { encoding: "utf8" },
        ).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test.each(["snapshot", "event"] as const)(
    "removes a clean worktree when its %s persistence fails before provider launch",
    async (failure) => {
      const repoRoot = await realpath(join(fixtures, "../../../.."));
      const root = await resolveRootWorkflow(
        join(fixtures, "worktree-agent.js"),
        repoRoot,
      );
      const home = await mkdtemp(join(tmpdir(), "awsl-worktree-home-"));
      const stateRoot = await mkdtemp(join(tmpdir(), "awsl-worktree-state-"));
      const runDir = join(stateRoot, "run");
      await mkdir(runDir);
      const registry = await createRegistry({
        cwd: repoRoot,
        provider: "claude",
        homeDir: home,
        claudeConfigDir: join(home, "missing"),
      });
      const provider = new RecordingProvider(() => {
        throw new Error("provider must not launch");
      });
      const store = new RecordingStore();
      if (failure === "snapshot")
        store.failSnapshotWhen = (snapshot) =>
          Array.isArray(snapshot.worktrees) && snapshot.worktrees.length > 0;
      else store.failEventWhen = (event) => event.type === "worktree.created";
      const target = join(runDir, "worktrees", "attempt-0-call-0");
      try {
        await expect(
          runWorkflow({
            runId: `worktree-${failure}-failure`,
            attemptId: "attempt-0",
            attemptSeq: 0,
            root,
            canonicalCwd: repoRoot,
            config: config(repoRoot),
            provider,
            providerPin: pin(repoRoot, root),
            registry,
            store,
            runDir,
            lockOwner,
          }),
        ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });

        expect(provider.calls).toHaveLength(0);
        await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
        const listed = await execFile(
          "git",
          ["-C", repoRoot, "worktree", "list", "--porcelain"],
          { encoding: "utf8" },
        );
        expect(listed.stdout).not.toContain(target);
      } finally {
        await execFile(
          "git",
          ["-C", repoRoot, "worktree", "remove", "--force", target],
          { encoding: "utf8" },
        ).catch(() => undefined);
        await rm(home, { recursive: true, force: true });
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  );

  test("preserves the stored Git base if resume attempt journaling fails", async () => {
    const store = new RecordingStore();
    store.failBeginAttempt = true;
    const provider = new RecordingProvider(() => {
      throw new Error("provider must not launch");
    });
    const options = await harness("basic-agent.js", provider, store);
    const rootResult = await execFile(
      "git",
      ["-C", options.canonicalCwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    const repoRoot = await realpath(rootResult.stdout.trim());
    const commitResult = await execFile(
      "git",
      ["-C", repoRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    const storedWorktreeBase = {
      repoRoot,
      baseCommit: commitResult.stdout.trim(),
    };

    await expect(
      runWorkflow({
        ...options,
        runId: "resume-base-journal-failure",
        attemptId: "attempt-1",
        attemptSeq: 1,
        args: { prompt: "hello" },
        lockOwner,
        resume: {
          storedPin: options.providerPin,
          storedWorktreeBase,
          storedWorktrees: [],
        },
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });

    expect(provider.calls).toHaveLength(0);
    expect(store.snapshots.length).toBeGreaterThan(0);
    expect(store.snapshots.map(({ worktreeBase }) => worktreeBase)).toEqual(
      store.snapshots.map(() => storedWorktreeBase),
    );
  });

  test("preserves the stored Git base when its resume revalidation fails", async () => {
    const store = new RecordingStore();
    const provider = new RecordingProvider(() => {
      throw new Error("provider must not launch");
    });
    const options = await harness("worktree-agent.js", provider, store);
    const rootResult = await execFile(
      "git",
      ["-C", options.canonicalCwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    const storedWorktreeBase = {
      repoRoot: await realpath(rootResult.stdout.trim()),
      baseCommit: "f".repeat(40),
    };
    store.records.push({
      version: 1,
      kind: "attempt",
      runId: "resume-base-revalidation-failure",
      attemptId: "attempt-0",
      attemptSeq: 0,
      recordSeq: 0,
      sourceSha256: options.root.sha256.slice("sha256:".length),
      sourcePath: options.root.realpath,
      recordedAt: new Date(0).toISOString(),
    });

    await expect(
      runWorkflow({
        ...options,
        runId: "resume-base-revalidation-failure",
        attemptId: "attempt-1",
        attemptSeq: 1,
        lockOwner,
        resume: {
          storedPin: options.providerPin,
          storedWorktreeBase,
          storedWorktrees: [],
        },
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_ERROR" });

    expect(provider.calls).toHaveLength(0);
    expect(store.snapshots.length).toBeGreaterThan(1);
    expect(store.snapshots.map(({ worktreeBase }) => worktreeBase)).toEqual(
      store.snapshots.map(() => storedWorktreeBase),
    );
    expect(store.results.at(-1)?.worktreeBase).toEqual(storedWorktreeBase);
  });

  test("requires and reuses the original Git base across resumed worktree calls", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "awsl-resume-worktree-"));
    const repo = join(sandbox, "repo");
    const stateRoot = join(sandbox, "state");
    const home = join(sandbox, "home");
    await mkdir(repo, { recursive: true });
    await mkdir(home);
    await mkdir(stateRoot, { mode: 0o700 });
    try {
      await execFile("git", ["-C", repo, "init"], { encoding: "utf8" });
      await execFile(
        "git",
        ["-C", repo, "config", "user.email", "awsl@example.invalid"],
        { encoding: "utf8" },
      );
      await execFile("git", ["-C", repo, "config", "user.name", "AWSl Test"], {
        encoding: "utf8",
      });
      await writeFile(
        join(repo, "workflow.js"),
        `export const meta = {
  name: "resume-worktree",
  description: "Resume one isolated agent",
}

return await agent(args.prompt, { isolation: "worktree" })
`,
      );
      await writeFile(join(repo, "README.md"), "base\n");
      await execFile("git", ["-C", repo, "add", "."], { encoding: "utf8" });
      await execFile("git", ["-C", repo, "commit", "-m", "base"], {
        encoding: "utf8",
      });
      const canonicalCwd = await realpath(repo);
      const root = await resolveRootWorkflow(
        join(canonicalCwd, "workflow.js"),
        canonicalCwd,
      );
      const registry = await createRegistry({
        cwd: canonicalCwd,
        provider: "claude",
        homeDir: home,
        claudeConfigDir: join(home, "missing"),
      });
      const observedHeads: string[] = [];
      const provider = new RecordingProvider(async (request) => {
        const head = await execFile(
          "git",
          ["-C", request.cwd, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        );
        observedHeads.push(head.stdout.trim());
        return {
          kind: "completed",
          result: { text: request.prompt },
          usage: { outputTokens: 1, complete: true },
        };
      });
      const firstStore = await FileRunStore.open({
        root: stateRoot,
        runId: "resume-worktree",
      });
      const first = await runWorkflow({
        runId: "resume-worktree",
        attemptId: "attempt-0",
        attemptSeq: 0,
        root,
        args: { prompt: "first" },
        canonicalCwd,
        config: config(canonicalCwd),
        provider,
        providerPin: pin(canonicalCwd, root),
        registry,
        store: firstStore,
        runDir: firstStore.paths.runDir,
        lockOwner: { ...lockOwner, nonce: "resume-worktree-0" },
      });
      const firstBase = first.worktreeBase;
      expect(firstBase).not.toBeNull();
      if (firstBase === null) throw new Error("missing first Git base");

      await writeFile(join(repo, "README.md"), "advanced\n");
      await execFile("git", ["-C", repo, "add", "README.md"], {
        encoding: "utf8",
      });
      await execFile("git", ["-C", repo, "commit", "-m", "advance"], {
        encoding: "utf8",
      });
      const advanced = await execFile(
        "git",
        ["-C", repo, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      );
      expect(advanced.stdout.trim()).not.toBe(firstBase.baseCommit);

      const secondStore = await FileRunStore.open({
        root: stateRoot,
        runId: "resume-worktree",
      });
      await expect(
        runWorkflow({
          runId: "resume-worktree",
          attemptId: "attempt-1",
          attemptSeq: 1,
          root,
          args: { prompt: "second" },
          canonicalCwd,
          config: config(canonicalCwd),
          provider,
          providerPin: pin(canonicalCwd, root),
          registry,
          store: secondStore,
          runDir: secondStore.paths.runDir,
          lockOwner: { ...lockOwner, nonce: "resume-worktree-missing-base" },
          resume: {
            storedPin: first.providerPin,
            storedWorktrees: [],
          } as unknown as ResumeWorkflowOptions,
        }),
      ).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
      expect(provider.calls).toHaveLength(1);

      const resumed = await runWorkflow({
        runId: "resume-worktree",
        attemptId: "attempt-1",
        attemptSeq: 1,
        root,
        args: { prompt: "second" },
        canonicalCwd,
        config: config(canonicalCwd),
        provider,
        providerPin: pin(canonicalCwd, root),
        registry,
        store: secondStore,
        runDir: secondStore.paths.runDir,
        lockOwner: { ...lockOwner, nonce: "resume-worktree-1" },
        resume: {
          storedPin: first.providerPin,
          storedWorktreeBase: firstBase,
          storedWorktrees: [],
        } as unknown as ResumeWorkflowOptions,
      });

      expect(resumed.result).toBe("second");
      expect(resumed.worktreeBase).toEqual(firstBase);
      expect(observedHeads).toEqual([
        firstBase.baseCommit,
        firstBase.baseCommit,
      ]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("keeps a retained worktree while a later attempt uses a distinct path", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "awsl-retained-resume-"));
    const repo = join(sandbox, "repo");
    const stateRoot = join(sandbox, "state");
    const home = join(sandbox, "home");
    let retainedPath: string | undefined;
    await mkdir(repo, { recursive: true });
    await mkdir(home);
    await mkdir(stateRoot, { mode: 0o700 });
    try {
      await execFile("git", ["-C", repo, "init"], { encoding: "utf8" });
      await execFile(
        "git",
        ["-C", repo, "config", "user.email", "awsl@example.invalid"],
        { encoding: "utf8" },
      );
      await execFile("git", ["-C", repo, "config", "user.name", "AWSl Test"], {
        encoding: "utf8",
      });
      await writeFile(
        join(repo, "workflow.js"),
        `export const meta = {
  name: "retained-resume",
  description: "Resume after retaining an isolated agent",
}

return await agent(args.prompt, { isolation: "worktree" })
`,
      );
      await execFile("git", ["-C", repo, "add", "."], { encoding: "utf8" });
      await execFile("git", ["-C", repo, "commit", "-m", "base"], {
        encoding: "utf8",
      });
      const canonicalCwd = await realpath(repo);
      const root = await resolveRootWorkflow(
        join(canonicalCwd, "workflow.js"),
        canonicalCwd,
      );
      const registry = await createRegistry({
        cwd: canonicalCwd,
        provider: "claude",
        homeDir: home,
        claudeConfigDir: join(home, "missing"),
      });
      const provider = new RecordingProvider((request, index) =>
        index === 0
          ? {
              kind: "error",
              error: new AwslError("PROVIDER_ERROR", "first attempt failed", {
                provider: "codex",
                recoverable: false,
              }),
              usage: { outputTokens: 1, complete: true },
            }
          : {
              kind: "completed",
              result: { text: request.prompt },
              usage: { outputTokens: 1, complete: true },
            },
      );
      const providerPin = pin(canonicalCwd, root);
      const firstStore = await FileRunStore.open({
        root: stateRoot,
        runId: "retained-resume",
      });

      await expect(
        runWorkflow({
          runId: "retained-resume",
          attemptId: "attempt-0",
          attemptSeq: 0,
          root,
          args: { prompt: "first" },
          canonicalCwd,
          config: config(canonicalCwd),
          provider,
          providerPin,
          registry,
          store: firstStore,
          runDir: firstStore.paths.runDir,
          lockOwner: { ...lockOwner, nonce: "retained-resume-0" },
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

      const failed = await firstStore.readRun();
      const firstWorktrees = failed.worktrees as Array<{
        callId: string;
        path: string;
      }>;
      expect(firstWorktrees).toHaveLength(1);
      retainedPath = firstWorktrees[0]?.path;
      expect(retainedPath).toBeTruthy();
      expect(basename(retainedPath as string)).toBe("attempt-0-call-0");
      await expect(access(retainedPath as string)).resolves.toBeUndefined();

      const secondStore = await FileRunStore.open({
        root: stateRoot,
        runId: "retained-resume",
      });
      const resumed = await runWorkflow({
        runId: "retained-resume",
        attemptId: "attempt-1",
        attemptSeq: 1,
        root,
        args: { prompt: "second" },
        canonicalCwd,
        config: config(canonicalCwd),
        provider,
        providerPin,
        registry,
        store: secondStore,
        runDir: secondStore.paths.runDir,
        lockOwner: { ...lockOwner, nonce: "retained-resume-1" },
        resume: {
          storedPin: failed.providerPin,
          storedWorktreeBase: failed.worktreeBase,
          storedWorktrees: failed.worktrees,
        },
      });

      expect(resumed.result).toBe("second");
      expect(provider.calls).toHaveLength(2);
      await expect(
        execFile("git", ["-C", retainedPath as string, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      const completed = await secondStore.readRun();
      const worktrees = completed.worktrees as Array<{
        callId: string;
        path: string;
      }>;
      expect(worktrees).toHaveLength(2);
      expect(worktrees.map(({ callId }) => callId)).toEqual([
        "call-0",
        "call-0",
      ]);
      expect(new Set(worktrees.map(({ path }) => path)).size).toBe(2);
      expect(basename(worktrees[1]?.path ?? "")).toBe("attempt-1-call-0");
      await expect(access(retainedPath as string)).resolves.toBeUndefined();
      await expect(access(worktrees[1]?.path ?? "")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (retainedPath)
        await execFile(
          "git",
          ["-C", repo, "worktree", "remove", "--force", retainedPath],
          { encoding: "utf8" },
        ).catch(() => undefined);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("rejects a resume pin mismatch before locking, replay, or provider use", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("must not launch");
    });
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const storedPin = pin(options.canonicalCwd, options.root, {
      modelMapFingerprint: `sha256:${"d".repeat(64)}`,
    });

    await expect(
      runWorkflow({
        ...options,
        runId: "resume-mismatch",
        attemptId: "attempt-1",
        attemptSeq: 1,
        args: { prompt: "hello" },
        lockOwner,
        resume: { storedPin, storedWorktreeBase: null, storedWorktrees: [] },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(store.lockCalls).toBe(0);
    expect(store.loadCalls).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  test("gates an exhausted budget before replaying a matching prefix", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("must not launch");
    });
    const canonicalCwd = await realpath(fixtures);
    const root = await resolveRootWorkflow(
      join(fixtures, "basic-agent.js"),
      canonicalCwd,
    );
    const previousKey = "";
    const key = journalKeyV2({ previousKey, prompt: "hello" });
    const prior: JournalRecordV1[] = [
      {
        version: 1,
        kind: "attempt",
        runId: "resume-budget",
        attemptId: "attempt-0",
        attemptSeq: 0,
        recordSeq: 0,
        sourceSha256: root.sha256.slice("sha256:".length),
        sourcePath: root.realpath,
        recordedAt: new Date(0).toISOString(),
      },
      {
        version: 1,
        kind: "call",
        runId: "resume-budget",
        attemptId: "attempt-0",
        attemptSeq: 0,
        recordSeq: 1,
        callSeq: 0,
        callId: "call-0",
        key,
        previousKey,
        state: "scheduled",
        recordedAt: new Date(0).toISOString(),
      },
      {
        version: 1,
        kind: "call",
        runId: "resume-budget",
        attemptId: "attempt-0",
        attemptSeq: 0,
        recordSeq: 2,
        callSeq: 0,
        callId: "call-0",
        key,
        previousKey,
        state: "started",
        recordedAt: new Date(0).toISOString(),
      },
      {
        version: 1,
        kind: "call",
        runId: "resume-budget",
        attemptId: "attempt-0",
        attemptSeq: 0,
        recordSeq: 3,
        callSeq: 0,
        callId: "call-0",
        key,
        previousKey,
        state: "completed",
        completed: {
          outcome: "result",
          origin: "live",
          result: { text: "cached" },
          value: "cached",
          usage: { outputTokens: 1, complete: true },
        },
        recordedAt: new Date(0).toISOString(),
      },
    ];
    const store = new RecordingStore(prior);
    const home = await mkdtemp(join(tmpdir(), "awsl-engine-home-"));
    const registry: AgentRegistry = await createRegistry({
      cwd: canonicalCwd,
      provider: "claude",
      homeDir: home,
      claudeConfigDir: join(home, "missing"),
    });
    const providerPin = pin(canonicalCwd, root);

    await expect(
      runWorkflow({
        runId: "resume-budget",
        attemptId: "attempt-1",
        attemptSeq: 1,
        root,
        args: { prompt: "hello" },
        canonicalCwd,
        config: config(canonicalCwd),
        provider,
        providerPin,
        registry,
        store,
        budget: 0,
        lockOwner,
        resume: {
          storedPin: providerPin,
          storedWorktreeBase: null,
          storedWorktrees: [],
        },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(provider.calls).toHaveLength(0);
    expect(store.events.some((event) => event.type === "call.reused")).toBe(
      false,
    );
    expect(
      store.records.filter(
        (record) =>
          record.kind === "call" &&
          record.attemptSeq === 1 &&
          record.state === "scheduled",
      ),
    ).toHaveLength(0);
  });

  test("enforces the shared 1000-call cap before replaying a cached child call", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("must not launch");
    });
    const canonicalCwd = await realpath(fixtures);
    const root = await resolveRootWorkflow(
      join(fixtures, "agent-cap-parent.js"),
      canonicalCwd,
    );
    const prior: JournalRecordV1[] = [
      {
        version: 1,
        kind: "attempt",
        runId: "resume-cap",
        attemptId: "attempt-0",
        attemptSeq: 0,
        recordSeq: 0,
        sourceSha256: root.sha256.slice("sha256:".length),
        sourcePath: root.realpath,
        recordedAt: new Date(0).toISOString(),
      },
    ];
    let previousKey = "";
    for (
      let callSeq = 0;
      callSeq <= COMPATIBILITY_PROFILE.agentCap;
      callSeq += 1
    ) {
      const key = journalKeyV2({
        previousKey,
        prompt: "cached",
      });
      const identity = {
        version: 1 as const,
        kind: "call" as const,
        runId: "resume-cap",
        attemptId: "attempt-0",
        attemptSeq: 0,
        callSeq,
        callId: `call-${callSeq}`,
        key,
        previousKey,
        recordedAt: new Date(0).toISOString(),
      };
      prior.push(
        {
          ...identity,
          recordSeq: prior.length,
          state: "scheduled",
        },
        {
          ...identity,
          recordSeq: prior.length + 1,
          state: "started",
        },
        {
          ...identity,
          recordSeq: prior.length + 2,
          state: "completed",
          completed: {
            outcome: "result",
            origin: "live",
            result: { text: "cached" },
            value: "cached",
            usage: { outputTokens: 1, complete: true },
          },
        },
      );
      previousKey = key;
    }
    const store = new RecordingStore(prior);
    const home = await mkdtemp(join(tmpdir(), "awsl-engine-home-"));
    const registry = await createRegistry({
      cwd: canonicalCwd,
      provider: "claude",
      homeDir: home,
      claudeConfigDir: join(home, "missing"),
    });
    const providerPin = pin(canonicalCwd, root);

    await expect(
      runWorkflow({
        runId: "resume-cap",
        attemptId: "attempt-1",
        attemptSeq: 1,
        root,
        args: { childPath: join(fixtures, "agent-cap-child.js") },
        canonicalCwd,
        config: config(canonicalCwd),
        provider,
        providerPin,
        registry,
        store,
        lockOwner,
        resume: {
          storedPin: providerPin,
          storedWorktreeBase: null,
          storedWorktrees: [],
        },
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ERROR",
      message: `run exceeds the ${COMPATIBILITY_PROFILE.agentCap} agent call limit`,
    });
    expect(provider.calls).toHaveLength(0);
    expect(
      store.events.filter((event) => event.type === "call.reused"),
    ).toHaveLength(COMPATIBILITY_PROFILE.agentCap);
    expect(
      store.records.filter(
        (record) =>
          record.kind === "call" &&
          record.attemptSeq === 1 &&
          record.state === "scheduled",
      ),
    ).toHaveLength(COMPATIBILITY_PROFILE.agentCap);
  }, 20_000);

  test("upgrades a V1 pin to V2 before a live resumed call", async () => {
    const provider = new RecordingProvider((request) => ({
      kind: "completed",
      result: { text: request.model ?? "missing" },
      usage: { outputTokens: 1, complete: true },
    }));
    const store = new RecordingStore();
    const options = await harness("basic-agent.js", provider, store);
    const storedPin = legacyPin(options.canonicalCwd, options.root, {
      resolvedDefaultModel: "gpt-5.6-sol",
    });
    const currentPin = parseProviderPinV2({
      ...options.providerPin,
      version: 2,
      configuredNativeModels: [],
    });
    store.records.push({
      version: 1,
      kind: "attempt",
      runId: "resume-hydrate",
      attemptId: "attempt-0",
      attemptSeq: 0,
      recordSeq: 0,
      sourceSha256: options.root.sha256.slice("sha256:".length),
      sourcePath: options.root.realpath,
      recordedAt: new Date(0).toISOString(),
    });

    const run = await runWorkflow({
      ...options,
      providerPin: currentPin,
      runId: "resume-hydrate",
      attemptId: "attempt-1",
      attemptSeq: 1,
      args: { prompt: "hello" },
      lockOwner,
      resume: { storedPin, storedWorktreeBase: null, storedWorktrees: [] },
    });

    expect(provider.calls[0]?.model).toBe("gpt-5.6-sol");
    expect(run.result).toMatchObject({ answer: "gpt-5.6-sol" });
    expect(run.providerPin).toMatchObject({
      version: 2,
      resolvedDefaultModel: "gpt-5.6-sol",
      configuredNativeModels: [],
    });
    expect(
      store.snapshots.every(
        (snapshot) =>
          (snapshot.providerPin as { version?: unknown }).version === 2,
      ),
    ).toBe(true);
    expect(store.results.at(-1)?.providerPin).toEqual(run.providerPin);
    expect(store.order.indexOf("journal.load")).toBeGreaterThan(
      store.order.indexOf("lock.acquire"),
    );
  });

  test("rejects a grandchild before launching an agent", async () => {
    const provider = new RecordingProvider(() => {
      throw new Error("must not launch");
    });
    const options = await harness("parent-calls-nested.js", provider);

    await expect(
      runWorkflow({
        ...options,
        runId: "nested-depth",
        attemptId: "attempt-0",
        attemptSeq: 0,
        args: {
          childPath: join(fixtures, "child-calls-grandchild.js"),
          grandchildPath: join(fixtures, "grandchild.js"),
        },
        lockOwner,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_ERROR" });
    expect(provider.calls).toHaveLength(0);
  });
});
