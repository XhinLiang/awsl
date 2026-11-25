import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import type {
  ProviderIdentity,
  ProviderRequest,
} from "../../src/core/types.js";
import {
  AGY_CAPABILITIES,
  AGY_FILE_PROMPT_BYTES,
  AGY_FILE_RESULT_PROMPT_BYTES,
  AgyAdapter,
  type AgyAdapterOptions,
  buildAgyArgv,
} from "../../src/providers/agy.js";

const fakeAgy = fileURLToPath(
  new URL("../fixtures/bin/fake-agy.mjs", import.meta.url),
);

const identity: ProviderIdentity = {
  id: "agy",
  executableRealpath: "/fixtures/agy",
  version: "1.5.16",
};

beforeAll(async () => {
  await chmod(fakeAgy, 0o755);
});

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    cwd: process.cwd(),
    prompt: "inspect the module",
    signal: new AbortController().signal,
    ...overrides,
  };
}

type ProcessRunner = NonNullable<AgyAdapterOptions["processRunner"]>;
type ProcessOptions = Parameters<ProcessRunner>[0];

function fakeRunner(
  events: readonly unknown[],
  inspect?: (options: ProcessOptions) => void | Promise<void>,
): { calls: ProcessOptions[]; run: ProcessRunner } {
  const calls: ProcessOptions[] = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      await inspect?.(options);
      for (const event of events) await options.onEvent?.(event);
      return {
        eventCount: events.length,
        exitCode: 0,
        signal: null,
        stderrTail: Buffer.alloc(0),
      };
    },
  };
}

const successStream = [
  {
    event: "init",
    conversation_id: "conv-1",
    init: {
      cwd: "/workspace",
      model: "gemini-4-carbon",
      permission_mode: "request-review",
      tools: ["run_command", "view_file"],
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: "conv-1",
      step_index: 0,
      state: "DONE",
      step_type: "user_input",
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: "conv-1",
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "git status" },
        error: { type: "command_failed", message: "exit status 1" },
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: "conv-1",
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "done",
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        thinking_tokens: 10,
        cache_read_tokens: 40,
      },
    },
  },
  {
    event: "result",
    result: {
      conversation_id: "conv-1",
      status: "SUCCESS",
      response: "done",
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        thinking_tokens: 10,
        cache_read_tokens: 40,
        total_tokens: 125,
      },
    },
  },
];

describe("Agy adapter contract", () => {
  test("publishes only capabilities that agy can enforce", () => {
    expect(AGY_CAPABILITIES).toEqual({
      systemPrompt: "prompt-prefix",
      tools: {
        allowlist: false,
        denylist: false,
        denyAll: false,
      },
      mcp: {
        additive: false,
        strictReplacement: false,
        denyAll: false,
      },
      permissionModes: [
        "accept-edits",
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "plan",
      ],
      sandboxModes: [],
      skills: false,
      structuredAttemptEvents: false,
      resolvedModelEvents: false,
    });
  });

  test("builds stream-json argv with permission normalization and workspace dirs", () => {
    expect(
      buildAgyArgv({
        configuredArgs: ["--disable-slash-commands", "--sandbox"],
        model: "gemini-4-carbon",
        effort: "high",
        permissionMode: "acceptEdits",
        schemaPath: "/tmp/schema.json",
        additionalDirs: ["/tmp/dir-a"],
      }),
    ).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--sandbox",
      "--model",
      "gemini-4-carbon",
      "--effort",
      "high",
      "--mode",
      "accept-edits",
      "--json-schema",
      "/tmp/schema.json",
      "--add-dir",
      "/tmp/dir-a",
    ]);

    expect(
      buildAgyArgv({
        permissionMode: "bypassPermissions",
      }),
    ).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("rejects unsafe configured args in argv builder and constructor", () => {
    expect(() =>
      buildAgyArgv({ configuredArgs: ["--dangerously-skip-permissions"] }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );

    expect(
      () =>
        new AgyAdapter({
          identity,
          configuredArgs: ["--model", "gemini-4-carbon"],
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test("consumes stream-json events, tool trail, and token usage", async () => {
    const runner = fakeRunner(successStream);
    const adapter = new AgyAdapter({
      identity,
      permissionMode: "auto",
      processRunner: runner.run,
    });

    const outcome = await adapter.run(
      request({
        effort: "medium",
        model: "gemini-4-carbon",
      }),
    );

    expect(runner.calls[0]?.argv).toContain("--mode");
    expect(runner.calls[0]?.argv).toContain("auto");
    const sentPacket = JSON.parse(runner.calls[0]?.prompt.trim() ?? "{}");
    expect(sentPacket).toEqual({
      event: "user",
      message: { content: "inspect the module" },
    });

    expect(outcome).toEqual({
      kind: "completed",
      result: {
        text: "done",
        model: "gemini-4-carbon",
        effort: "medium",
        toolUses: [
          {
            tool: "run_command",
            input: '{"CommandLine":"git status"}',
            error: "exit status 1",
          },
        ],
      },
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 25,
        reasoningTokens: 10,
        complete: true,
      },
      observation: {
        sessionId: "conv-1",
        resolvedModel: "gemini-4-carbon",
      },
    });
  });

  test("marks pre-output zero-usage transient error results as recoverable even on nonzero exit", async () => {
    const adapter = new AgyAdapter({
      identity,
      processRunner: async (options) => {
        await options.onEvent?.({
          event: "result",
          result: {
            conversation_id: "",
            status: "ERROR",
            response: "",
            error: "HTTP 429 rate limit exceeded, token=super-secret-value",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              thinking_tokens: 0,
              cache_read_tokens: 0,
              total_tokens: 0,
            },
          },
        });
        throw new Error("provider process exited unsuccessfully");
      },
    });

    const outcome = await adapter.run(request());
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected error");
    expect(outcome.error.code).toBe("PROVIDER_ERROR");
    expect(outcome.error.recoverable).toBe(true);
    expect(outcome.error.message).toContain("[REDACTED]");
    expect(outcome.error.message).not.toContain("super-secret-value");
    expect(outcome.usage).toEqual({ complete: true, outputTokens: 0 });
  });

  test("does not mark errors recoverable after substantive step output", async () => {
    const adapter = new AgyAdapter({
      identity,
      processRunner: async (options) => {
        await options.onEvent?.({
          event: "init",
          conversation_id: "conv-err",
          init: { cwd: "/workspace", tools: [] },
        });
        await options.onEvent?.({
          event: "step_update",
          step_update: {
            conversation_id: "conv-err",
            step_index: 1,
            state: "DONE",
            step_type: "tool",
            tool_name: "run_command",
          },
        });
        await options.onEvent?.({
          event: "result",
          result: {
            conversation_id: "conv-err",
            status: "ERROR",
            response: "",
            error: "503 service unavailable",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        return {
          eventCount: 3,
          exitCode: 0,
          signal: null,
          stderrTail: Buffer.alloc(0),
        };
      },
    });

    const outcome = await adapter.run(request());
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected error");
    expect(outcome.error.recoverable).toBe(false);
  });

  test("spills oversized prompts and structured outputs through private files via fake-agy", async () => {
    const adapter = new AgyAdapter({
      identity: {
        id: "agy",
        executableRealpath: fakeAgy,
        version: "1.5.16",
      },
      configuredArgs: ["--disable-slash-commands"],
      permissionMode: "bypassPermissions",
    });

    const hugePrompt = `synthesize:${"x".repeat(
      Math.max(AGY_FILE_PROMPT_BYTES, AGY_FILE_RESULT_PROMPT_BYTES) + 2048,
    )}`;

    const outcome = await adapter.run(
      request({
        prompt: hugePrompt,
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            length: { type: "integer" },
          },
          required: ["ok", "length"],
          additionalProperties: false,
        },
      }),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    expect(outcome.result.data).toEqual({
      ok: true,
      length: expect.any(Number),
    });
    expect((outcome.result.data as { length: number }).length).toBeGreaterThan(
      hugePrompt.length,
    );
  });

  test("fails closed when structured output violates the requested schema", async () => {
    const runner = fakeRunner([
      {
        event: "init",
        conversation_id: "conv-schema",
        init: { cwd: "/workspace", tools: [] },
      },
      {
        event: "result",
        result: {
          conversation_id: "conv-schema",
          status: "SUCCESS",
          response: '{"wrong":1}',
          structured_output: { wrong: 1 },
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);
    const adapter = new AgyAdapter({ identity, processRunner: runner.run });

    const outcome = await adapter.run(
      request({
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      }),
    );

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("expected schema error");
    expect(outcome.error.code).toBe("SCHEMA_ERROR");
  });

  test(" cleans up temporary prompt and result directories even when reading result fails", async () => {
    let capturedPromptPath = "";
    let capturedResultPath = "";
    const adapter = new AgyAdapter({
      identity,
      processRunner: async (options) => {
        const packet = JSON.parse(options.prompt.trim()) as {
          message: { content: string };
        };
        const pm = /Read the full prompt from "([^"]+)"/.exec(
          packet.message.content,
        );
        capturedPromptPath = pm?.[1] ?? "";
        const full = await readFile(capturedPromptPath, "utf8");
        const rm = /replacing its current contents: "([^"]+)"/.exec(full);
        capturedResultPath = rm?.[1] ?? "";
        await writeFile(capturedResultPath, "", "utf8");
        await options.onEvent?.({
          event: "init",
          conversation_id: "conv-empty",
          init: { cwd: "/workspace", tools: [] },
        });
        await options.onEvent?.({
          event: "result",
          result: {
            conversation_id: "conv-empty",
            status: "SUCCESS",
            response: JSON.stringify({ result_path: capturedResultPath }),
            structured_output: { result_path: capturedResultPath },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        return {
          eventCount: 2,
          exitCode: 0,
          signal: null,
          stderrTail: Buffer.alloc(0),
        };
      },
    });

    const outcome = await adapter.run(
      request({
        prompt: "y".repeat(AGY_FILE_PROMPT_BYTES + 1024),
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      }),
    );
    expect(outcome.kind).toBe("error");
    await expect(readFile(capturedPromptPath, "utf8")).rejects.toThrow();
    await expect(readFile(capturedResultPath, "utf8")).rejects.toThrow();
  });
});
