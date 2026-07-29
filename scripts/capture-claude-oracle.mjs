#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = "claude-code@2.1.218";
const VERSION_LINE = "2.1.218 (Claude Code)\n";
const APPROVED_BINARY_SHA256 =
  "sha256:71abaff59312c9a9b6a1d818365048b42e4e95cc521a823660eded3e0880d9b7";
const MAX_VERSION_BYTES = 4096;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(root, "tests", "fixtures", "oracle");
const initialFixture = join(fixtureRoot, "parallel-pipeline-resume.initial.js");
const resumedFixture = join(fixtureRoot, "parallel-pipeline-resume.resumed.js");
const agentFixture = join(fixtureRoot, "oracle-no-tools.md");
const goldenPath = join(
  root,
  "tests",
  "oracle",
  "claude-code-2.1.218",
  "workflow-runtime.json",
);
const artifactKeys = [
  "agentCount",
  "args",
  "defaultModel",
  "durationMs",
  "logs",
  "phases",
  "result",
  "runId",
  "script",
  "scriptPath",
  "startTime",
  "status",
  "summary",
  "taskId",
  "timestamp",
  "totalTokens",
  "totalToolCalls",
  "workflowName",
  "workflowProgress",
].sort();
const argsValue = Object.freeze({ oracle: "AWSL_ORACLE_V1" });
const prompts = Object.freeze({
  alpha: "Return exactly AWSL_ORACLE_ALPHA",
  beta: "Return exactly AWSL_ORACLE_BETA",
  "beta-v2": "Return exactly AWSL_ORACLE_BETA_V2",
  gamma: "Return exactly AWSL_ORACLE_GAMMA",
});

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function encode(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executablePath(command) {
  if (!command || command.includes("\0")) fail("invalid Claude executable");
  if (isAbsolute(command) || command.includes("/")) return realpath(command);
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  fail("Claude executable was not found");
}

function runBounded(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const overflow = (stream) => {
      child.kill("SIGKILL");
      finish(new Error(`Claude ${stream} exceeded the capture limit`));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxStdoutBytes ?? MAX_STDOUT_BYTES))
        return overflow("stdout");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > (options.maxStderrBytes ?? MAX_STDERR_BYTES))
        return overflow("stderr");
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) =>
      finish(undefined, {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Claude oracle invocation timed out"));
    }, options.timeoutMs);
  });
}

function decodeUtf8(buffer, label) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (Buffer.byteLength(text, "utf8") !== buffer.length)
    fail(`${label} is not canonical UTF-8`);
  return text;
}

async function verifyVersion(executable) {
  const result = await runBounded(executable, ["--version"], {
    cwd: root,
    env: process.env,
    timeoutMs: 5000,
    maxStdoutBytes: MAX_VERSION_BYTES,
    maxStderrBytes: MAX_VERSION_BYTES,
  });
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    decodeUtf8(result.stdout, "Claude version") !== VERSION_LINE
  )
    fail("Claude executable is not exactly 2.1.218");
}

async function verifyBinary(executable) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("Claude oracle capture is unsupported on this platform");
  const information = await stat(executable);
  if (!information.isFile()) fail("Claude executable is not a regular file");
  const digest = await sha256File(executable);
  if (digest !== APPROVED_BINARY_SHA256)
    fail("Claude executable digest is not approved");
  return digest;
}

function parseStream(buffer) {
  const text = decodeUtf8(buffer, "Claude stream");
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  if (lines.length === 0 || lines.some((line) => !line))
    fail("invalid Claude stream");
  return lines.map((line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      fail("Claude stream line exceeded the capture limit");
    try {
      return JSON.parse(line);
    } catch {
      return fail("Claude stream contained invalid JSON");
    }
  });
}

function collectToolUses(events) {
  const result = [];
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content)
      if (block?.type === "tool_use") result.push(block);
  }
  return result;
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    fail(`${label} has an unexpected shape`);
}

function extractRunId(events) {
  const ids = new Set();
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const encoded = JSON.stringify(block.content);
      for (const match of encoded.matchAll(/\bwf_[a-z0-9-]{6,}\b/g))
        ids.add(match[0]);
    }
  }
  if (ids.size !== 1)
    fail("Workflow tool result did not expose one run identifier");
  return [...ids][0];
}

async function invokeWorkflow({
  executable,
  project,
  mcpConfig,
  sessionId,
  scriptPath,
  resumeFromRunId,
}) {
  const input =
    resumeFromRunId === undefined
      ? { scriptPath, args: argsValue }
      : { scriptPath, args: argsValue, resumeFromRunId };
  const prompt = `Use the Workflow tool exactly once with exactly this JSON input and no other tool: ${JSON.stringify(input)}. After launching it, return exactly AWSL_ORACLE_CAPTURED.`;
  const cliArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "Workflow",
    "--allowedTools",
    "Workflow",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--disable-slash-commands",
    "--no-chrome",
    "--max-budget-usd",
    "5",
    ...(resumeFromRunId === undefined
      ? ["--session-id", sessionId]
      : ["--resume", sessionId]),
    prompt,
  ];
  const result = await runBounded(executable, cliArgs, {
    cwd: project,
    env: process.env,
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr.length > MAX_STDERR_BYTES
  ) {
    let streamShape = "unavailable";
    try {
      streamShape = JSON.stringify(
        parseStream(result.stdout).map((event) => ({
          keys:
            event && typeof event === "object"
              ? Object.keys(event).sort()
              : [typeof event],
          type: event?.type,
          subtype: event?.subtype,
          isError: event?.is_error,
          apiErrorStatus: event?.api_error_status,
          stopReason: event?.stop_reason,
          terminalReason: event?.terminal_reason,
          error:
            typeof event?.error === "string" &&
            /^[A-Za-z0-9_.:-]{1,80}$/u.test(event.error)
              ? event.error
              : typeof event?.error,
          messageKeys:
            event?.message && typeof event.message === "object"
              ? Object.keys(event.message).sort()
              : [],
          contentTypes: Array.isArray(event?.message?.content)
            ? event.message.content.map((block) => ({
                type: block?.type,
                name: block?.name,
              }))
            : [],
        })),
      );
    } catch {
      // Keep diagnostics structural and secret-free.
    }
    fail(
      `Claude oracle invocation failed (exit=${String(result.code)}, signal=${String(result.signal)}, stdoutBytes=${result.stdout.length}, stderrBytes=${result.stderr.length}, stream=${streamShape})`,
    );
  }
  const events = parseStream(result.stdout);
  const toolUses = collectToolUses(events);
  if (toolUses.length !== 1 || toolUses[0]?.name !== "Workflow")
    fail("Claude did not call the actual Workflow tool exactly once");
  assertExactObject(toolUses[0].input, Object.keys(input), "Workflow input");
  if (JSON.stringify(toolUses[0].input) !== JSON.stringify(input))
    fail("Claude changed the requested Workflow input");
  return {
    inputKeys: Object.keys(toolUses[0].input).sort(),
    runId: extractRunId(events),
  };
}

async function locateTranscript(sessionId) {
  const configRoot =
    process.env.CLAUDE_CONFIG_DIR && isAbsolute(process.env.CLAUDE_CONFIG_DIR)
      ? process.env.CLAUDE_CONFIG_DIR
      : join(homedir(), ".claude");
  const projects = join(configRoot, "projects");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let entries = [];
    try {
      entries = await readdir(projects, { withFileTypes: true });
    } catch {
      // The session directory may not have been flushed yet.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
      if (await exists(candidate)) return realpath(candidate);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("Claude session transcript was not created");
}

async function waitForArtifact(path, newerThan = -1) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  let stableSignature = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    try {
      const info = await stat(path);
      if (info.mtimeMs > newerThan && info.size > 0) {
        const source = await readFile(path, "utf8");
        const artifact = JSON.parse(source);
        if (
          ["completed", "failed", "killed", "paused"].includes(artifact?.status)
        ) {
          const signature = `${info.size}:${info.mtimeMs}:${sha256(source)}`;
          stableCount = signature === stableSignature ? stableCount + 1 : 1;
          stableSignature = signature;
          if (stableCount >= 2) return { artifact, mtimeMs: info.mtimeMs };
        }
      }
    } catch {
      // Workflow snapshots are written asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("Claude Workflow artifact did not reach a stable terminal state");
}

function normalizeMarker(value, expected, label) {
  if (typeof value !== "string" || value.trim() !== expected)
    fail(`${label} did not return its closed oracle marker`);
  return expected;
}

function expectedResult(kind) {
  const resumed = kind === "resumed";
  return {
    oracle: "AWSL_ORACLE_V1",
    parallel: resumed
      ? ["AWSL_ORACLE_ALPHA", "AWSL_ORACLE_BETA_V2", "AWSL_ORACLE_GAMMA", null]
      : ["AWSL_ORACLE_ALPHA", "AWSL_ORACLE_BETA", null],
    pipeline: ["AWSL_ORACLE_PIPELINE_OK", null],
    budget: {
      total: "unlimited",
      before: "zero",
      after: "positive",
      remaining: "infinity",
    },
  };
}

function normalizeResult(value, kind) {
  const expected = expectedResult(kind);
  assertExactObject(value, Object.keys(expected), `${kind} result`);
  assertExactObject(
    value.budget,
    Object.keys(expected.budget),
    `${kind} budget`,
  );
  if (!Array.isArray(value.parallel) || !Array.isArray(value.pipeline))
    fail(`${kind} result arrays are invalid`);
  const parallelExpected = expected.parallel;
  if (value.parallel.length !== parallelExpected.length)
    fail(`${kind} parallel result length changed`);
  const parallel = value.parallel.map((entry, index) => {
    const marker = parallelExpected[index];
    if (marker === null) {
      if (entry !== null) fail(`${kind} parallel null behavior changed`);
      return null;
    }
    return normalizeMarker(entry, marker, `${kind} parallel branch`);
  });
  if (
    value.pipeline.length !== 2 ||
    value.pipeline[1] !== null ||
    normalizeMarker(
      value.pipeline[0],
      "AWSL_ORACLE_PIPELINE_OK",
      `${kind} pipeline`,
    ) !== "AWSL_ORACLE_PIPELINE_OK"
  )
    fail(`${kind} pipeline behavior changed`);
  if (JSON.stringify(value.budget) !== JSON.stringify(expected.budget))
    fail(`${kind} budget relationship changed`);
  if (value.oracle !== expected.oracle) fail(`${kind} oracle argument changed`);
  return { ...expected, parallel };
}

function normalizeObservation(artifact, kind) {
  assertExactObject(artifact, artifactKeys, `${kind} artifact`);
  if (
    artifact.status !== "completed" ||
    artifact.workflowName !== "parallel-pipeline-resume" ||
    artifact.totalToolCalls !== 0 ||
    !Number.isFinite(artifact.totalTokens) ||
    artifact.totalTokens <= 0
  )
    fail(`${kind} artifact terminal fields changed`);
  const resumed = kind === "resumed";
  const labels = resumed ? ["alpha", "beta-v2", "gamma"] : ["alpha", "beta"];
  if (artifact.agentCount !== labels.length)
    fail(`${kind} agent count changed`);
  if (!Array.isArray(artifact.workflowProgress))
    fail(`${kind} workflow progress is invalid`);
  const phases = artifact.workflowProgress
    .filter((entry) => entry?.type === "workflow_phase")
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.title);
  if (JSON.stringify(phases) !== JSON.stringify(["setup", "finish"]))
    fail(`${kind} phase order changed`);
  const progress = artifact.workflowProgress
    .filter((entry) => entry?.type === "workflow_agent")
    .sort((left, right) => left.index - right.index);
  if (progress.length !== labels.length) fail(`${kind} call count changed`);
  const calls = progress.map((entry, index) => {
    if (
      entry.index !== index + 1 ||
      entry.label !== labels[index] ||
      entry.phaseTitle !== "setup" ||
      entry.state !== "done" ||
      entry.agentType !== "oracle-no-tools"
    )
      fail(`${kind} call observation changed`);
    const origin = entry.cached === true ? "reused" : "live";
    if ((resumed && index === 0) !== (origin === "reused"))
      fail(`${kind} resume origin changed`);
    return {
      logicalId: labels[index],
      index,
      phase: "setup",
      agentType: "oracle-no-tools",
      origin,
      outcome: "result",
    };
  });
  const logText = JSON.stringify(artifact.logs);
  const logs = [
    "AWSL_ORACLE_SETUP",
    "AWSL_ORACLE_EXPECTED_BRANCH_FAILURE",
    "AWSL_ORACLE_FINISH",
  ];
  if (logs.some((marker) => !logText.includes(marker)))
    fail(`${kind} log markers changed`);
  return {
    status: "completed",
    workflowName: "parallel-pipeline-resume",
    result: normalizeResult(artifact.result, kind),
    phases,
    logs,
    calls,
    parallel: expectedResult(kind).parallel,
    pipeline: expectedResult(kind).pipeline,
    budget: expectedResult(kind).budget,
    toolUse: "none",
  };
}

async function journalCounts(path) {
  const source = await readFile(path, "utf8");
  const records = source
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = records.filter((entry) => entry?.type === "started");
  const results = records.filter((entry) => entry?.type === "result");
  for (const entry of records) {
    const keys =
      entry?.type === "started"
        ? ["agentId", "key", "type"]
        : entry?.type === "result"
          ? ["agentId", "key", "result", "type"]
          : [];
    assertExactObject(entry, keys, "Workflow journal record");
    if (typeof entry.key !== "string" || !/^v2:[a-f0-9]{64}$/.test(entry.key))
      fail("Workflow journal key changed");
  }
  return { started: started.length, results: results.length };
}

async function fixtureDescriptor(path) {
  const source = await readFile(path);
  return {
    path: relative(root, path),
    sha256: sha256(source),
  };
}

function replayCall(logicalId, outputTokens = 3) {
  return {
    logicalId,
    promptSha256: sha256(prompts[logicalId]),
    options: {
      label: logicalId,
      phase: "setup",
      agentType: "oracle-no-tools",
    },
    outcome: {
      kind: "completed",
      structured: false,
      value: `AWSL_ORACLE_${logicalId.replace("-", "_").toUpperCase()}`,
    },
    outputTokens,
  };
}

function assertSafeGolden(source) {
  if (
    /(?:^|["\s])\/(?:Users|home|private|tmp)\//u.test(source) ||
    /\b(?:wf|toolu|agent|task)_[a-z0-9-]{6,}\b/u.test(source) ||
    /BEGIN [A-Z ]*PRIVATE KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\s*=/u.test(
      source,
    )
  )
    fail("sanitized golden contains a path, identifier, or secret marker");
}

async function main() {
  if (process.env.AWSL_CAPTURE_CLAUDE_ORACLE !== "1")
    fail("set AWSL_CAPTURE_CLAUDE_ORACLE=1 to run the opt-in capture");
  if (process.env.CI) fail("oracle capture is disabled in CI");
  const force = process.argv.slice(2).includes("--force");
  if (
    process.argv.slice(2).some((value) => value !== "--force") ||
    (!force && (await exists(goldenPath)))
  )
    fail(
      force
        ? "unknown capture option"
        : "oracle golden already exists; inspect it or pass --force explicitly",
    );

  const executable = await executablePath("claude");
  const binarySha256 = await verifyBinary(executable);
  await verifyVersion(executable);
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-claude-oracle-")),
  );
  await chmod(sandbox, 0o700);
  try {
    const project = join(sandbox, "project");
    const workflowDirectory = join(project, ".claude", "workflows");
    const agentDirectory = join(project, ".claude", "agents");
    const scriptPath = join(workflowDirectory, "parallel-pipeline-resume.js");
    const mcpConfig = join(project, "empty-mcp.json");
    await mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    await copyFile(initialFixture, scriptPath);
    await copyFile(agentFixture, join(agentDirectory, "oracle-no-tools.md"));
    await writeFile(
      join(project, "CLAUDE.md"),
      "# awsl oracle\n\nRun only the exact requested Workflow tool call.\n",
      { mode: 0o600 },
    );
    await writeFile(mcpConfig, '{"mcpServers":{}}\n', { mode: 0o600 });

    const gitInit = await runBounded(
      "/usr/bin/git",
      ["init", "--quiet", project],
      {
        cwd: sandbox,
        env: process.env,
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      },
    );
    if (gitInit.code !== 0) fail("temporary oracle Git initialization failed");

    const sessionId = randomUUID();
    const initialLaunch = await invokeWorkflow({
      executable,
      project,
      mcpConfig,
      sessionId,
      scriptPath,
    });
    const transcript = await locateTranscript(sessionId);
    const sessionDirectory = join(dirname(transcript), sessionId);
    const artifactPath = join(
      sessionDirectory,
      "workflows",
      `${initialLaunch.runId}.json`,
    );
    const initialTerminal = await waitForArtifact(artifactPath);
    const journalPath = join(
      sessionDirectory,
      "subagents",
      "workflows",
      initialLaunch.runId,
      "journal.jsonl",
    );
    const initialJournal = await journalCounts(journalPath);
    if (initialJournal.started !== 2 || initialJournal.results !== 2)
      fail("initial Workflow journal count changed");
    const initialObservation = normalizeObservation(
      initialTerminal.artifact,
      "initial",
    );

    const replacement = `${scriptPath}.replacement`;
    await copyFile(resumedFixture, replacement);
    await rename(replacement, scriptPath);
    const resumedLaunch = await invokeWorkflow({
      executable,
      project,
      mcpConfig,
      sessionId,
      scriptPath,
      resumeFromRunId: initialLaunch.runId,
    });
    if (resumedLaunch.runId !== initialLaunch.runId)
      fail("Claude resume changed the Workflow run identifier");
    const resumedTerminal = await waitForArtifact(
      artifactPath,
      initialTerminal.mtimeMs,
    );
    const resumedJournal = await journalCounts(journalPath);
    if (resumedJournal.started !== 4 || resumedJournal.results !== 4)
      fail(
        "resumed Workflow did not reuse one prefix and execute two live calls",
      );
    const resumedObservation = normalizeObservation(
      resumedTerminal.artifact,
      "resumed",
    );

    const golden = {
      schemaVersion: 1,
      profile: PROFILE,
      evidence: {
        classification: "local-live-capture",
        liveFixtureCapture: "captured",
        binary: {
          sha256: binarySha256,
          version: "2.1.218",
          platform: process.platform,
          architecture: process.arch,
          verification: "exact-approved-digest-before-capture",
        },
        capture: {
          tool: "Workflow",
          initialInputKeys: initialLaunch.inputKeys,
          resumedInputKeys: resumedLaunch.inputKeys,
          artifactKeys,
        },
        limitations: [
          "local capture is not independently signed or externally attested",
        ],
      },
      fixture: {
        name: "parallel-pipeline-resume",
        initial: await fixtureDescriptor(initialFixture),
        resumed: await fixtureDescriptor(resumedFixture),
        agent: await fixtureDescriptor(agentFixture),
        args: argsValue,
      },
      replay: {
        usageSource: "synthetic",
        calls: [
          replayCall("alpha"),
          replayCall("beta"),
          {
            ...replayCall("beta-v2"),
            outcome: {
              kind: "completed",
              structured: false,
              value: "AWSL_ORACLE_BETA_V2",
            },
          },
          replayCall("gamma"),
        ],
      },
      observation: {
        initial: initialObservation,
        resumed: resumedObservation,
      },
    };
    const source = encode(golden);
    assertSafeGolden(source);
    await mkdir(dirname(goldenPath), { recursive: true, mode: 0o700 });
    const temporary = join(
      dirname(goldenPath),
      `.${basename(goldenPath)}.${process.pid}`,
    );
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, goldenPath);
    process.stdout.write(`${relative(root, goldenPath)} ${sha256(source)}\n`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "oracle capture failed"}\n`,
  );
  process.exitCode = 1;
});
