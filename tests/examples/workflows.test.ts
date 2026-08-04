import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";
import { compileWorkflow } from "../../src/compat/compile.js";
import { executeSandbox } from "../../src/worker/sandbox.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const examplesRoot = join(repositoryRoot, "examples");
const examples = [
  ["research-panel.js", "research-panel"],
  ["parallel-code-review.js", "parallel-code-review"],
  ["worktree-refactor.js", "worktree-refactor"],
  ["resume-after-failure.js", "resume-after-failure"],
] as const;

interface AgentCall {
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}

function captureAgentCall(params: unknown): AgentCall {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("invalid agent request");
  }
  const value = params as Record<string, unknown>;
  if (
    typeof value.prompt !== "string" ||
    value.options === null ||
    typeof value.options !== "object" ||
    Array.isArray(value.options)
  ) {
    throw new TypeError("invalid agent request");
  }
  return {
    prompt: value.prompt,
    options: value.options as Readonly<Record<string, unknown>>,
  };
}

async function startExample(
  filename: string,
  args: unknown,
  responses: Readonly<Record<string, unknown>>,
) {
  const path = join(examplesRoot, filename);
  const workflow = compileWorkflow(await readFile(path, "utf8"), path);
  const calls: AgentCall[] = [];
  const result = executeSandbox({
    code: workflow.code,
    filename: workflow.filename,
    args,
    budget: { total: 10_000, spent: 0 },
    request: async (method, params) => {
      if (method !== "agent") return { value: null };
      const call = captureAgentCall(params);
      calls.push(call);
      const label = call.options.label;
      if (typeof label !== "string" || !Object.hasOwn(responses, label)) {
        throw new Error(`missing fake response for ${String(label)}`);
      }
      return { value: responses[label] };
    },
    signal: new AbortController().signal,
  });
  return { calls, result };
}

describe("public workflow examples", () => {
  test("all examples compile through the provider-free inspect command", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "awsl-examples-"));
    const stateDir = join(temporaryRoot, "must-not-exist");
    try {
      for (const [filename, name] of examples) {
        let stdout = "";
        let stderr = "";
        const exitCode = await executeCli(
          [
            "workflow",
            "inspect",
            join(examplesRoot, filename),
            "--format",
            "json",
          ],
          {
            cwd: repositoryRoot,
            env: {
              ...process.env,
              AWSL_STATE_DIR: stateDir,
              AWSL_CODEX_COMMAND: join(temporaryRoot, "must-not-run"),
            },
            homeDir: temporaryRoot,
            stdoutIsTTY: false,
            stdin: { isTTY: true, read: async () => "" },
            writeStdout: async (value) => {
              stdout += value;
            },
            writeStderr: async (value) => {
              stderr += value;
            },
          },
        );

        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
          meta: {
            name,
            description: expect.any(String),
            phases: expect.any(Array),
          },
          sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
      }
      await expect(access(stateDir)).rejects.toBeTruthy();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("research panel reports a partial result when one parallel branch is null", async () => {
    const finding = (summary: string) => ({
      summary,
      keyPoints: [summary],
      confidence: "medium",
    });
    const execution = await startExample(
      "research-panel.js",
      { topic: "durable agent workflows" },
      {
        "research-practitioner": finding("practical"),
        "research-skeptic": null,
        "research-strategist": finding("strategic"),
        "research-synthesis": {
          answer: "Use explicit durability boundaries.",
          agreements: ["Failures must be visible."],
          uncertainties: ["Provider behavior varies."],
        },
      },
    );

    await expect(execution.result).resolves.toMatchObject({
      status: "partial",
      perspectivesRequested: 3,
      perspectivesCompleted: 2,
    });
    expect(execution.calls.map((call) => call.options.label)).toEqual([
      "research-practitioner",
      "research-skeptic",
      "research-strategist",
      "research-synthesis",
    ]);
    expect(execution.calls.at(-1)?.prompt).not.toContain('"skeptic"');
  });

  test("parallel code review excludes a null branch before adjudication", async () => {
    const review = (summary: string) => ({ summary, findings: [] });
    const execution = await startExample(
      "parallel-code-review.js",
      { scope: "the current branch", objective: "keep the API stable" },
      {
        "review-correctness": review("correctness checked"),
        "review-security": null,
        "review-maintainability": review("maintainability checked"),
        "review-adjudication": {
          verdict: "pass",
          summary: "No supported findings.",
          findings: [],
        },
      },
    );

    await expect(execution.result).resolves.toMatchObject({
      status: "partial",
      reviewersRequested: 3,
      reviewersCompleted: 2,
      adjudication: { verdict: "pass" },
    });
    expect(execution.calls.at(-1)?.prompt).not.toContain(
      '"reviewer":"security"',
    );
  });

  test("worktree refactor requests isolation and leaves integration explicit", async () => {
    const execution = await startExample(
      "worktree-refactor.js",
      { task: "Rename one internal helper without changing behavior" },
      {
        "isolated-refactor": {
          summary: "Renamed the helper.",
          changedFiles: ["src/helper.ts"],
          tests: [{ command: "pnpm test", outcome: "passed" }],
          remainingRisks: [],
        },
      },
    );

    await expect(execution.result).resolves.toMatchObject({
      status: "ready-for-review",
      nextStep: expect.stringContaining("awsl runs show"),
    });
    expect(execution.calls).toHaveLength(1);
    expect(execution.calls[0]?.options).toMatchObject({
      label: "isolated-refactor",
      isolation: "worktree",
    });
    expect(execution.calls[0]?.prompt).toContain("Do not commit");
  });

  test("resume demo keeps its checkpoint call stable across replacement args", async () => {
    const responses = {
      "resume-checkpoint-plan": {
        goal: "Produce a safe analysis.",
        steps: ["Inspect", "Explain"],
        risks: [],
      },
      "resume-final-analysis": {
        answer: "Analysis complete.",
        followUps: [],
      },
    };
    const failed = await startExample(
      "resume-after-failure.js",
      { task: "Explain the module", failAfterCheckpoint: true },
      responses,
    );

    await expect(failed.result).rejects.toThrow(
      /intentional demo failure after checkpoint/,
    );
    expect(failed.calls).toHaveLength(1);

    const resumed = await startExample(
      "resume-after-failure.js",
      { task: "Explain the module", failAfterCheckpoint: false },
      responses,
    );
    await expect(resumed.result).resolves.toMatchObject({
      status: "completed",
      result: { answer: "Analysis complete." },
    });
    expect(resumed.calls.map((call) => call.options.label)).toEqual([
      "resume-checkpoint-plan",
      "resume-final-analysis",
    ]);
    expect(resumed.calls[0]?.prompt).toBe(failed.calls[0]?.prompt);
    expect(resumed.calls[0]?.prompt).not.toContain("failAfterCheckpoint");
  });
});
