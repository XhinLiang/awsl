import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  awslBehaviorFingerprint,
  modelMapFingerprint,
} from "../../src/config/fingerprints.js";
import {
  type CreateProviderPinInput,
  type RunSourceIdentityV1,
  createProviderPin,
  parseProviderPin,
  parseProviderPinV1,
  resolvedDefaultForImplicitCall,
  transitionImplicitDefaultModel,
  transitionProviderPinSources,
  verifyAndHydrateResumePin,
} from "../../src/config/provider-pin.js";
import type { ResolvedAwslConfig } from "../../src/config/types.js";

const HASH_A: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const HASH_B: `sha256:${string}` = `sha256:${"b".repeat(64)}`;
const HASH_C: `sha256:${string}` = `sha256:${"c".repeat(64)}`;
const HASH_D: `sha256:${string}` = `sha256:${"d".repeat(64)}`;
const HASH_E: `sha256:${string}` = `sha256:${"e".repeat(64)}`;
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function sources(): Record<string, unknown>[] {
  return [
    {
      kind: "agent-registry",
      reference: "reviewer",
      realpath: "/workspace/.claude/agents/reviewer.md",
      sha256: HASH_A,
    },
    {
      kind: "builtin-agent",
      reference: "workflow-subagent",
      realpath: null,
      sha256: HASH_B,
    },
    {
      kind: "config-path",
      reference: ".awsl/config.toml",
      realpath: "/workspace/.awsl/config.toml",
    },
    {
      kind: "plugin-manifest",
      reference: "./plugins/core",
      pluginRootRealpath: "/workspace/plugins/core",
      realpath: "/workspace/plugins/core/plugin.json",
      sha256: HASH_C,
    },
    {
      kind: "workflow-path",
      reference: "./workflow.ts",
      realpath: "/workspace/workflow.ts",
    },
    {
      kind: "workflow-registry",
      reference: "release",
      realpath: "/workspace/.awsl/workflows/release.ts",
    },
  ];
}

function sourceIdentities(): RunSourceIdentityV1[] {
  return sources() as unknown as RunSourceIdentityV1[];
}

function pin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    provider: "codex",
    compatibilityProfile: "claude-code@2.1.218",
    executableRealpath: "/opt/awsl/codex",
    executableVersion: "0.145.0",
    explicitDefaultModel: null,
    resolvedDefaultModel: null,
    providerProfile: "safe-profile",
    canonicalCwd: "/workspace",
    sources: sources(),
    awslBehaviorFingerprint: HASH_A,
    modelMapFingerprint: HASH_D,
    nativeRoutingFingerprint: HASH_E,
    ...overrides,
  };
}

function pinV2(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...pin(),
    version: 2,
    configuredNativeModels: ["private-configured-extension"],
    ...overrides,
  };
}

function resolvedConfig(
  provider: "codex" | "claude" = "codex",
): ResolvedAwslConfig {
  return {
    provider,
    stateDir: "/state/awsl",
    rawProviderEvents: false,
    providers: {
      codex: {
        id: "codex",
        executable: "codex",
        args: [],
        defaultModel: "gpt-5.6-terra",
        nativeModels: ["private-configured-extension"],
        models: {},
        tiers: {
          fast: { model: "gpt-5.6-terra", effort: "low" },
          balanced: { model: "gpt-5.6-terra", effort: "medium" },
          strong: { model: "gpt-5.6-sol", effort: "xhigh" },
        },
        profile: "safe-profile",
      },
      claude: {
        id: "claude",
        executable: "claude",
        args: [],
        nativeModels: [],
        models: {},
        tiers: {
          fast: { model: "haiku", effort: "low" },
          balanced: { model: "sonnet", effort: "medium" },
          strong: { model: "opus", effort: "high" },
        },
      },
    },
    registry: { pluginDirs: [] },
  };
}

async function createPinInput(
  provider: "codex" | "claude" = "codex",
): Promise<CreateProviderPinInput> {
  const created = await mkdtemp(join(tmpdir(), "awsl-provider-pin-"));
  cleanup.push(created);
  const root = await realpath(created);
  const canonicalCwd = join(root, "repo");
  const homeDir = join(root, "home");
  await mkdir(join(canonicalCwd, ".git"), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const config = resolvedConfig(provider);
  return {
    identity: {
      id: provider,
      executableRealpath:
        provider === "codex" ? "/opt/awsl/codex" : "/opt/awsl/claude",
      version: provider === "codex" ? "0.145.0" : "2.1.218",
    },
    config,
    canonicalCwd,
    sources: sourceIdentities().toReversed(),
    enabledPluginRoots: ["/plugins/enabled"],
    homeDir,
    env: {},
  };
}

function configError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "CONFIG_ERROR" &&
    (error as Error & { recoverable?: unknown }).recoverable === false &&
    error.cause === undefined
  );
}

function expectConfigFailure(value: unknown): void {
  expect(() => parseProviderPinV1(value)).toThrowError(
    expect.objectContaining({
      code: "CONFIG_ERROR",
      recoverable: false,
      cause: undefined,
    }),
  );
}

describe("ProviderPinV1 parser", () => {
  test("returns one detached deeply frozen pin covering every source kind", () => {
    const input = pin();
    const originalSources = input.sources as Record<string, unknown>[];
    const parsed = parseProviderPinV1(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.sources).not.toBe(originalSources);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.sources)).toBe(true);
    for (let index = 0; index < parsed.sources.length; index += 1) {
      expect(parsed.sources[index]).not.toBe(originalSources[index]);
      expect(Object.isFrozen(parsed.sources[index])).toBe(true);
    }

    originalSources[0].reference = "mutated";
    originalSources.push({
      kind: "workflow-path",
      reference: "later",
      realpath: "/later",
    });
    input.provider = "claude";
    expect(parsed.provider).toBe("codex");
    expect(parsed.sources).toHaveLength(6);
    expect(parsed.sources[0]?.reference).toBe("reviewer");
    expect(() =>
      (parsed.sources as unknown as Record<string, unknown>[]).push({}),
    ).toThrow();
  });

  test("accepts ordinary null-prototype data and property insertion permutations", () => {
    const input = Object.create(null) as Record<string, unknown>;
    const fixture = pin();
    for (const key of Object.keys(fixture).reverse()) input[key] = fixture[key];
    input.sources = (fixture.sources as Record<string, unknown>[]).map(
      (source) => Object.assign(Object.create(null), source),
    );

    expect(parseProviderPinV1(input)).toEqual(fixture);
  });

  test.each([
    [
      "missing key",
      (() => {
        const value = pin();
        Reflect.deleteProperty(value, "nativeRoutingFingerprint");
        return value;
      })(),
    ],
    ["extra key", { ...pin(), secretCanary: "TOP_SECRET_CANARY" }],
    ["wrong version", pin({ version: 2 })],
    ["wrong provider", pin({ provider: "other" })],
    [
      "wrong compatibility profile",
      pin({ compatibilityProfile: "claude-code@future" }),
    ],
    ["relative executable", pin({ executableRealpath: "bin/codex" })],
    ["noncanonical executable", pin({ executableRealpath: "/opt/../codex" })],
    ["UNC executable", pin({ executableRealpath: "//host/codex" })],
    ["raw executable version", pin({ executableVersion: "codex-cli 0.145.0" })],
    ["foreign executable version", pin({ executableVersion: "2.1.218" })],
    ["relative cwd", pin({ canonicalCwd: "workspace" })],
    ["noncanonical cwd", pin({ canonicalCwd: "/workspace/." })],
    ["bad profile", pin({ providerProfile: "../profile" })],
    [
      "uppercase hash",
      pin({ modelMapFingerprint: `sha256:${"A".repeat(64)}` }),
    ],
    ["short hash", pin({ nativeRoutingFingerprint: "sha256:abcd" })],
    ["hash whitespace", pin({ awslBehaviorFingerprint: `${HASH_A} ` })],
  ])("rejects an invalid top-level contract: %s", (_name, value) => {
    expectConfigFailure(value);
  });

  test("enforces provider-owned profile and normalized version relationships", () => {
    expect(
      parseProviderPinV1(
        pin({
          provider: "claude",
          executableRealpath: "/opt/awsl/claude",
          executableVersion: "2.1.218",
          providerProfile: null,
        }),
      ),
    ).toMatchObject({
      provider: "claude",
      executableVersion: "2.1.218",
      providerProfile: null,
    });

    expectConfigFailure(
      pin({
        provider: "claude",
        executableRealpath: "/opt/awsl/claude",
        executableVersion: "2.1.218",
        providerProfile: "profile",
      }),
    );
  });

  test.each([
    [
      "path source with a hash",
      {
        kind: "workflow-path",
        reference: "./workflow.ts",
        realpath: "/workspace/workflow.ts",
        sha256: HASH_A,
      },
    ],
    [
      "agent without a hash",
      {
        kind: "agent-registry",
        reference: "reviewer",
        realpath: "/workspace/reviewer.md",
      },
    ],
    [
      "agent with plugin root",
      {
        kind: "agent-registry",
        reference: "reviewer",
        realpath: "/workspace/reviewer.md",
        pluginRootRealpath: "/workspace/plugin",
        sha256: HASH_A,
      },
    ],
    [
      "plugin without root",
      {
        kind: "plugin-manifest",
        reference: "./plugin",
        realpath: "/workspace/plugin/plugin.json",
        sha256: HASH_A,
      },
    ],
    [
      "builtin with another reference",
      {
        kind: "builtin-agent",
        reference: "other",
        realpath: null,
        sha256: HASH_A,
      },
    ],
    [
      "builtin with a realpath",
      {
        kind: "builtin-agent",
        reference: "workflow-subagent",
        realpath: "/builtin",
        sha256: HASH_A,
      },
    ],
    [
      "non-builtin with null realpath",
      {
        kind: "config-path",
        reference: "config",
        realpath: null,
      },
    ],
    [
      "unknown kind",
      {
        kind: "other",
        reference: "value",
        realpath: "/workspace/value",
      },
    ],
  ])("rejects an invalid source variant: %s", (_name, source) => {
    expectConfigFailure(pin({ sources: [source] }));
  });

  test("validates UTF-8 source ordering instead of UTF-16 ordering", () => {
    const utf8Ordered = [
      {
        kind: "config-path",
        reference: "\uE000",
        realpath: "/workspace/e000",
      },
      {
        kind: "config-path",
        reference: "\u{10000}",
        realpath: "/workspace/10000",
      },
    ];
    expect(parseProviderPinV1(pin({ sources: utf8Ordered })).sources).toEqual(
      utf8Ordered,
    );
    expectConfigFailure(pin({ sources: [...utf8Ordered].reverse() }));
  });

  test("rejects unsorted and every repeated kind/reference identity", () => {
    expectConfigFailure(pin({ sources: [...sources()].reverse() }));
    const identical = {
      kind: "config-path",
      reference: "same",
      realpath: "/workspace/a",
    };
    expectConfigFailure(pin({ sources: [identical, { ...identical }] }));
    expectConfigFailure(
      pin({
        sources: [identical, { ...identical, realpath: "/workspace/b" }],
      }),
    );
    expect(() =>
      parseProviderPinV1(
        pin({
          sources: [
            {
              kind: "config-path",
              reference: "same",
              realpath: "/workspace/a",
            },
            {
              kind: "workflow-path",
              reference: "same",
              realpath: "/workspace/b",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  test("rejects NUL and lone-surrogate strings before bytewise comparison", () => {
    expectConfigFailure(
      pin({
        sources: [
          {
            kind: "config-path",
            reference: "private\0reference",
            realpath: "/workspace/source",
          },
        ],
      }),
    );
    expectConfigFailure(
      pin({
        sources: [
          {
            kind: "config-path",
            reference: "\uD800",
            realpath: "/workspace/source",
          },
        ],
      }),
    );
  });

  test.each([
    [null, null, true],
    ["configured-custom", "configured-custom", true],
    ["configured-custom", null, false],
    ["configured-custom", "different", false],
    [null, "gpt-5.6-terra", true],
    [null, "codex-special", true],
    [null, "sonnet", false],
    [null, "configured-extension", false],
    [null, "", false],
    [null, "private\0model", false],
  ])(
    "validates Codex default relationship %j/%j",
    (explicitDefaultModel, resolvedDefaultModel, accepted) => {
      const value = pin({ explicitDefaultModel, resolvedDefaultModel });
      if (accepted) expect(() => parseProviderPinV1(value)).not.toThrow();
      else expectConfigFailure(value);
    },
  );

  test("uses the selected provider base native recognizer for discovery", () => {
    expect(() =>
      parseProviderPinV1(
        pin({
          provider: "claude",
          executableRealpath: "/opt/awsl/claude",
          executableVersion: "2.1.218",
          providerProfile: null,
          explicitDefaultModel: null,
          resolvedDefaultModel: "sonnet",
        }),
      ),
    ).not.toThrow();
    expectConfigFailure(
      pin({
        provider: "claude",
        executableRealpath: "/opt/awsl/claude",
        executableVersion: "2.1.218",
        providerProfile: null,
        explicitDefaultModel: null,
        resolvedDefaultModel: "gpt-5.6-terra",
      }),
    );
  });

  test("rejects proxies, accessors, symbols, and proxy prototypes without hooks", () => {
    let hookCalls = 0;
    const trap = () => {
      hookCalls += 1;
      throw new Error("hostile hook must not run");
    };
    const proxiedPin = new Proxy(pin(), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    expectConfigFailure(proxiedPin);

    const accessorPin = pin();
    Object.defineProperty(accessorPin, "provider", {
      enumerable: true,
      get: trap,
    });
    expectConfigFailure(accessorPin);

    const proxiedSourcePrototype = new Proxy(Object.prototype, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    const hostileSource = sources()[0];
    Object.setPrototypeOf(hostileSource, proxiedSourcePrototype);
    expectConfigFailure(pin({ sources: [hostileSource] }));

    const symbolPin = pin();
    Object.defineProperty(symbolPin, Symbol("secret"), {
      enumerable: false,
      value: "PRIVATE_SYMBOL_SECRET",
    });
    expectConfigFailure(symbolPin);
    expect(hookCalls).toBe(0);
  });

  test("rejects hidden fields, custom arrays, holes, index accessors, and aliases", () => {
    const hidden = pin();
    Object.defineProperty(hidden, "hiddenSecret", {
      enumerable: false,
      value: "PRIVATE_HIDDEN_SECRET",
    });
    expectConfigFailure(hidden);

    class CustomSources extends Array<Record<string, unknown>> {}
    const custom = new CustomSources(...sources());
    expectConfigFailure(pin({ sources: custom }));

    const sparse = [sources()[0], sources()[1]];
    sparse.length = 3;
    expectConfigFailure(pin({ sources: sparse }));

    const withExtra = sources();
    Object.defineProperty(withExtra, "privateExtra", {
      enumerable: false,
      value: "PRIVATE_ARRAY_SECRET",
    });
    expectConfigFailure(pin({ sources: withExtra }));

    let getterCalls = 0;
    const accessorArray = sources();
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("array getter must not run");
      },
    });
    expectConfigFailure(pin({ sources: accessorArray }));
    expect(getterCalls).toBe(0);

    const shared = {
      kind: "config-path",
      reference: "same",
      realpath: "/workspace/same",
    };
    expectConfigFailure(pin({ sources: [shared, shared] }));

    const circular = pin();
    circular.circular = circular;
    expectConfigFailure(circular);
  });
});

describe("ProviderPinV2 parser", () => {
  test("captures configured native models for a discovered default", () => {
    const parsed = parseProviderPin(
      pinV2({ resolvedDefaultModel: "private-configured-extension" }),
    );

    expect(parsed).toMatchObject({
      version: 2,
      configuredNativeModels: ["private-configured-extension"],
      resolvedDefaultModel: "private-configured-extension",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      Object.isFrozen(
        (parsed as { configuredNativeModels: readonly string[] })
          .configuredNativeModels,
      ),
    ).toBe(true);
    expect(() =>
      parseProviderPinV1(
        pinV2({ resolvedDefaultModel: "private-configured-extension" }),
      ),
    ).toThrow();
  });

  test.each([
    [["z", "a"], "unsorted"],
    [
      ["private-configured-extension", "private-configured-extension"],
      "duplicate",
    ],
    [[""], "empty"],
    [["bad\0model"], "NUL"],
    [["\uD800"], "surrogate"],
  ])("rejects an invalid configured-native list: %s", (models) => {
    expect(() =>
      parseProviderPin(pinV2({ configuredNativeModels: models })),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_ERROR" }));
  });

  test("rejects a discovered model outside the captured configured list", () => {
    expect(() =>
      parseProviderPin(
        pinV2({ resolvedDefaultModel: "private-other-extension" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_ERROR" }));
  });
});

describe("ProviderPinV1 resume verification", () => {
  test.each([
    [
      "provider",
      {
        provider: "claude",
        executableRealpath: "/opt/awsl/claude",
        executableVersion: "2.1.218",
        providerProfile: null,
      },
    ],
    ["executableRealpath", { executableRealpath: "/opt/awsl/other-codex" }],
    [
      "explicitDefaultModel",
      {
        explicitDefaultModel: "configured-custom",
        resolvedDefaultModel: "configured-custom",
      },
    ],
    ["providerProfile", { providerProfile: "other-profile" }],
    ["canonicalCwd", { canonicalCwd: "/other-workspace" }],
    [
      "sources",
      {
        sources: sources().map((source, index) =>
          index === 0 ? { ...source, sha256: HASH_E } : source,
        ),
      },
    ],
    ["awslBehaviorFingerprint", { awslBehaviorFingerprint: HASH_B }],
    ["modelMapFingerprint", { modelMapFingerprint: HASH_B }],
    ["nativeRoutingFingerprint", { nativeRoutingFingerprint: HASH_B }],
  ])("rejects a static %s mismatch without values", (field, overrides) => {
    const canary = "/PRIVATE/STATIC/CANARY";
    const current = pin(overrides);
    if (field === "canonicalCwd") current.canonicalCwd = canary;
    let failure: unknown;
    try {
      verifyAndHydrateResumePin(pin(), current);
    } catch (error) {
      failure = error;
    }
    expect(failure).toSatisfy(configError);
    expect(String(failure)).toContain(field);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  test("strictly parses current input before comparing any static field", () => {
    const current = pin({
      provider: "claude",
      executableRealpath: "/opt/awsl/claude",
      executableVersion: "2.1.218",
      providerProfile: null,
      modelMapFingerprint: "sha256:PRIVATE_INVALID_HASH",
    });
    expect(() => verifyAndHydrateResumePin(pin(), current)).toThrowError(
      expect.not.objectContaining({
        message: expect.stringContaining("mismatch: provider"),
      }),
    );
  });

  test("hydrates only the stored discovered default after static equality", () => {
    const stored = pin({
      explicitDefaultModel: null,
      resolvedDefaultModel: "gpt-5.6-sol",
    });
    const current = pin({
      explicitDefaultModel: null,
      resolvedDefaultModel: null,
    });
    const hydrated = verifyAndHydrateResumePin(stored, current);
    expect(hydrated.resolvedDefaultModel).toBe("gpt-5.6-sol");
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(Object.isFrozen(hydrated.sources)).toBe(true);
    expect(hydrated).not.toBe(current);

    const nullStored = pin({
      explicitDefaultModel: null,
      resolvedDefaultModel: null,
    });
    const ambientCurrent = pin({
      explicitDefaultModel: null,
      resolvedDefaultModel: "gpt-5.6-terra",
    });
    expect(
      verifyAndHydrateResumePin(nullStored, ambientCurrent)
        .resolvedDefaultModel,
    ).toBeNull();
  });

  test("accepts independently allocated equivalent sources and explicit defaults", () => {
    const stored = pin({
      explicitDefaultModel: "configured-custom",
      resolvedDefaultModel: "configured-custom",
    });
    const current = pin({
      explicitDefaultModel: "configured-custom",
      resolvedDefaultModel: "configured-custom",
      sources: sources(),
    });
    expect(verifyAndHydrateResumePin(stored, current)).toEqual(current);
  });

  test("hydrates only a V2 captured configured-native default", () => {
    const stored = pinV2({
      resolvedDefaultModel: "private-configured-extension",
    });
    const current = pinV2();
    expect(
      verifyAndHydrateResumePin(stored, current).resolvedDefaultModel,
    ).toBe("private-configured-extension");
    expect(() =>
      verifyAndHydrateResumePin(
        stored,
        pinV2({ configuredNativeModels: ["private-other-extension"] }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: expect.stringContaining("configuredNativeModels"),
      }),
    );
  });

  test("upgrades a legacy V1 base-native default but rejects a downgrade", () => {
    const upgraded = verifyAndHydrateResumePin(
      pin({ resolvedDefaultModel: "gpt-5.6-sol" }),
      pinV2(),
    );
    expect(upgraded).toMatchObject({
      version: 2,
      configuredNativeModels: ["private-configured-extension"],
      resolvedDefaultModel: "gpt-5.6-sol",
    });
    expect(() => verifyAndHydrateResumePin(pinV2(), pin())).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: "provider pin mismatch: version",
      }),
    );
  });
});

describe("ProviderPinV1 static assembly", () => {
  test("derives selected identity, explicit default, profile, and all fingerprints", async () => {
    const input = await createPinInput();
    const built = await createProviderPin(input);

    expect(built).toMatchObject({
      version: 2,
      provider: "codex",
      compatibilityProfile: "claude-code@2.1.218",
      executableRealpath: "/opt/awsl/codex",
      executableVersion: "0.145.0",
      explicitDefaultModel: "gpt-5.6-terra",
      resolvedDefaultModel: "gpt-5.6-terra",
      providerProfile: "safe-profile",
      canonicalCwd: input.canonicalCwd,
      configuredNativeModels: ["private-configured-extension"],
    });
    expect(built.awslBehaviorFingerprint).toBe(
      awslBehaviorFingerprint({
        config: input.config,
        enabledPluginRoots: input.enabledPluginRoots,
      }),
    );
    expect(built.modelMapFingerprint).toBe(modelMapFingerprint(input.config));
    expect(built.nativeRoutingFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(built.sources).toEqual(sources());
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.sources)).toBe(true);
    expect(Object.isFrozen(built.configuredNativeModels)).toBe(true);
  });

  test("derives null Claude profile and default without accepting a caller override", async () => {
    const input = await createPinInput("claude");
    const built = await createProviderPin({ ...input, sources: [] });
    expect(built).toMatchObject({
      version: 2,
      provider: "claude",
      explicitDefaultModel: null,
      resolvedDefaultModel: null,
      providerProfile: null,
      configuredNativeModels: [],
    });
  });

  test("deduplicates identical source resolutions and rejects identity drift", async () => {
    const base = await createPinInput();
    const duplicate = sourceIdentities()[0] as RunSourceIdentityV1;
    if (duplicate.kind !== "agent-registry")
      throw new TypeError("fixture source order changed");
    const input: CreateProviderPinInput = {
      ...base,
      sources: [duplicate, duplicate, ...sourceIdentities(), { ...duplicate }],
    };
    expect((await createProviderPin(input)).sources).toEqual(sources());
    await expect(
      createProviderPin({
        ...input,
        sources: [
          ...sourceIdentities(),
          {
            ...duplicate,
            realpath: "/workspace/.claude/agents/drifted.md",
          },
        ],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: "provider pin source identity drift",
      }),
    );
  });

  test("rejects identity/provider mismatch and hostile hooks", async () => {
    const base = await createPinInput();
    await expect(
      createProviderPin({
        ...base,
        identity: {
          id: "claude",
          executableRealpath: "/opt/awsl/claude",
          version: "2.1.218",
        },
      }),
    ).rejects.toThrowError(/identity does not match/i);

    let hookCalls = 0;
    const trap = () => {
      hookCalls += 1;
      throw new Error("must not invoke");
    };
    await expect(
      createProviderPin(
        new Proxy(base, {
          get: trap,
          getOwnPropertyDescriptor: trap,
          getPrototypeOf: trap,
          ownKeys: trap,
        }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "CONFIG_ERROR" }));
    expect(hookCalls).toBe(0);
  });

  test("computes every fingerprint from one current input and ignores unlisted secrets", async () => {
    const base = await createPinInput();
    const baseline = await createProviderPin(base);
    const changedConfig = structuredClone(base.config);
    changedConfig.rawProviderEvents = true;
    const behaviorChanged = await createProviderPin({
      ...base,
      config: changedConfig,
    });
    const rootsChanged = await createProviderPin({
      ...base,
      enabledPluginRoots: ["/plugins/other"],
    });
    const nativeChanged = await createProviderPin({
      ...base,
      env: { OPENAI_PROJECT: "other-project" },
    });
    const secret = "PRIVATE_PROVIDER_PIN_SECRET";
    const secretOnly = await createProviderPin({
      ...base,
      env: {
        OPENAI_API_KEY: secret,
        AWS_SECRET_ACCESS_KEY: secret,
      },
    });

    expect(behaviorChanged.awslBehaviorFingerprint).not.toBe(
      baseline.awslBehaviorFingerprint,
    );
    expect(behaviorChanged.modelMapFingerprint).toBe(
      baseline.modelMapFingerprint,
    );
    expect(rootsChanged.awslBehaviorFingerprint).not.toBe(
      baseline.awslBehaviorFingerprint,
    );
    expect(nativeChanged.nativeRoutingFingerprint).not.toBe(
      baseline.nativeRoutingFingerprint,
    );
    expect(secretOnly.nativeRoutingFingerprint).toBe(
      baseline.nativeRoutingFingerprint,
    );
    expect(JSON.stringify(secretOnly)).not.toContain(secret);
  });

  test("rejects a secret-bearing native routing URL without persisting a pin", async () => {
    const base = await createPinInput();
    const canary = "PRIVATE_NATIVE_QUERY_SECRET";
    let failure: unknown;
    try {
      await createProviderPin({
        ...base,
        env: {
          OPENAI_BASE_URL: `https://host/v1?api_key=${canary}`,
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toSatisfy(configError);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });
});

describe("implicit provider default transition", () => {
  test("ignores every non-implicit source without inspecting resolvedModel", () => {
    const sources = [
      "native",
      "configured-default",
      "tier:fast",
      "tier:balanced",
      "tier:strong",
      "exact:quality",
    ] as const;
    let getterCalls = 0;
    for (const modelSource of sources) {
      const observation = { modelSource } as {
        modelSource: (typeof sources)[number];
        resolvedModel?: string;
      };
      Object.defineProperty(observation, "resolvedModel", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error("must not inspect an explicit observation");
        },
      });
      const transition = transitionImplicitDefaultModel(pin(), observation);
      expect(transition.changed).toBe(false);
      expect(transition.pin.resolvedDefaultModel).toBeNull();
    }
    expect(getterCalls).toBe(0);
  });

  test("keeps fingerprint-only null, then stores one detached frozen public default", () => {
    const missing = transitionImplicitDefaultModel(pin(), {
      modelSource: "implicit",
    });
    expect(missing).toMatchObject({
      changed: false,
      pin: { resolvedDefaultModel: null },
    });

    const original = pin();
    const discovered = transitionImplicitDefaultModel(original, {
      modelSource: "implicit",
      resolvedModel: "gpt-5.6-sol",
    });
    expect(original.resolvedDefaultModel).toBeNull();
    expect(discovered).toMatchObject({
      changed: true,
      pin: { resolvedDefaultModel: "gpt-5.6-sol" },
    });
    expect(Object.isFrozen(discovered)).toBe(true);
    expect(Object.isFrozen(discovered.pin)).toBe(true);
    expect(Object.isFrozen(discovered.pin.sources)).toBe(true);

    expect(
      transitionImplicitDefaultModel(discovered.pin, {
        modelSource: "implicit",
        resolvedModel: "gpt-5.6-sol",
      }),
    ).toMatchObject({ changed: false });
  });

  test("stores a configured native default only when captured by V2", () => {
    const transition = transitionImplicitDefaultModel(pinV2(), {
      modelSource: "implicit",
      resolvedModel: "private-configured-extension",
    });
    expect(transition).toMatchObject({
      changed: true,
      pin: {
        version: 2,
        configuredNativeModels: ["private-configured-extension"],
        resolvedDefaultModel: "private-configured-extension",
      },
    });
    expect(() =>
      transitionImplicitDefaultModel(pinV2(), {
        modelSource: "implicit",
        resolvedModel: "private-other-extension",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "COMPATIBILITY_ERROR",
        message: "observed provider default is invalid",
      }),
    );
  });

  test("adds provider sources immutably, collapses agreement, and rejects drift", () => {
    const original = parseProviderPinV1(pin());
    const addition: RunSourceIdentityV1 = {
      kind: "workflow-path",
      reference: "./new-workflow.ts",
      realpath: "/workspace/new-workflow.ts",
    };
    const added = transitionProviderPinSources(original, [addition]);

    expect(added.changed).toBe(true);
    expect(added.pin.sources).toContainEqual(addition);
    expect(original.sources).not.toContainEqual(addition);
    expect(Object.isFrozen(added.pin.sources)).toBe(true);
    expect(transitionProviderPinSources(added.pin, [addition])).toMatchObject({
      changed: false,
    });
    expect(() =>
      transitionProviderPinSources(added.pin, [
        { ...addition, realpath: "/workspace/drifted.ts" },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        message: "provider pin source identity drift",
      }),
    );
  });

  test("an explicit default is immutable and does not inspect an implicit observation", () => {
    let getterCalls = 0;
    const observation = { modelSource: "implicit" as const };
    Object.defineProperty(observation, "resolvedModel", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not inspect");
      },
    });
    const explicit = pin({
      explicitDefaultModel: "configured-custom",
      resolvedDefaultModel: "configured-custom",
    });
    expect(transitionImplicitDefaultModel(explicit, observation)).toMatchObject(
      {
        changed: false,
        pin: { resolvedDefaultModel: "configured-custom" },
      },
    );
    expect(getterCalls).toBe(0);
  });

  test.each([
    ["foreign", "sonnet"],
    ["configured extension only", "private-configured-extension"],
    ["empty", ""],
    ["NUL", "gpt-private\0model"],
    ["lone surrogate", "\uD800"],
  ])("rejects an invalid public default: %s", (_name, resolvedModel) => {
    expect(() =>
      transitionImplicitDefaultModel(pin(), {
        modelSource: "implicit",
        resolvedModel,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "COMPATIBILITY_ERROR",
        recoverable: false,
      }),
    );
  });

  test("rejects a conflicting observation without exposing either model", () => {
    const canary = "codex-PRIVATE_DEFAULT_CANARY";
    let failure: unknown;
    try {
      transitionImplicitDefaultModel(
        pin({ resolvedDefaultModel: "gpt-5.6-sol" }),
        {
          modelSource: "implicit",
          resolvedModel: canary,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "COMPATIBILITY_ERROR",
      message: "provider default observation conflict",
      recoverable: false,
      cause: undefined,
    });
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(String(failure)).not.toContain("gpt-5.6-sol");
  });

  test("injects a hydrated default only into an otherwise implicit call", () => {
    const discovered = pin({ resolvedDefaultModel: "gpt-5.6-sol" });
    expect(resolvedDefaultForImplicitCall(discovered, "implicit")).toBe(
      "gpt-5.6-sol",
    );
    for (const source of [
      "native",
      "configured-default",
      "tier:fast",
      "tier:balanced",
      "tier:strong",
      "exact:quality",
    ] as const)
      expect(
        resolvedDefaultForImplicitCall(discovered, source),
      ).toBeUndefined();
    expect(resolvedDefaultForImplicitCall(pin(), "implicit")).toBeUndefined();
  });
});
