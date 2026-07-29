import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { AwslError } from "../../src/core/errors.js";
import type {
  NegotiatedAgentPolicy,
  ProviderIdentity,
  ProviderRequest,
} from "../../src/core/types.js";
import {
  CLAUDE_CAPABILITIES,
  ClaudeAdapter,
  type ClaudeAdapterOptions,
  buildClaudeArgv,
} from "../../src/providers/claude.js";
import type { RunProviderProcessOptions } from "../../src/providers/process.js";

const fixtureExecutable = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/bin/fake-claude.mjs",
);

const identity: ProviderIdentity = {
  id: "claude",
  executableRealpath: fixtureExecutable,
  version: "2.1.218",
};

function request(
  fixture: string,
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    cwd: process.cwd(),
    prompt: `fixture:${fixture}`,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function adapter(): ClaudeAdapter {
  return new ClaudeAdapter({ identity });
}

function expectSequence(
  actual: readonly string[],
  expected: readonly string[],
) {
  const first = actual.indexOf(expected[0] as string);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(actual.slice(first, first + expected.length)).toEqual(expected);
}

describe("Claude adapter request contract", () => {
  test("builds one noninteractive stream-json launch", () => {
    expect(
      buildClaudeArgv({
        effort: "high",
        model: "claude-opus-4-1",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-4-1",
      "--effort",
      "high",
      "--no-chrome",
      "--no-session-persistence",
      "--prompt-suggestions",
      "false",
    ]);
  });

  test("places configured safe args between fixed prefix and request flags", () => {
    expect(
      buildClaudeArgv({ configuredArgs: ["--safe-mode"], model: "sonnet" }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--model",
      "sonnet",
      "--no-chrome",
      "--no-session-persistence",
      "--prompt-suggestions",
      "false",
    ]);
  });

  test("rejects unsafe configured args in the direct argv builder", () => {
    expect(() =>
      buildClaudeArgv({
        configuredArgs: ["--dangerously-skip-permissions"],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test("snapshots configured args when constructing the adapter", async () => {
    const configuredArgs = ["--safe-mode"];
    const provider = new ClaudeAdapter({ identity, configuredArgs });
    configuredArgs[0] = "--dangerously-skip-permissions";

    const outcome = await provider.run(request("argv"));
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    const launch = JSON.parse(outcome.result.text) as { argv: string[] };
    expect(launch.argv).toContain("--safe-mode");
    expect(launch.argv).not.toContain("--dangerously-skip-permissions");
  });

  test("uses an injected process runner", async () => {
    let launch: RunProviderProcessOptions | undefined;
    const processRunner = vi.fn(async (options: RunProviderProcessOptions) => {
      launch = options;
      await options.onEvent?.({
        type: "system",
        subtype: "init",
        session_id: "injected-session",
        model: "claude-injected",
      });
      await options.onEvent?.({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "injected-session",
        result: "injected",
        usage: { input_tokens: 2, output_tokens: 1 },
      });
      return {
        exitCode: 0 as const,
        signal: null,
        eventCount: 2,
        stderrTail: Buffer.alloc(0),
      };
    });
    const provider = new ClaudeAdapter({ identity, processRunner });

    await expect(provider.run(request("unreachable"))).resolves.toMatchObject({
      kind: "completed",
      result: { text: "injected", model: "claude-injected" },
    });
    expect(processRunner).toHaveBeenCalledOnce();
    expect(launch).toMatchObject({
      executable: fixtureExecutable,
      prompt: "fixture:unreachable",
    });
  });

  test("rejects hostile configured args in the constructor without invoking traps", () => {
    const sentinel = new Error("configured args trap must not run");
    let trapCalls = 0;
    const configuredArgs = new Proxy(["--safe-mode"], {
      get: () => {
        trapCalls += 1;
        throw sentinel;
      },
    });

    expect(() => new ClaudeAdapter({ identity, configuredArgs })).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
    expect(trapCalls).toBe(0);
  });

  test("descriptor-snapshots adapter options and identity without invoking hostile code", () => {
    const sentinel = new Error("constructor trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const proxiedOptions = new Proxy(
      { identity },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    ) as ClaudeAdapterOptions;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "identity", {
      enumerable: true,
      get: trapped,
    });
    const proxiedIdentity = new Proxy(
      { ...identity },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    );
    const accessorIdentity = { ...identity };
    Object.defineProperty(accessorIdentity, "version", {
      enumerable: true,
      get: trapped,
    });
    const coercibleIdentity = {
      ...identity,
      version: {
        toString: trapped,
      },
    };

    for (const options of [
      proxiedOptions,
      accessorOptions,
      { identity: proxiedIdentity },
      { identity: accessorIdentity },
      { identity: coercibleIdentity },
      { identity, unknown: true },
      { identity, profile: "must-not-be-ignored" },
      { identity, processRunner: "must-be-a-function" },
      { identity: { ...identity, unknown: true } },
    ]) {
      expect(
        () => new ClaudeAdapter(options as unknown as ClaudeAdapterOptions),
      ).toThrow();
    }
    expect(trapCalls).toBe(0);
  });

  test("rejects inexact configured-args arrays without invoking accessors or coercion", () => {
    const sentinel = new Error("configured args hostile code must not run");
    let hostileCalls = 0;
    const trapped = () => {
      hostileCalls += 1;
      throw sentinel;
    };
    const accessorArgs = ["--safe-mode"];
    Object.defineProperty(accessorArgs, "0", {
      enumerable: true,
      get: trapped,
    });
    const sparseArgs = new Array<string>(1);
    class CustomArgs extends Array<string> {
      override toString(): string {
        return trapped();
      }
    }
    const customArgs = new CustomArgs("--safe-mode");

    for (const configuredArgs of [accessorArgs, sparseArgs, customArgs]) {
      expect(() => new ClaudeAdapter({ identity, configuredArgs })).toThrow();
    }
    expect(hostileCalls).toBe(0);
  });

  test("builds enforceable named-agent, schema, and strict MCP flags", () => {
    expect(
      buildClaudeArgv({
        agent: {
          name: "reviewer",
          instructions: "Review only the requested files.",
          tools: ["Read", "Bash(git diff:*)"],
          disallowedTools: ["WebFetch"],
          permissionMode: "dontAsk",
        },
        effort: "xhigh",
        mcpConfigPath: "/private/tmp/awsl-claude/mcp.json",
        model: "claude-opus-4-8",
        schemaPacket: '{"type":"object"}',
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "xhigh",
      "--json-schema",
      '{"type":"object"}',
      "--system-prompt",
      "Review only the requested files.",
      "--tools",
      "Read",
      "Bash(git diff:*)",
      "--disallowedTools",
      "WebFetch",
      "--mcp-config",
      "/private/tmp/awsl-claude/mcp.json",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--no-chrome",
      "--no-session-persistence",
      "--prompt-suggestions",
      "false",
    ]);
  });

  test.each([
    ["allowlist", { tools: ["Read", "--dangerously-skip-permissions"] }],
    ["denylist", { disallowedTools: ["--permission-mode"] }],
  ] as const)(
    "never emits option-like tokens from a direct %s",
    (_name, policy) => {
      expect(() =>
        buildClaudeArgv({
          agent: {
            name: "hostile",
            instructions: "Do not reinterpret policy values as CLI options.",
            ...policy,
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider: "claude",
          recoverable: false,
        }),
      );
    },
  );

  test("uses an empty --tools value to enforce a deny-all policy", () => {
    expectSequence(
      buildClaudeArgv({
        agent: {
          name: "no-tools",
          instructions: "Answer without tools.",
          tools: [],
        },
      }),
      ["--tools", ""],
    );
  });

  test("uses an empty --disallowedTools value to preserve an explicit denylist", () => {
    expectSequence(
      buildClaudeArgv({
        agent: {
          name: "empty-denylist",
          instructions: "Preserve the explicit policy.",
          disallowedTools: [],
        },
      }),
      ["--disallowedTools", ""],
    );
  });

  test("explicitly authorizes a requested bypassPermissions mode", () => {
    expectSequence(
      buildClaudeArgv({
        agent: {
          name: "sandboxed",
          instructions: "Operate inside the outer sandbox.",
          permissionMode: "bypassPermissions",
        },
      }),
      [
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
      ],
    );
  });

  test("publishes its version-locked request policy capabilities", () => {
    expect(CLAUDE_CAPABILITIES).toEqual({
      systemPrompt: "replace",
      tools: {
        allowlist: true,
        denylist: true,
        denyAll: true,
      },
      mcp: {
        additive: true,
        strictReplacement: true,
        denyAll: true,
      },
      permissionModes: [
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "manual",
        "dontAsk",
        "plan",
      ],
      sandboxModes: [],
      skills: false,
      structuredAttemptEvents: true,
      resolvedModelEvents: true,
    });
    expect(Object.isFrozen(CLAUDE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CAPABILITIES.tools)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CAPABILITIES.mcp)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CAPABILITIES.permissionModes)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CAPABILITIES.sandboxModes)).toBe(true);
  });

  test("fixes the supplied executable identity", () => {
    const source = { ...identity };
    const provider = new ClaudeAdapter({ identity: source });
    source.executableRealpath = "/changed";

    expect(provider.identity).toEqual(identity);
    expect(Object.isFrozen(provider.identity)).toBe(true);
    expect(
      () => new ClaudeAdapter({ identity: { ...identity, id: "codex" } }),
    ).toThrow(/requires a claude provider identity/);
  });

  test("rejects a raw or foreign provider version before launch", () => {
    for (const version of ["2.1.218 (Claude Code)", "9.9.9"]) {
      let launchCalls = 0;
      expect(() => {
        const provider = new ClaudeAdapter({
          identity: { ...identity, version },
        });
        launchCalls += 1;
        return provider.run(request("success"));
      }).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider: "claude",
          recoverable: false,
        }),
      );
      expect(launchCalls).toBe(0);
    }
  });

  test("passes prompt on stdin and enforces all named-agent policies", async () => {
    const agent: NegotiatedAgentPolicy = {
      name: "restricted",
      instructions: "Use only the declared capabilities.",
      tools: ["Read"],
      disallowedTools: ["WebFetch"],
      mcp: {
        demo: {
          command: "demo-server",
          args: ["--stdio"],
        },
      },
      permissionMode: "manual",
    };

    const outcome = await adapter().run(
      request("argv", {
        agent,
        effort: "high",
        model: "claude-sonnet-4-6",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      }),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    const launch = JSON.parse(outcome.result.text) as {
      argv: string[];
      cwd: string;
      mcpPacket: string;
      prompt: string;
    };
    expect(launch.cwd).toBe(process.cwd());
    expect(launch.prompt).toBe("fixture:argv");
    expectSequence(launch.argv, [
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "high",
    ]);
    expectSequence(launch.argv, [
      "--system-prompt",
      "Use only the declared capabilities.",
      "--tools",
      "Read",
      "--disallowedTools",
      "WebFetch",
    ]);
    expectSequence(launch.argv, [
      "--strict-mcp-config",
      "--permission-mode",
      "manual",
    ]);
    expect(JSON.parse(launch.mcpPacket)).toEqual({
      mcpServers: agent.mcp,
    });

    const mcpPath = launch.argv.at(
      launch.argv.indexOf("--mcp-config") + 1,
    ) as string;
    await expect(access(mcpPath)).rejects.toThrow();
    await expect(access(dirname(mcpPath))).rejects.toThrow();
  });

  test("never falls back to a legacy named-agent model", async () => {
    const legacyAgent = {
      name: "reviewer",
      instructions: "Review.",
      model: "agent-model",
    } as unknown as NegotiatedAgentPolicy;
    const outcome = await adapter().run(
      request("argv", {
        agent: legacyAgent,
      }),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    const launch = JSON.parse(outcome.result.text) as { argv: string[] };
    expect(launch.argv).not.toContain("--model");
    expect(launch.argv).not.toContain("agent-model");
  });

  test("rejects bypassed nonempty skills before creating MCP state or launching", async () => {
    const agent = {
      instructions: "Do not launch this request.",
      mcp: {},
      name: "unsupported-skills",
      skills: ["repository-skill"],
    } as unknown as NegotiatedAgentPolicy;
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-claude-mcp-"),
    );

    await expect(
      adapter().run(request("unreachable", { agent })),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
    });
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-claude-mcp-"),
      ),
    ).toEqual(before);
  });

  test("writes an exact empty strict MCP replacement but creates nothing when MCP is absent", async () => {
    const emptyOutcome = await adapter().run(
      request("argv", {
        agent: {
          name: "empty-mcp",
          instructions: "Use no ambient MCP servers.",
          mcp: {},
        },
      }),
    );
    expect(emptyOutcome.kind).toBe("completed");
    if (emptyOutcome.kind !== "completed")
      throw new Error("expected completion");
    const emptyLaunch = JSON.parse(emptyOutcome.result.text) as {
      argv: string[];
      mcpPacket?: string;
    };
    expect(JSON.parse(emptyLaunch.mcpPacket as string)).toEqual({
      mcpServers: {},
    });
    const marker = emptyLaunch.argv.indexOf("--mcp-config");
    expect(marker).toBeGreaterThan(-1);
    expect(emptyLaunch.argv[marker + 2]).toBe("--strict-mcp-config");
    await expect(
      access(emptyLaunch.argv[marker + 1] as string),
    ).rejects.toThrow();

    const absentOutcome = await adapter().run(
      request("argv", {
        agent: {
          name: "ambient-mcp",
          instructions: "Do not replace ambient MCP configuration.",
        },
      }),
    );
    expect(absentOutcome.kind).toBe("completed");
    if (absentOutcome.kind !== "completed")
      throw new Error("expected completion");
    const absentLaunch = JSON.parse(absentOutcome.result.text) as {
      argv: string[];
      mcpPacket?: string;
    };
    expect(absentLaunch.argv).not.toContain("--mcp-config");
    expect(absentLaunch.argv).not.toContain("--strict-mcp-config");
    expect(Object.hasOwn(absentLaunch, "mcpPacket")).toBe(false);
  });

  test.each(["default", "delegate", "future-mode"])(
    "rejects unsupported permission mode %s before launch",
    async (mode) => {
      await expect(
        adapter().run(
          request("unreachable", {
            agent: {
              name: "restricted",
              instructions: "stay focused",
              permissionMode: mode,
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: "COMPATIBILITY_ERROR",
        provider: "claude",
        recoverable: false,
      });
    },
  );

  test("rejects a direct Codex sandbox policy before launch", async () => {
    await expect(
      adapter().run(
        request("unreachable", {
          agent: {
            name: "restricted",
            instructions: "stay focused",
            sandboxMode: "workspace-write",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
      recoverable: false,
    });
  });

  test("rejects malformed policy before creating an MCP artifact", async () => {
    const malformed = {
      name: "restricted",
      instructions: "stay focused",
      tools: ["Read", 42],
      mcp: { demo: { command: "unreachable" } },
    } as unknown as NegotiatedAgentPolicy;

    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-claude-mcp-"),
    );
    await expect(
      adapter().run(request("unreachable", { agent: malformed })),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
    });
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-claude-mcp-"),
      ),
    ).toEqual(before);
  });

  test("rejects option injection before creating MCP state or launching", async () => {
    const agent = {
      name: "hostile",
      instructions: "This request must never launch.",
      tools: ["Read", "--dangerously-skip-permissions"],
      mcp: {},
    } as unknown as NegotiatedAgentPolicy;
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-claude-mcp-"),
    );

    await expect(
      adapter().run(request("unreachable", { agent })),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
      recoverable: false,
    });
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-claude-mcp-"),
      ),
    ).toEqual(before);
  });

  test("rejects an accessor-backed tool list without invoking it or launching", async () => {
    const sentinel = new Error("tool accessor must not run");
    let accessorCalls = 0;
    const tools = ["placeholder"];
    Object.defineProperty(tools, "0", {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        throw sentinel;
      },
    });
    const agent = {
      name: "hostile",
      instructions: "This request must never launch.",
      tools,
      mcp: {},
    } as unknown as NegotiatedAgentPolicy;
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-claude-mcp-"),
    );

    await expect(
      adapter().run(request("unreachable", { agent })),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
      recoverable: false,
    });
    expect(accessorCalls).toBe(0);
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-claude-mcp-"),
      ),
    ).toEqual(before);
  });

  test("rejects an unsupported effort before launch", async () => {
    await expect(
      adapter().run(
        request("unreachable", {
          effort: "ultra" as ProviderRequest["effort"],
        }),
      ),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
    });
  });

  test("rejects a non-object MCP policy before creating an artifact", async () => {
    await expect(
      adapter().run(
        request("unreachable", {
          agent: {
            name: "restricted",
            instructions: "stay focused",
            mcp: [] as unknown as NegotiatedAgentPolicy["mcp"],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
    });
  });

  test("rejects a non-JSON schema before launch", async () => {
    const schema = {};
    Object.defineProperty(schema, "type", {
      enumerable: true,
      get: () => "object",
    });

    await expect(
      adapter().run(
        request("unreachable", {
          schema,
        }),
      ),
    ).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      provider: "claude",
    });
  });

  test("rejects a semantically invalid JSON Schema before launch", async () => {
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-claude-mcp-"),
    );
    await expect(
      adapter().run(
        request("unreachable", {
          agent: {
            name: "mcp-agent",
            instructions: "This request must never create an artifact.",
            mcp: { demo: { command: "unreachable" } },
          },
          schema: { type: "not-a-json-schema-type" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      provider: "claude",
    });
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-claude-mcp-"),
      ),
    ).toEqual(before);
  });

  test("rejects an async JSON Schema before launch", async () => {
    await expect(
      adapter().run(
        request("unreachable", {
          schema: { $async: true, type: "string" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      provider: "claude",
    });
  });
});

describe("Claude 2.1.218 stream protocol", () => {
  test("returns the authoritative successful result and complete usage", async () => {
    const outcome = await adapter().run(
      request("success", { effort: "xhigh" }),
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      result: {
        effort: "xhigh",
        model: "claude-resolved-2.1.218",
        text: "ok",
      },
      usage: {
        cachedInputTokens: 3,
        complete: true,
        inputTokens: 11,
        outputTokens: 7,
      },
      observation: {
        resolvedModel: "claude-resolved-2.1.218",
        sessionId: "session-1",
      },
    });
  });

  test("returns Claude structured_output as data", async () => {
    const outcome = await adapter().run(
      request("structured", {
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      result: {
        data: { answer: 42 },
        text: '{"answer":42}',
      },
      usage: { outputTokens: 6, complete: true },
      observation: {
        sessionId: "session-1",
        structuredOutputAttempts: 2,
      },
    });
  });

  test("counts StructuredOutput tool uses in one schema transport session", async () => {
    const sessions = new Set<string>();
    const outcome = await adapter().run(
      request("structured", {
        schema: { type: "object" },
        onRawEvent: (event) => {
          const sessionId = (event as { session_id?: string }).session_id;
          if (sessionId !== undefined) sessions.add(sessionId);
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      observation: { structuredOutputAttempts: 2 },
    });
    expect(sessions).toEqual(new Set(["session-1"]));
  });

  test("fails closed after the sixth StructuredOutput tool use without another session", async () => {
    const sessions = new Set<string>();
    const outcome = await adapter().run(
      request("structured-too-many-attempts", {
        schema: { type: "object" },
        onRawEvent: (event) => {
          const sessionId = (event as { session_id?: string }).session_id;
          if (sessionId !== undefined) sessions.add(sessionId);
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "PROVIDER_ERROR", provider: "claude" },
      observation: { structuredOutputAttempts: 6 },
    });
    expect(sessions).toEqual(new Set(["session-1"]));
  });

  test("does not let a raw-event observer mutate structured result data", async () => {
    const outcome = await adapter().run(
      request("structured", {
        schema: { type: "object" },
        onRawEvent: (event) => {
          const structured = (
            event as { structured_output?: { answer?: number } }
          ).structured_output;
          if (structured !== undefined) structured.answer = 99;
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      result: { data: { answer: 42 } },
    });
  });

  test("returns SCHEMA_ERROR when Claude structured_output mismatches the request schema", async () => {
    const sessions = new Set<string>();
    const outcome = await adapter().run(
      request("structured", {
        schema: {
          properties: { answer: { type: "string" } },
          required: ["answer"],
          type: "object",
        },
        onRawEvent: (event) => {
          const sessionId = (event as { session_id?: string }).session_id;
          if (sessionId !== undefined) sessions.add(sessionId);
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "SCHEMA_ERROR", provider: "claude" },
      observation: {
        sessionId: "session-1",
        structuredOutputAttempts: 2,
      },
      usage: { complete: true, outputTokens: 6 },
    });
    expect(sessions).toEqual(new Set(["session-1"]));
  });

  test("fails closed when structured output is missing", async () => {
    await expect(
      adapter().run(
        request("success", {
          schema: { type: "object" },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "PROVIDER_ERROR", provider: "claude" },
      usage: { outputTokens: 7, complete: true },
    });
  });

  test("maps success/is_error true to the evidenced compatibility null", async () => {
    await expect(
      adapter().run(request("success-is-error")),
    ).resolves.toMatchObject({
      kind: "compatibility-null",
      reason: "claude-terminal-api-error",
      usage: {
        inputTokens: 9,
        outputTokens: 5,
        complete: true,
      },
      observation: { sessionId: "session-1" },
    });
  });

  test.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
    "error_future_terminal",
  ])("maps terminal subtype %s to an error outcome", async (subtype) => {
    await expect(
      adapter().run(request(`error:${subtype}`)),
    ).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "PROVIDER_ERROR",
        provider: "claude",
      },
      usage: {
        inputTokens: 13,
        outputTokens: 3,
        complete: true,
      },
    });
  });

  test("accepts the version-locked tool loop and awaits raw events in order", async () => {
    const seen: string[] = [];
    const callback = vi.fn(async (event: unknown) => {
      await Promise.resolve();
      seen.push((event as { type: string }).type);
    });

    const outcome = await adapter().run(
      request("tool-loop", { onRawEvent: callback }),
    );

    expect(outcome.kind).toBe("completed");
    expect(seen).toEqual([
      "system",
      "assistant",
      "stream_event",
      "user",
      "tool_progress",
      "tool_use_summary",
      "rate_limit_event",
      "auth_status",
      "prompt_suggestion",
      "result",
    ]);
    expect(callback).toHaveBeenCalledTimes(10);
    expect(seen.filter((type) => type === "rate_limit_event")).toHaveLength(1);
  });

  test.each([
    "unknown-event",
    "duplicate-terminal",
    "post-terminal",
    "system-non-init",
    "user-non-tool-result",
  ])("fails closed for protocol fixture %s", async (fixture) => {
    await expect(adapter().run(request(fixture))).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "PROVIDER_ERROR",
        provider: "claude",
      },
    });
  });

  test.each(["conflicting-session", "conflicting-model"])(
    "fails closed for %s observations",
    async (fixture) => {
      await expect(adapter().run(request(fixture))).resolves.toMatchObject({
        kind: "error",
        error: {
          code: "PROVIDER_ERROR",
          provider: "claude",
        },
      });
    },
  );

  test.each(["eof-without-terminal", "malformed-json", "nonzero-exit"])(
    "returns a provider error outcome for %s",
    async (fixture) => {
      await expect(adapter().run(request(fixture))).resolves.toMatchObject({
        kind: "error",
        error: {
          code: "PROVIDER_ERROR",
          provider: "claude",
        },
      });
    },
  );

  test("preserves terminal usage when a later transport failure invalidates the call", async () => {
    await expect(
      adapter().run(request("terminal-then-malformed")),
    ).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "PROVIDER_ERROR",
        provider: "claude",
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        complete: true,
      },
    });
  });

  test.each(["missing-output-usage", "invalid-output-usage"])(
    "marks %s as usage-indeterminate",
    async (fixture) => {
      await expect(adapter().run(request(fixture))).resolves.toMatchObject({
        kind: "completed",
        usage: {
          complete: false,
        },
      });
    },
  );

  test("turns a rejected raw-event callback into an error outcome", async () => {
    await expect(
      adapter().run(
        request("success", {
          onRawEvent: () => {
            throw new Error("consumer failed");
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "PROVIDER_ERROR",
        provider: "claude",
      },
      usage: { complete: false },
    });
  });

  test("preserves an exact persistence error through the real Claude process runner", async () => {
    const persistence = new AwslError("PERSISTENCE_ERROR", "raw sink failed", {
      recoverable: false,
    });
    const outcome = await adapter().run(
      request("success", {
        onRawEvent: () => {
          throw persistence;
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: "error", error: persistence });
    if (outcome.kind === "error") expect(outcome.error).toBe(persistence);
  });

  test("retains terminal usage when the raw callback rejects on result", async () => {
    await expect(
      adapter().run(
        request("success", {
          onRawEvent: (event) => {
            if ((event as { type?: string }).type === "result") {
              throw new Error("result consumer failed");
            }
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "PROVIDER_ERROR",
        provider: "claude",
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        complete: true,
      },
    });
  });

  test("propagates global cancellation instead of returning an outcome", async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const running = adapter().run(
      request("hang", {
        onRawEvent: (event) => {
          if (
            (event as { type?: string; subtype?: string }).type === "system" &&
            (event as { type?: string; subtype?: string }).subtype === "init"
          )
            resolveStarted();
        },
        signal: controller.signal,
      }),
    );
    const settled = Promise.allSettled([running]);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    expect(await settled).toMatchObject([
      {
        reason: { code: "CANCELLED" },
        status: "rejected",
      },
    ]);
  });

  test("removes a private MCP artifact after cancellation", async () => {
    const controller = new AbortController();
    let resolveMcpPath!: (path: string) => void;
    const mcpPathPromise = new Promise<string>((resolve) => {
      resolveMcpPath = resolve;
    });
    const running = adapter().run(
      request("hang", {
        agent: {
          name: "mcp-agent",
          instructions: "Use the isolated MCP server.",
          mcp: { demo: { command: "demo-server" } },
        },
        onRawEvent: (event) => {
          const mcpPath = (event as { mcp_path?: string }).mcp_path;
          if (mcpPath !== undefined) resolveMcpPath(mcpPath);
        },
        signal: controller.signal,
      }),
    );
    const assertion = expect(running).rejects.toMatchObject({
      code: "CANCELLED",
    });
    const mcpPath = await mcpPathPromise;
    expect(await access(mcpPath)).toBeUndefined();

    controller.abort();
    await assertion;
    await expect(access(mcpPath)).rejects.toThrow();
    await expect(access(dirname(mcpPath))).rejects.toThrow();
  });
});
