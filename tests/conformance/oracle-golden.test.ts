import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { createRegistry } from "../../src/compat/agent-registry.js";
import {
  type ProviderPinV2,
  parseProviderPinV2,
} from "../../src/config/provider-pin.js";
import type { ResolvedAwslConfig } from "../../src/config/types.js";
import {
  type ResolvedWorkflowSource,
  resolveRootWorkflow,
} from "../../src/config/workflow-resolver.js";
import type { AwslEvent } from "../../src/core/events.js";
import type {
  ProviderAdapter,
  ProviderOutcome,
  ProviderRequest,
} from "../../src/core/types.js";
import { parseUniqueJson } from "../../src/core/unique-json.js";
import { CLAUDE_CAPABILITIES } from "../../src/providers/claude.js";
import {
  type RunWorkflowResult,
  runWorkflow,
} from "../../src/runtime/engine.js";
import { FileRunStore } from "../../src/store/run-store.js";
import type { LockOwner } from "../../src/store/types.js";

const run = promisify(nodeExecFile);
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const goldenPath = join(
  repositoryRoot,
  "tests",
  "oracle",
  "claude-code-2.1.218",
  "workflow-runtime.json",
);
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "oracle");
const captureScript = join(
  repositoryRoot,
  "scripts",
  "capture-claude-oracle.mjs",
);
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;
const REVIEWED_GOLDEN_SHA256 =
  "sha256:757323ff84b0ac5794a5162da2e9a5f2a4f7378eff70f6c19a1f5b18015b03c3";
const APPROVED_CLAUDE_BINARY_SHA256 =
  "sha256:71abaff59312c9a9b6a1d818365048b42e4e95cc521a823660eded3e0880d9b7";

interface GoldenCall {
  logicalId: string;
  promptSha256: string;
  options: {
    label: string;
    phase: string;
    agentType: string;
  };
  outcome: {
    kind: "completed";
    structured: false;
    value: string;
  };
  outputTokens: number;
}

interface OracleGolden {
  schemaVersion: number;
  profile: string;
  evidence: {
    classification: "synthetic-regression" | "local-live-capture";
    liveFixtureCapture: string;
    binary: {
      sha256: string;
      version: string;
      platform: string;
      architecture: string;
      verification: string;
    };
    capture: {
      tool: string;
      initialInputKeys: string[];
      resumedInputKeys: string[];
      artifactKeys: string[];
    } | null;
    limitations: string[];
  };
  fixture: {
    name: string;
    initial: { path: string; sha256: string };
    resumed: { path: string; sha256: string };
    agent: { path: string; sha256: string };
    args: { oracle: string };
  };
  replay: {
    usageSource: string;
    calls: GoldenCall[];
  };
  observation: {
    initial: Record<string, unknown>;
    resumed: Record<string, unknown>;
  };
}

const REVIEWED_REPLAY_CALLS: readonly GoldenCall[] = [
  {
    logicalId: "alpha",
    promptSha256:
      "sha256:36027362574f8bfe2ed1c699e43c2914edc598b25861b4415e501035e7ef1e96",
    options: {
      label: "alpha",
      phase: "setup",
      agentType: "oracle-no-tools",
    },
    outcome: {
      kind: "completed",
      structured: false,
      value: "AWSL_ORACLE_ALPHA",
    },
    outputTokens: 3,
  },
  {
    logicalId: "beta",
    promptSha256:
      "sha256:7636c8f3f62b744aa978a3c39d25a720f4cb8c8df9dd2390c8b6af8eca4167ec",
    options: {
      label: "beta",
      phase: "setup",
      agentType: "oracle-no-tools",
    },
    outcome: {
      kind: "completed",
      structured: false,
      value: "AWSL_ORACLE_BETA",
    },
    outputTokens: 3,
  },
  {
    logicalId: "beta-v2",
    promptSha256:
      "sha256:6e9beb53c1790ccdb48b486cf965bff8ecfe5d3c075ff6c085b3cd450d4328f2",
    options: {
      label: "beta-v2",
      phase: "setup",
      agentType: "oracle-no-tools",
    },
    outcome: {
      kind: "completed",
      structured: false,
      value: "AWSL_ORACLE_BETA_V2",
    },
    outputTokens: 3,
  },
  {
    logicalId: "gamma",
    promptSha256:
      "sha256:0a4ec501a7bcdfaf4925b72c72cbcc913742e4c599591fa81a3ceda6d0214026",
    options: {
      label: "gamma",
      phase: "setup",
      agentType: "oracle-no-tools",
    },
    outcome: {
      kind: "completed",
      structured: false,
      value: "AWSL_ORACLE_GAMMA",
    },
    outputTokens: 3,
  },
];

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

class OracleRecordingProvider implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly identity = {
    id: "claude" as const,
    executableRealpath: "/opt/awsl/claude",
    version: "2.1.218",
  };
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly logicalCalls: string[] = [];

  constructor(private readonly calls: readonly GoldenCall[]) {}

  async run(request: ProviderRequest): Promise<ProviderOutcome> {
    const promptSha256 = sha256(request.prompt);
    const call = this.calls.find(
      (candidate) => candidate.promptSha256 === promptSha256,
    );
    if (!call) throw new Error("oracle recording received an unknown prompt");
    this.logicalCalls.push(call.logicalId);
    expect(request.agent).toMatchObject({
      name: "oracle-no-tools",
      tools: [],
      mcp: {},
      permissionMode: "dontAsk",
    });
    expect(request.schema).toBeUndefined();
    return {
      kind: "completed",
      result: { text: call.outcome.value },
      usage: {
        inputTokens: 1,
        outputTokens: call.outputTokens,
        complete: true,
      },
    };
  }
}

function config(stateDir: string): ResolvedAwslConfig {
  const codexTiers = {
    fast: { model: "gpt-5.6-terra", effort: "low" as const },
    balanced: { model: "gpt-5.6-terra", effort: "medium" as const },
    strong: { model: "gpt-5.6-sol", effort: "high" as const },
  };
  return {
    provider: "claude",
    stateDir,
    rawProviderEvents: false,
    providers: {
      codex: {
        id: "codex",
        executable: "codex",
        args: [],
        nativeModels: [],
        tiers: codexTiers,
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

function pin(cwd: string, root: ResolvedWorkflowSource): ProviderPinV2 {
  return parseProviderPinV2({
    version: 2,
    provider: "claude",
    compatibilityProfile: "claude-code@2.1.218",
    executableRealpath: "/opt/awsl/claude",
    executableVersion: "2.1.218",
    explicitDefaultModel: null,
    resolvedDefaultModel: null,
    providerProfile: null,
    canonicalCwd: cwd,
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
  });
}

function normalizeLogs(events: readonly AwslEvent[]): string[] {
  return events
    .filter((event) => event.type === "workflow.log")
    .map((event) => (event.data as { message?: string }).message ?? "")
    .map((message) =>
      message.includes("AWSL_ORACLE_EXPECTED_BRANCH_FAILURE")
        ? "AWSL_ORACLE_EXPECTED_BRANCH_FAILURE"
        : message,
    );
}

function normalizeCalls(events: readonly AwslEvent[]) {
  const scheduled = events.filter((event) => event.type === "call.scheduled");
  const terminal = new Map(
    events
      .filter(
        (event) =>
          event.type === "call.completed" || event.type === "call.reused",
      )
      .map((event) => [(event.data as { callSeq: number }).callSeq, event]),
  );
  return scheduled.map((event, index) => {
    const data = event.data as {
      callSeq: number;
      label: string;
      phase: string;
    };
    const completed = terminal.get(data.callSeq);
    expect(completed).toBeDefined();
    return {
      logicalId: data.label,
      index,
      phase: data.phase,
      agentType: "oracle-no-tools",
      origin: completed?.type === "call.reused" ? "reused" : "live",
      outcome:
        completed?.type === "call.reused"
          ? "result"
          : (completed?.data as { outcome?: string }).outcome,
    };
  });
}

function normalizeObservation(
  result: RunWorkflowResult,
  root: ResolvedWorkflowSource,
) {
  const phases = result.events
    .filter((event) => event.type === "phase.changed")
    .map((event) => (event.data as { phase: string }).phase);
  const business = result.result as {
    parallel: unknown;
    pipeline: unknown;
    budget: unknown;
  };
  return JSON.parse(
    JSON.stringify({
      status: result.status,
      workflowName: root.meta.name,
      result: result.result,
      phases,
      logs: normalizeLogs(result.events),
      calls: normalizeCalls(result.events),
      parallel: business.parallel,
      pipeline: business.pipeline,
      budget: business.budget,
      toolUse: "none",
    }),
  ) as Record<string, unknown>;
}

async function loadGolden(): Promise<{
  golden: OracleGolden;
  source: string;
}> {
  const source = await readFile(goldenPath, "utf8");
  expect(Buffer.byteLength(source, "utf8")).toBeLessThan(256 * 1024);
  expect(sha256(source)).toBe(REVIEWED_GOLDEN_SHA256);
  expect(source).not.toMatch(
    /(?:^|["\s])\/(?:Users|home|private|tmp)\/|\b(?:wf|toolu|agent|task)_[a-z0-9-]{6,}\b|BEGIN [A-Z ]*PRIVATE KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\s*=/u,
  );
  const parsed = parseUniqueJson(source);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  return { golden: parsed as OracleGolden, source };
}

test("replays the reviewed 2.1.218-informed synthetic profile", async () => {
  const { golden } = await loadGolden();
  exactKeys(golden as unknown as Record<string, unknown>, [
    "schemaVersion",
    "profile",
    "evidence",
    "fixture",
    "replay",
    "observation",
  ]);
  expect(golden).toMatchObject({
    schemaVersion: 1,
    profile: "claude-code@2.1.218",
    evidence: {
      classification: "synthetic-regression",
      liveFixtureCapture: "not-captured",
      binary: {
        sha256: APPROVED_CLAUDE_BINARY_SHA256,
        version: "2.1.218",
        platform: "darwin",
        architecture: "arm64",
        verification: "reviewed-local-static-inspection",
      },
      capture: null,
      limitations: expect.arrayContaining([
        "not a live Claude fixture capture",
        "binary digest does not attest this synthetic observation",
      ]),
    },
    replay: { usageSource: "synthetic" },
  });
  expect(golden.replay.calls).toStrictEqual(REVIEWED_REPLAY_CALLS);

  for (const descriptor of [
    golden.fixture.initial,
    golden.fixture.resumed,
    golden.fixture.agent,
  ]) {
    exactKeys(descriptor as unknown as Record<string, unknown>, [
      "path",
      "sha256",
    ]);
    const path = join(repositoryRoot, descriptor.path);
    expect(await realpath(path)).toBe(path);
    expect(sha256(await readFile(path))).toBe(descriptor.sha256);
  }
  for (const call of golden.replay.calls) {
    exactKeys(call as unknown as Record<string, unknown>, [
      "logicalId",
      "promptSha256",
      "options",
      "outcome",
      "outputTokens",
    ]);
    expect(call.promptSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(call.outputTokens).toBe(3);
  }

  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-oracle-replay-")),
  );
  const project = join(sandbox, "project");
  const stateRoot = join(sandbox, "state");
  const home = join(sandbox, "home");
  const workflowPath = join(project, "workflow.js");
  await mkdir(join(project, ".git"), { recursive: true, mode: 0o700 });
  await mkdir(join(project, ".claude", "agents"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await copyFile(
    join(repositoryRoot, golden.fixture.agent.path),
    join(project, ".claude", "agents", "oracle-no-tools.md"),
  );
  const provider = new OracleRecordingProvider(REVIEWED_REPLAY_CALLS);
  const canonicalCwd = await realpath(project);
  const registry = await createRegistry({
    cwd: canonicalCwd,
    provider: "claude",
    homeDir: home,
    claudeConfigDir: join(home, "missing"),
  });
  const lockOwner: LockOwner = {
    nonce: "oracle-attempt-0",
    pid: process.pid,
    processStartIdentity: "oracle-test-process",
  };

  try {
    await writeFile(
      workflowPath,
      await readFile(join(repositoryRoot, golden.fixture.initial.path)),
    );
    const initialRoot = await resolveRootWorkflow(workflowPath, canonicalCwd);
    const initialStore = await FileRunStore.create({
      root: stateRoot,
      runId: "oracle-replay",
    });
    const initial = await runWorkflow({
      runId: "oracle-replay",
      attemptId: "attempt-0",
      attemptSeq: 0,
      root: initialRoot,
      args: golden.fixture.args,
      canonicalCwd,
      provider,
      config: config(stateRoot),
      providerPin: pin(canonicalCwd, initialRoot),
      registry,
      store: initialStore,
      runDir: initialStore.paths.runDir,
      lockOwner,
    });
    expect(normalizeObservation(initial, initialRoot)).toStrictEqual(
      golden.observation.initial,
    );
    expect(initial.metrics).toMatchObject({
      agentCount: 2,
      outputTokens: 6,
      attemptOutputTokens: 6,
      usageComplete: true,
    });

    await writeFile(
      workflowPath,
      await readFile(join(repositoryRoot, golden.fixture.resumed.path)),
    );
    const resumedRoot = await resolveRootWorkflow(workflowPath, canonicalCwd);
    const resumedStore = await FileRunStore.open({
      root: stateRoot,
      runId: "oracle-replay",
    });
    const resumed = await runWorkflow({
      runId: "oracle-replay",
      attemptId: "attempt-1",
      attemptSeq: 1,
      root: resumedRoot,
      args: golden.fixture.args,
      canonicalCwd,
      provider,
      config: config(stateRoot),
      providerPin: pin(canonicalCwd, resumedRoot),
      registry,
      store: resumedStore,
      runDir: resumedStore.paths.runDir,
      lockOwner: { ...lockOwner, nonce: "oracle-attempt-1" },
      resume: {
        storedPin: initial.providerPin,
        storedWorktreeBase: initial.worktreeBase,
        storedWorktrees: [],
      },
    });
    expect(normalizeObservation(resumed, resumedRoot)).toStrictEqual(
      golden.observation.resumed,
    );
    expect(resumed.metrics).toMatchObject({
      agentCount: 3,
      outputTokens: 12,
      attemptOutputTokens: 6,
      usageComplete: true,
    });
    expect(provider.logicalCalls).toEqual([
      "alpha",
      "beta",
      "beta-v2",
      "gamma",
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}, 30_000);

test("keeps live Claude oracle capture opt-in and fail-closed", async () => {
  const script = await readFile(captureScript, "utf8");
  expect(script).toContain('AWSL_CAPTURE_CLAUDE_ORACLE !== "1"');
  expect(script).toContain("if (process.env.CI)");
  expect(script).toContain('const VERSION_LINE = "2.1.218 (Claude Code)\\n"');
  expect(script).toContain('"--tools"');
  expect(script).toContain('"Workflow"');
  expect(script).toContain("resumeFromRunId");
  expect(script).toContain("assertSafeGolden");
  expect(script).toContain('"workflow-runtime.json"');
  expect(script).not.toContain('"parallel-pipeline-resume.json"');
  expect(script).toContain(
    APPROVED_CLAUDE_BINARY_SHA256.slice("sha256:".length),
  );
  expect(script).not.toContain("AWSL_CLAUDE_COMMAND");
  expect(script).not.toMatch(
    /execSync|execFileSync|shell:\s*true|\/bin\/sh|bash\s+-c/u,
  );

  const result = await run(process.execPath, [captureScript], {
    cwd: repositoryRoot,
  }).catch((error: unknown) => error as { stderr?: string; stdout?: string });
  expect(result.stdout ?? "").toBe("");
  expect(result.stderr ?? "").toContain(
    "set AWSL_CAPTURE_CLAUDE_ORACLE=1 to run the opt-in capture",
  );
});

test("rejects an unsupported or unapproved Claude command before executing it", async () => {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-oracle-spoof-")),
  );
  const executable = join(sandbox, "claude");
  const marker = join(sandbox, "executed");
  const before = await readFile(goldenPath);
  await writeFile(
    executable,
    `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nprintf '2.1.218 (Claude Code)\\n'\n`,
  );
  await chmod(executable, 0o700);

  try {
    const result = await run(process.execPath, [captureScript, "--force"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AWSL_CAPTURE_CLAUDE_ORACLE: "1",
        CI: "",
        PATH: sandbox,
      },
    }).catch((error: unknown) => error as { stderr?: string; stdout?: string });
    expect(result.stdout ?? "").toBe("");
    expect(result.stderr ?? "").toContain(
      process.platform === "darwin" && process.arch === "arm64"
        ? "Claude executable digest is not approved"
        : "Claude oracle capture is unsupported on this platform",
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(goldenPath)).toEqual(before);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
