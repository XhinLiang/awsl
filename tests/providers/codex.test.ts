import { access, lstat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { AwslError } from "../../src/core/errors.js";
import type {
  NegotiatedAgentPolicy,
  ProviderIdentity,
  ProviderRequest,
} from "../../src/core/types.js";
import {
  CODEX_CAPABILITIES,
  CodexAdapter,
  type CodexAdapterOptions,
  buildCodexArgv,
} from "../../src/providers/codex.js";

const identity: ProviderIdentity = {
  id: "codex",
  executableRealpath: "/fixtures/codex",
  version: "0.145.0",
};

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    cwd: "/workspace",
    prompt: "do the work",
    signal: new AbortController().signal,
    ...overrides,
  };
}

type ProcessRunner = NonNullable<CodexAdapterOptions["processRunner"]>;
type ProcessOptions = Parameters<ProcessRunner>[0];

const successEvents = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  {
    type: "item.started",
    item: { id: "reason-1", type: "reasoning", text: "" },
  },
  {
    type: "item.updated",
    item: { id: "reason-1", type: "reasoning", text: "checking" },
  },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "old" },
  },
  {
    type: "item.completed",
    item: { id: "message-2", type: "agent_message", text: "ok" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
    },
  },
];

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

function deepFreezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeJson(child);
}

describe("Codex adapter contract", () => {
  test("places global options before exec and the prompt marker last", () => {
    expect(
      buildCodexArgv({
        effort: "high",
        model: "gpt-5.6-sol",
      }),
    ).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "--json",
      "-",
    ]);
  });

  test("owns profile and validated configured args before request options", () => {
    expect(
      buildCodexArgv({
        profile: "corp",
        configuredArgs: ["--search"],
        model: "gpt",
        effort: "high",
      }),
    ).toEqual([
      "--profile",
      "corp",
      "--search",
      "-m",
      "gpt",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "--json",
      "-",
    ]);
  });

  test("places a validated agent sandbox before exec", async () => {
    const fixture = fakeRunner(successEvents);
    const adapter = new CodexAdapter({
      identity,
      processRunner: fixture.run,
    });

    await adapter.run(
      request({
        agent: {
          instructions: "stay focused",
          name: "restricted",
          sandboxMode: "workspace-write",
        },
      }),
    );

    expect(fixture.calls[0]?.argv).toEqual([
      "--sandbox",
      "workspace-write",
      "exec",
      "--json",
      "-",
    ]);
  });

  test.each([
    ["configured args", { configuredArgs: ["--model", "evil"] }],
    ["profile", { profile: "../bad" }],
  ] as const)("rejects an unsafe direct %s builder input", (_name, options) => {
    expect(() => buildCodexArgv(options)).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test("snapshots configured args when constructing the adapter", async () => {
    const configuredArgs = ["--search"];
    const fixture = fakeRunner(successEvents);
    const adapter = new CodexAdapter({
      identity,
      configuredArgs,
      profile: "corp",
      processRunner: fixture.run,
    });
    configuredArgs[0] = "--model";

    await adapter.run(request());
    expect(fixture.calls[0]?.argv).toEqual([
      "--profile",
      "corp",
      "--search",
      "exec",
      "--json",
      "-",
    ]);
  });

  test("rejects unsafe profile and hostile configured args in the constructor", () => {
    expect(
      () => new CodexAdapter({ identity, profile: "../bad" }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );

    const sentinel = new Error("configured args trap must not run");
    let trapCalls = 0;
    const configuredArgs = new Proxy(["--search"], {
      get: () => {
        trapCalls += 1;
        throw sentinel;
      },
    });
    expect(() => new CodexAdapter({ identity, configuredArgs })).toThrowError(
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
    ) as CodexAdapterOptions;
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
      executableRealpath: {
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
      { identity: { ...identity, unknown: true } },
    ]) {
      expect(
        () => new CodexAdapter(options as unknown as CodexAdapterOptions),
      ).toThrow();
    }
    expect(trapCalls).toBe(0);
  });

  test("rejects a proxy-prototype identity with bounded diagnostics and no traps", () => {
    const sentinel = new Error("identity prototype trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const prototype = new Proxy(
      {},
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    );
    const hostileIdentity = Object.create(
      prototype,
      Object.getOwnPropertyDescriptors(identity),
    ) as ProviderIdentity;

    expect(() => new CodexAdapter({ identity: hostileIdentity })).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: "codex provider identity must be exact data",
        recoverable: false,
      }),
    );
    expect(trapCalls).toBe(0);
  });

  test("rejects inexact configured-args arrays without invoking accessors or coercion", () => {
    const sentinel = new Error("configured args hostile code must not run");
    let hostileCalls = 0;
    const trapped = () => {
      hostileCalls += 1;
      throw sentinel;
    };
    const accessorArgs = ["--search"];
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
    const customArgs = new CustomArgs("--search");

    for (const configuredArgs of [accessorArgs, sparseArgs, customArgs]) {
      expect(() => new CodexAdapter({ identity, configuredArgs })).toThrow();
    }
    expect(hostileCalls).toBe(0);
  });

  test("accepts only an own enumerable data-function process runner", () => {
    const sentinel = new Error("process runner accessor must not run");
    let getterCalls = 0;
    const getter = () => {
      getterCalls += 1;
      throw sentinel;
    };
    const accessorOptions = { identity };
    Object.defineProperty(accessorOptions, "processRunner", {
      enumerable: true,
      get: getter,
    });
    const hiddenOptions = { identity };
    Object.defineProperty(hiddenOptions, "processRunner", {
      enumerable: false,
      value: fakeRunner(successEvents).run,
    });

    for (const options of [
      accessorOptions,
      hiddenOptions,
      { identity, processRunner: "not-a-function" },
    ]) {
      expect(
        () => new CodexAdapter(options as unknown as CodexAdapterOptions),
      ).toThrow();
    }
    expect(getterCalls).toBe(0);
  });

  test("fixes the supplied executable identity", () => {
    const source = { ...identity };
    const provider = new CodexAdapter({ identity: source });
    source.executableRealpath = "/changed";

    expect(provider.identity).toEqual(identity);
    expect(Object.isFrozen(provider.identity)).toBe(true);
  });

  test.each([
    [
      "relative path",
      { ...identity, executableRealpath: "relative/codex" },
      "CONFIG_ERROR",
    ],
    [
      "UNC path",
      { ...identity, executableRealpath: "//private/codex" },
      "CONFIG_ERROR",
    ],
    [
      "drive-relative path",
      { ...identity, executableRealpath: "C:codex" },
      "CONFIG_ERROR",
    ],
    [
      "noncanonical path",
      { ...identity, executableRealpath: "/fixtures/../codex" },
      "CONFIG_ERROR",
    ],
    [
      "NUL path",
      { ...identity, executableRealpath: "/safe/codex\0private" },
      "CONFIG_ERROR",
    ],
    [
      "raw version banner",
      { ...identity, version: "codex-cli 0.145.0" },
      "COMPATIBILITY_ERROR",
    ],
    [
      "foreign normalized version",
      { ...identity, version: "9.9.9" },
      "COMPATIBILITY_ERROR",
    ],
  ] as const)(
    "rejects a bypassed provider identity %s before invoking the runner",
    (_name, hostileIdentity, code) => {
      const fixture = fakeRunner(successEvents);

      expect(
        () =>
          new CodexAdapter({
            identity: hostileIdentity,
            processRunner: fixture.run,
          }),
      ).toThrowError(
        expect.objectContaining({
          code,
          recoverable: false,
        }),
      );
      expect(fixture.calls).toHaveLength(0);
    },
  );

  test("adds the structured-output schema after exec", () => {
    expect(
      buildCodexArgv({ model: "gpt-test" }, "/private/tmp/awsl/schema.json"),
    ).toEqual([
      "-m",
      "gpt-test",
      "exec",
      "--json",
      "--output-schema",
      "/private/tmp/awsl/schema.json",
      "-",
    ]);
  });

  test("publishes only capabilities the adapter can actually enforce", () => {
    expect(CODEX_CAPABILITIES).toEqual({
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
      permissionModes: [],
      sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
      skills: false,
      structuredAttemptEvents: false,
      resolvedModelEvents: false,
    });
    expect(Object.isFrozen(CODEX_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(CODEX_CAPABILITIES.tools)).toBe(true);
    expect(Object.isFrozen(CODEX_CAPABILITIES.mcp)).toBe(true);
    expect(Object.isFrozen(CODEX_CAPABILITIES.permissionModes)).toBe(true);
    expect(Object.isFrozen(CODEX_CAPABILITIES.sandboxModes)).toBe(true);
  });

  test.each<[string, NegotiatedAgentPolicy]>([
    [
      "tool allowlist",
      { name: "restricted", instructions: "stay focused", tools: ["Read"] },
    ],
    [
      "empty tool allowlist",
      { name: "restricted", instructions: "stay focused", tools: [] },
    ],
    [
      "tool denylist",
      {
        name: "restricted",
        instructions: "stay focused",
        disallowedTools: ["Bash"],
      },
    ],
    [
      "empty tool denylist",
      {
        name: "restricted",
        instructions: "stay focused",
        disallowedTools: [],
      },
    ],
    [
      "MCP replacement",
      {
        name: "restricted",
        instructions: "stay focused",
        mcp: { demo: { command: "demo" } },
      },
    ],
    [
      "empty MCP replacement",
      {
        name: "restricted",
        instructions: "stay focused",
        mcp: {},
      },
    ],
    [
      "permission mode",
      {
        name: "restricted",
        instructions: "stay focused",
        permissionMode: "dontAsk",
      },
    ],
  ])("fails closed on a named-agent %s", async (_name, agent) => {
    const fixture = fakeRunner(successEvents);
    const adapter = new CodexAdapter({
      identity,
      processRunner: fixture.run,
    });

    await expect(adapter.run(request({ agent }))).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "codex",
      recoverable: false,
    } satisfies Partial<AwslError>);
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects a bypassed skill or malformed policy before schema inspection and launch", async () => {
    const cases = [
      {
        instructions: "stay focused",
        name: "restricted",
        skills: ["unsupported"],
      },
      {
        instructions: "stay focused",
        name: 42,
      },
      {
        instructions: "stay focused",
        name: "restricted",
        sandboxMode: "unrestricted",
      },
      {
        instructions: "stay focused",
        name: "restricted",
        sandboxMode: 1,
      },
    ] as unknown as NegotiatedAgentPolicy[];

    for (const agent of cases) {
      let schemaReads = 0;
      const schema = {};
      Object.defineProperty(schema, "type", {
        enumerable: true,
        get: () => {
          schemaReads += 1;
          return "object";
        },
      });
      const fixture = fakeRunner(successEvents);
      await expect(
        new CodexAdapter({ identity, processRunner: fixture.run }).run(
          request({ agent, schema }),
        ),
      ).rejects.toMatchObject({
        code: "COMPATIBILITY_ERROR",
        provider: "codex",
      });
      expect(schemaReads).toBe(0);
      expect(fixture.calls).toHaveLength(0);
    }
  });

  test.each([
    ["empty model", { model: "" }],
    ["NUL-bearing model", { model: "gpt-safe\0--search" }],
    ["unknown effort", { effort: "ultra" }],
  ] as const)(
    "rejects a %s before schema inspection and launch",
    async (_name, overrides) => {
      const sentinel = new Error("schema trap must not run");
      let schemaTrapCalls = 0;
      const trapped = () => {
        schemaTrapCalls += 1;
        throw sentinel;
      };
      const schema = new Proxy(
        { type: "object" },
        {
          get: trapped,
          getOwnPropertyDescriptor: trapped,
          getPrototypeOf: trapped,
          ownKeys: trapped,
        },
      );
      const fixture = fakeRunner(successEvents);

      await expect(
        new CodexAdapter({ identity, processRunner: fixture.run }).run(
          request({
            ...overrides,
            schema,
          } as Partial<ProviderRequest>),
        ),
      ).rejects.toMatchObject({
        code: "COMPATIBILITY_ERROR",
        provider: "codex",
        recoverable: false,
      });
      expect(schemaTrapCalls).toBe(0);
      expect(fixture.calls).toHaveLength(0);
    },
  );

  test("rejects a proxied policy without invoking traps or launching", async () => {
    const sentinel = new Error("policy proxy trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const agent = new Proxy(
      {
        instructions: "This request must never launch.",
        name: "hostile",
      },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    ) as NegotiatedAgentPolicy;
    const fixture = fakeRunner(successEvents);

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ agent }),
      ),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "codex",
      recoverable: false,
    });
    expect(trapCalls).toBe(0);
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects a proxy-prototype policy with bounded diagnostics and no launch or traps", async () => {
    const sentinel = new Error("policy prototype trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const prototype = new Proxy(
      {},
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    );
    const agent = Object.create(prototype, {
      instructions: {
        enumerable: true,
        value: "This request must never launch.",
      },
      name: {
        enumerable: true,
        value: "hostile",
      },
    }) as NegotiatedAgentPolicy;
    const fixture = fakeRunner(successEvents);

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ agent }),
      ),
    ).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
      message: "Codex agent policy must contain only exact JSON data",
      provider: "codex",
      recoverable: false,
    });
    expect(trapCalls).toBe(0);
    expect(fixture.calls).toHaveLength(0);
  });

  test("consumes a complete event stream and preserves public observations", async () => {
    const rawEvents: unknown[] = [];
    const fixture = fakeRunner(successEvents);
    const adapter = new CodexAdapter({
      identity,
      processRunner: fixture.run,
    });

    await expect(
      adapter.run(
        request({
          effort: "high",
          model: "gpt-5.6-sol",
          onRawEvent: async (event) => {
            await Promise.resolve();
            rawEvents.push(event);
          },
        }),
      ),
    ).resolves.toEqual({
      kind: "completed",
      observation: { threadId: "thread-1" },
      result: {
        effort: "high",
        model: "gpt-5.6-sol",
        text: "ok",
      },
      usage: {
        cachedInputTokens: 3,
        complete: true,
        inputTokens: 11,
        outputTokens: 7,
      },
    });
    expect(rawEvents).toEqual(successEvents);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      argv: [
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "exec",
        "--json",
        "-",
      ],
      cwd: "/workspace",
      executable: "/fixtures/codex",
      prompt: "do the work",
    });
  });

  test("preserves an exact persistence error from the process callback path", async () => {
    const persistence = new AwslError("PERSISTENCE_ERROR", "raw sink failed", {
      recoverable: false,
    });
    const adapter = new CodexAdapter({
      identity,
      processRunner: fakeRunner(successEvents).run,
    });
    const outcome = await adapter.run(
      request({
        onRawEvent: () => {
          throw persistence;
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: "error", error: persistence });
    if (outcome.kind === "error") expect(outcome.error).toBe(persistence);
  });

  test("keeps a top-level error nonterminal when the turn later completes", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "error", message: "transient stream warning" },
      {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "recovered" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request()),
    ).resolves.toMatchObject({
      kind: "completed",
      result: { text: "recovered" },
      usage: { complete: true, outputTokens: 2 },
    });
  });

  test("accepts 0.145.0 initialization warning items before turn.started", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "item.completed",
        item: {
          id: "warning-1",
          message: "Configured service tier was omitted.",
          type: "error",
        },
      },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "message-1", text: "OK", type: "agent_message" },
      },
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 3,
          cache_write_input_tokens: 0,
          input_tokens: 11,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ]);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request()),
    ).resolves.toMatchObject({
      kind: "completed",
      result: { text: "OK" },
      usage: {
        cachedInputTokens: 3,
        complete: true,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 0,
      },
    });
  });

  test("returns turn failures as an error outcome while retaining usage", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "model refused the turn" },
        usage: { input_tokens: 4, output_tokens: 3 },
      },
    ]);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request()),
    ).resolves.toMatchObject({
      error: {
        code: "PROVIDER_ERROR",
        provider: "codex",
      },
      kind: "error",
      usage: {
        complete: true,
        inputTokens: 4,
        outputTokens: 3,
      },
    });
  });

  test("uses the retained top-level error only as a failure fallback", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "error", message: "critical provider detail" },
    ]);

    const outcome = await new CodexAdapter({
      identity,
      processRunner: fixture.run,
    }).run(request());

    expect(outcome).toMatchObject({
      error: { code: "PROVIDER_ERROR" },
      kind: "error",
      usage: { complete: false },
    });
    if (outcome.kind === "error") {
      expect(outcome.error.message).toContain("critical provider detail");
    }
  });

  test("sanitizes ANSI controls and credentials in a top-level error fallback", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "error",
        message:
          "\u001b[31mfailed\u001b[0m\u0007 Authorization: Bearer super-secret-token",
      },
    ]);

    const outcome = await new CodexAdapter({
      identity,
      processRunner: fixture.run,
    }).run(request());

    expect(outcome).toMatchObject({ kind: "error" });
    if (outcome.kind === "error") {
      expect(outcome.error.message).toContain("failed");
      expect(
        Array.from(outcome.error.message).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        }),
      ).toBe(false);
      expect(outcome.error.message).not.toContain("super-secret-token");
      expect(outcome.error.message).toContain("[REDACTED]");
    }
  });

  test.each([
    [
      "AWS secret access key",
      "provider retrying AWS_SECRET_ACCESS_KEY=aws-secret-value after timeout",
      "aws-secret-value",
    ],
    [
      "AWS access key id with mixed case header syntax",
      `provider retrying aws_access_key_id: ${["A", "KIA", "IOSFODNN7EXAMPLE"].join("")} after timeout`,
      ["A", "KIA", "IOSFODNN7EXAMPLE"].join(""),
    ],
    [
      "AWS session token",
      "provider retrying AWS_SESSION_TOKEN = session-token-value after timeout",
      "session-token-value",
    ],
    [
      "X-Amz credential query value with percent encoding",
      "provider retrying https://s3.example/path?X-Amz-Credential=AKIA%2F20260728%2Fap-southeast-1%2Fs3%2Faws4_request&x=1",
      "AKIA%2F20260728%2Fap-southeast-1%2Fs3%2Faws4_request",
    ],
    [
      "X-Amz credential header",
      "provider retrying X-Amz-Credential: AKIA%2Fcredential-value after timeout",
      "AKIA%2Fcredential-value",
    ],
    [
      "X-Amz security token header with percent encoding",
      "provider retrying x-amz-security-token: token%2Fwith%2Bencoding after timeout",
      "token%2Fwith%2Bencoding",
    ],
    [
      "X-Amz security token query value",
      "provider retrying https://s3.example/path?x-amz-security-token=token%2Fquery-value&x=1",
      "token%2Fquery-value",
    ],
    [
      "X-Amz signature header",
      "provider retrying X-Amz-Signature: signature%2Fvalue after timeout",
      "signature%2Fvalue",
    ],
    [
      "X-Amz signature query value",
      "provider retrying https://s3.example/path?X-Amz-Signature=signature%2Fquery-value&x=1",
      "signature%2Fquery-value",
    ],
    [
      "percent-encoded URL userinfo",
      "provider retrying https://user:password%3Avalue%40secret@example.com/path after timeout",
      "user:password%3Avalue%40secret",
    ],
  ])(
    "redacts %s from top-level error fallback",
    async (_label, message, secret) => {
      const fixture = fakeRunner([
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        { type: "error", message },
      ]);

      const outcome = await new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request());

      expect(outcome).toMatchObject({ kind: "error" });
      if (outcome.kind === "error") {
        expect(outcome.error.message).toContain("provider retrying");
        expect(outcome.error.message).toContain("[REDACTED]");
        expect(outcome.error.message).not.toContain(secret);
        expect(outcome.error.message.length).toBeLessThanOrEqual(2_048);
      }
    },
  );

  test.each([
    [
      "unknown event",
      [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "future.event" },
      ],
    ],
    [
      "duplicate terminal",
      [
        ...successEvents,
        { type: "turn.completed", usage: { output_tokens: 8 } },
      ],
    ],
    ["post-terminal event", [...successEvents, { type: "turn.started" }]],
    [
      "EOF without terminal",
      [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
      ],
    ],
  ])("fails closed for %s", async (_name, events) => {
    const fixture = fakeRunner(events);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request()),
    ).resolves.toMatchObject({
      error: {
        code: "PROVIDER_ERROR",
        provider: "codex",
      },
      kind: "error",
    });
  });

  test("treats item.type:error as nonterminal and not as the EOF fallback", async () => {
    const fixture = fakeRunner([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "error-1", type: "error", message: "item detail" },
      },
    ]);

    const outcome = await new CodexAdapter({
      identity,
      processRunner: fixture.run,
    }).run(request());

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.message).not.toContain("item detail");
    }
  });

  test("marks usage indeterminate when output tokens are absent or invalid", async () => {
    const fixture = fakeRunner([
      ...successEvents.slice(0, -1),
      {
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: -1 },
      },
    ]);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(request()),
    ).resolves.toMatchObject({
      kind: "completed",
      usage: {
        complete: false,
        inputTokens: 5,
      },
    });
  });

  test("writes a private structured schema file, parses the final JSON, and cleans up", async () => {
    let schemaPath = "";
    const fixture = fakeRunner(
      successEvents.map((event) =>
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "item.completed" &&
        "item" in event &&
        (event.item as { id?: string }).id === "message-2"
          ? {
              ...event,
              item: {
                ...(event.item as Record<string, unknown>),
                text: '{"answer":42}',
              },
            }
          : event,
      ),
      async (options) => {
        const marker = options.argv.indexOf("--output-schema");
        expect(marker).toBeGreaterThan(-1);
        schemaPath = options.argv[marker + 1] ?? "";
        expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual({
          additionalProperties: false,
          properties: { answer: { type: "number" } },
          required: ["answer"],
          type: "object",
        });
        expect((await lstat(schemaPath)).mode & 0o777).toBe(0o600);
      },
    );
    const adapter = new CodexAdapter({
      identity,
      processRunner: fixture.run,
    });

    await expect(
      adapter.run(
        request({
          schema: {
            additionalProperties: false,
            properties: { answer: { type: "number" } },
            required: ["answer"],
            type: "object",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      result: {
        data: { answer: 42 },
        text: '{"answer":42}',
      },
    });
    await expect(access(schemaPath)).rejects.toThrow();
  });

  test("closes every reachable object required list only in the Codex schema packet", async () => {
    const workflowSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        requiredText: { type: "string" },
        optionalMeta: {
          additionalProperties: false,
          properties: {
            flag: { type: "boolean" },
            note: { type: "string" },
          },
          required: ["flag"],
          type: "object",
        },
        rows: {
          items: {
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          type: "array",
        },
        choice: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                code: { type: "string" },
                detail: { type: "string" },
              },
              required: ["code"],
              type: "object",
            },
            { type: "null" },
          ],
        },
        merged: {
          allOf: [
            {
              additionalProperties: false,
              properties: {
                left: { type: "string" },
                right: { type: "string" },
              },
              required: ["left"],
              type: "object",
            },
          ],
        },
        variant: {
          oneOf: [
            {
              additionalProperties: false,
              properties: {
                first: { type: "string" },
                second: { type: "string" },
              },
              required: ["first"],
              type: "object",
            },
            { type: "null" },
          ],
        },
      },
      required: ["requiredText"],
      type: "object",
      $defs: {
        unused: {
          additionalProperties: false,
          properties: {
            defined: { type: "string" },
            extra: { type: "string" },
          },
          required: ["defined"],
          type: "object",
        },
      },
      definitions: {
        legacy: {
          additionalProperties: false,
          properties: {
            old: { type: "string" },
            optional: { type: "string" },
          },
          required: ["old"],
          type: "object",
        },
      },
    };
    const sourcePacket = JSON.stringify(workflowSchema);
    deepFreezeJson(workflowSchema);
    let schemaPath = "";
    const fixture = fakeRunner(
      successEvents.map((event) =>
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "item.completed" &&
        "item" in event &&
        (event.item as { id?: string }).id === "message-2"
          ? {
              ...event,
              item: {
                ...(event.item as Record<string, unknown>),
                text: '{"requiredText":"present"}',
              },
            }
          : event,
      ),
      async (options) => {
        const marker = options.argv.indexOf("--output-schema");
        schemaPath = options.argv[marker + 1] ?? "";
        const packet = JSON.parse(
          await readFile(schemaPath, "utf8"),
        ) as typeof workflowSchema;

        expect(packet.required).toEqual([
          "requiredText",
          "optionalMeta",
          "rows",
          "choice",
          "merged",
          "variant",
        ]);
        expect(packet.properties.optionalMeta.required).toEqual([
          "flag",
          "note",
        ]);
        expect(packet.properties.rows.items.required).toEqual(["id", "label"]);
        expect(packet.properties.choice.anyOf[0]?.required).toEqual([
          "code",
          "detail",
        ]);
        expect(packet.properties.merged.allOf[0]?.required).toEqual([
          "left",
          "right",
        ]);
        expect(packet.properties.variant.oneOf[0]?.required).toEqual([
          "first",
          "second",
        ]);
        expect(packet.$defs.unused.required).toEqual(["defined", "extra"]);
        expect(packet.definitions.legacy.required).toEqual(["old", "optional"]);
      },
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ schema: workflowSchema }),
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      result: {
        data: { requiredText: "present" },
        text: '{"requiredText":"present"}',
      },
    });
    expect(JSON.stringify(workflowSchema)).toBe(sourcePacket);
    await expect(access(schemaPath)).rejects.toThrow();
  });

  test("rechecks the Codex byte limit after required-list closure", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 2_200 }, (_, index) => [
        `p${String(index).padStart(4, "0")}`,
        { type: "null" },
      ]),
    );
    const schema = {
      additionalProperties: false,
      properties,
      type: "object",
    };
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(64 * 1024);
    const fixture = fakeRunner(successEvents);
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-codex-schema-"),
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ schema }),
      ),
    ).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      provider: "codex",
      recoverable: false,
    });

    expect(fixture.calls).toHaveLength(0);
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-codex-schema-"),
      ),
    ).toEqual(before);
  });

  test("returns SCHEMA_ERROR for a Codex structured result that mismatches the requested schema", async () => {
    const fixture = fakeRunner(
      successEvents.map((event) =>
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "item.completed" &&
        "item" in event &&
        (event.item as { id?: string }).id === "message-2"
          ? {
              ...event,
              item: {
                ...(event.item as Record<string, unknown>),
                text: '{"answer":"not-a-number"}',
              },
            }
          : event,
      ),
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({
          schema: {
            properties: { answer: { type: "number" } },
            required: ["answer"],
            type: "object",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "SCHEMA_ERROR", provider: "codex" },
      observation: { threadId: "thread-1" },
      usage: { complete: true, outputTokens: 7 },
    });
    expect(fixture.calls).toHaveLength(1);
  });

  test("rejects a semantically invalid Codex schema before temporary artifact or process creation", async () => {
    const fixture = fakeRunner(successEvents);
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-codex-schema-"),
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ schema: { type: "not-a-json-schema-type" } }),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_ERROR", provider: "codex" });

    expect(fixture.calls).toHaveLength(0);
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-codex-schema-"),
      ),
    ).toEqual(before);
  });

  test.each([
    [
      "the explicit draft-07 dialect",
      { $schema: "http://json-schema.org/draft-07/schema#", type: "string" },
      '"draft-seven"',
    ],
    [
      "the explicit draft-2020-12 dialect",
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { answer: { type: "number" } },
        required: ["answer"],
        type: "object",
      },
      '{"answer":42}',
    ],
    [
      "the default draft-07 dialect with standard email format",
      { format: "email", type: "string" },
      '"person@example.com"',
    ],
  ])(
    "accepts %s and launches one Codex provider",
    async (_label, schema, text) => {
      const fixture = fakeRunner(
        successEvents.map((event) =>
          event &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "item.completed" &&
          "item" in event &&
          (event.item as { id?: string }).id === "message-2"
            ? {
                ...event,
                item: { ...(event.item as Record<string, unknown>), text },
              }
            : event,
        ),
      );

      await expect(
        new CodexAdapter({ identity, processRunner: fixture.run }).run(
          request({ schema }),
        ),
      ).resolves.toMatchObject({ kind: "completed" });
      expect(fixture.calls).toHaveLength(1);
    },
  );

  test("returns SCHEMA_ERROR when a structured email result fails the standard format", async () => {
    const fixture = fakeRunner(
      successEvents.map((event) =>
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "item.completed" &&
        "item" in event &&
        (event.item as { id?: string }).id === "message-2"
          ? {
              ...event,
              item: {
                ...(event.item as Record<string, unknown>),
                text: '"not-an-email"',
              },
            }
          : event,
      ),
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ schema: { format: "email", type: "string" } }),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "SCHEMA_ERROR", provider: "codex" },
      usage: { complete: true, outputTokens: 7 },
    });
    expect(fixture.calls).toHaveLength(1);
  });

  test("rejects an unknown schema dialect before process creation", async () => {
    const fixture = fakeRunner(successEvents);

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({
          schema: {
            $schema: "https://schemas.example.invalid/draft/future/schema",
            type: "string",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_ERROR", provider: "codex" });
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects an async schema before Codex temporary artifact or process creation", async () => {
    const fixture = fakeRunner(successEvents);
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("awsl-codex-schema-"),
    );

    await expect(
      new CodexAdapter({ identity, processRunner: fixture.run }).run(
        request({ schema: { $async: true, type: "string" } }),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_ERROR", provider: "codex" });

    expect(fixture.calls).toHaveLength(0);
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("awsl-codex-schema-"),
      ),
    ).toEqual(before);
  });

  test("rejects an invalid schema before creating a process", async () => {
    const fixture = fakeRunner(successEvents);

    await expect(
      new CodexAdapter({
        identity,
        processRunner: fixture.run,
      }).run(
        request({
          schema: { type: undefined } as never,
        }),
      ),
    ).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      provider: "codex",
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test("prefixes exact instructions but never falls back to a legacy agent model", async () => {
    const fixture = fakeRunner(successEvents);
    const adapter = new CodexAdapter({
      identity,
      processRunner: fixture.run,
    });
    const legacyAgent = {
      instructions: "Use repository evidence.",
      model: "gpt-agent",
      name: "reviewer",
    } as unknown as NegotiatedAgentPolicy;

    await adapter.run(
      request({
        agent: legacyAgent,
        prompt: " keep leading and trailing space ",
      }),
    );

    expect(fixture.calls[0]?.argv).toEqual(["exec", "--json", "-"]);
    expect(fixture.calls[0]?.prompt).toBe(
      [
        '<awsl-agent name="reviewer">',
        "Use repository evidence.",
        "</awsl-agent>",
        "",
        " keep leading and trailing space ",
      ].join("\n"),
    );
  });

  test("rethrows global cancellation instead of returning an error outcome", async () => {
    const cancellation = new AwslError("CANCELLED", "stop now", {
      recoverable: false,
    });
    const run: ProcessRunner = async () => {
      throw cancellation;
    };

    await expect(
      new CodexAdapter({ identity, processRunner: run }).run(request()),
    ).rejects.toBe(cancellation);
  });

  test("returns sanitized transport failures with the adapter provider identity", async () => {
    const run: ProcessRunner = async () => {
      throw new AwslError("PROVIDER_ERROR", "generic transport failure", {
        recoverable: false,
      });
    };

    await expect(
      new CodexAdapter({ identity, processRunner: run }).run(request()),
    ).resolves.toMatchObject({
      error: {
        code: "PROVIDER_ERROR",
        message: "Codex process transport failed",
        provider: "codex",
        recoverable: false,
      },
      kind: "error",
      usage: { complete: false },
    });
  });
});
