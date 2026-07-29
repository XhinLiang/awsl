import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  type NativeRoutingFingerprintInput,
  nativeRoutingFingerprint,
} from "../../src/config/native-routing.js";
import { canonicalJson } from "../../src/core/canonical-json.js";

interface NativeFixture {
  readonly root: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly homeDir: string;
  readonly input: NativeRoutingFingerprintInput;
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  provider: "codex" | "claude" = "codex",
): Promise<NativeFixture> {
  const root = await mkdtemp(join(tmpdir(), "awsl-native-routing-"));
  cleanup.push(root);
  const physicalRoot = await realpath(root);
  const cwd = join(physicalRoot, "repo");
  const homeDir = join(physicalRoot, "home");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return {
    root: physicalRoot,
    cwd,
    projectRoot: cwd,
    homeDir,
    input: {
      provider,
      providerVersion: provider === "codex" ? "0.145.0" : "2.1.218",
      canonicalCwd: cwd,
      homeDir,
      env: {},
      safeArgs: [],
    },
  };
}

async function writeNative(path: string, source: string | Uint8Array) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function expectConfigError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "CONFIG_ERROR" &&
    (error as Error & { recoverable?: unknown }).recoverable === false &&
    error.cause === undefined
  );
}

describe("native routing fingerprint input and ABI", () => {
  test("locks the Codex all-missing layer ABI to a canonical golden", async () => {
    const value = await fixture();
    const expected = sha256([
      "awsl-native-routing:v1",
      ["provider", "codex", "0.145.0"],
      [
        "layer",
        "codex-cli@0.145.0/config:base/v1",
        join(value.homeDir, ".codex", "config.toml"),
        "missing",
        null,
        null,
      ],
      [
        "layer",
        "codex-cli@0.145.0/config:project/v1",
        join(value.projectRoot, ".codex", "config.toml"),
        "missing",
        null,
        null,
      ],
      [
        "environment",
        "codex-cli@0.145.0/env/v1",
        [
          ["OPENAI_BASE_URL", "missing", null],
          ["OPENAI_ORGANIZATION", "missing", null],
          ["OPENAI_PROJECT", "missing", null],
        ],
      ],
      ["safe-args", "codex-cli@0.145.0/args/v1", []],
      ["profile", "codex-cli@0.145.0/profile/v1", null],
    ]);

    await expect(nativeRoutingFingerprint(value.input)).resolves.toBe(expected);
  });

  test("locks the Claude all-missing layer ABI and fixed order", async () => {
    const value = await fixture("claude");
    const environment = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "CLOUD_ML_REGION",
      "ANTHROPIC_VERTEX_PROJECT_ID",
    ].map((name) => [name, "missing", null]);
    const expected = sha256([
      "awsl-native-routing:v1",
      ["provider", "claude", "2.1.218"],
      [
        "layer",
        "claude-code@2.1.218/settings:user/v1",
        join(value.homeDir, ".claude", "settings.json"),
        "missing",
        null,
        null,
      ],
      [
        "layer",
        "claude-code@2.1.218/settings:project/v1",
        join(value.projectRoot, ".claude", "settings.json"),
        "missing",
        null,
        null,
      ],
      [
        "layer",
        "claude-code@2.1.218/settings:project-local/v1",
        join(value.projectRoot, ".claude", "settings.local.json"),
        "missing",
        null,
        null,
      ],
      ["environment", "claude-code@2.1.218/env/v1", environment],
      ["safe-args", "claude-code@2.1.218/args/v1", []],
    ]);

    await expect(nativeRoutingFingerprint(value.input)).resolves.toBe(expected);
  });

  test("validates exact input, version, args, and provider-owned profile before file reads", async () => {
    const value = await fixture();
    const canary = join(value.homeDir, ".codex", "config.toml");
    await writeNative(canary, "this is malformed");

    await expect(
      nativeRoutingFingerprint({
        ...value.input,
        safeArgs: ["--model", "secret"],
      }),
    ).rejects.toSatisfy(expectConfigError);
    await expect(
      nativeRoutingFingerprint({
        ...value.input,
        providerVersion: "0.146.0",
      }),
    ).rejects.toMatchObject({ code: "COMPATIBILITY_ERROR" });
    await expect(
      nativeRoutingFingerprint({
        ...value.input,
        secret: "TOP_LEVEL_SECRET",
      } as unknown as NativeRoutingFingerprintInput),
    ).rejects.toSatisfy(expectConfigError);

    const claude = await fixture("claude");
    await expect(
      nativeRoutingFingerprint({ ...claude.input, profile: "not-allowed" }),
    ).rejects.toSatisfy(expectConfigError);
  });

  test("hashes safe args in exact order and the selected Codex profile separately", async () => {
    const value = await fixture();
    const baseline = await nativeRoutingFingerprint(value.input);
    const first = await nativeRoutingFingerprint({
      ...value.input,
      safeArgs: ["--search", "--strict-config"],
    });
    const reversed = await nativeRoutingFingerprint({
      ...value.input,
      safeArgs: ["--strict-config", "--search"],
    });
    const profiled = await nativeRoutingFingerprint({
      ...value.input,
      profile: "work",
    });

    expect(first).not.toBe(baseline);
    expect(reversed).not.toBe(first);
    expect(profiled).not.toBe(baseline);
  });

  test("hashes a configured Codex profile layer and still inspects excluded Claude layers", async () => {
    const codex = await fixture();
    const profilePath = join(codex.homeDir, ".codex", "work.config.toml");
    await writeNative(profilePath, 'model = "gpt-5.6-sol"\n');
    const profiled = await nativeRoutingFingerprint({
      ...codex.input,
      profile: "work",
    });
    await writeNative(profilePath, 'model = "gpt-5.6-terra"\n');
    expect(
      await nativeRoutingFingerprint({ ...codex.input, profile: "work" }),
    ).not.toBe(profiled);

    const claude = await fixture("claude");
    await writeNative(
      join(claude.homeDir, ".claude", "settings.json"),
      '{"model":',
    );
    await expect(
      nativeRoutingFingerprint({
        ...claude.input,
        safeArgs: ["--setting-sources=project"],
      }),
    ).rejects.toSatisfy(expectConfigError);
  });
});

describe("Codex native routing projection", () => {
  test("projects every allowlisted scalar and sorted model-provider field", async () => {
    const value = await fixture();
    const path = join(value.homeDir, ".codex", "config.toml");
    await writeNative(
      path,
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "private"',
        'model_reasoning_effort = "high"',
        'service_tier = "priority"',
        "[model_providers.z]",
        'name = "Zed"',
        'base_url = "https://z.example/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "[model_providers.a]",
        'name = "Aye"',
      ].join("\n"),
    );
    const baseline = await nativeRoutingFingerprint(value.input);

    await writeNative(
      path,
      [
        'service_tier = "priority"',
        'model_reasoning_effort = "high"',
        'model_provider = "private"',
        'model = "gpt-5.6-sol"',
        "[model_providers.a]",
        'name = "Aye"',
        "[model_providers.z]",
        "requires_openai_auth = true",
        'wire_api = "responses"',
        'base_url = "https://z.example/v1"',
        'name = "Zed"',
      ].join("\n"),
    );
    expect(await nativeRoutingFingerprint(value.input)).toBe(baseline);

    await writeNative(
      path,
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "private"',
        'model_reasoning_effort = "high"',
        'service_tier = "priority"',
        "[model_providers.z]",
        'name = "Changed"',
        'base_url = "https://z.example/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "[model_providers.a]",
        'name = "Aye"',
      ].join("\n"),
    );
    expect(await nativeRoutingFingerprint(value.input)).not.toBe(baseline);
  });

  test("ignores unknown secret fields without hashing their values", async () => {
    const value = await fixture();
    const path = join(value.homeDir, ".codex", "config.toml");
    const canary = "CODEX_NATIVE_SECRET_CANARY";
    await writeNative(
      path,
      `model = "gpt-5.6-sol"\nsecret = "${canary}"\nunknown = inf\n`,
    );
    const baseline = await nativeRoutingFingerprint(value.input);
    await writeNative(
      path,
      'unknown = -inf\nsecret = "OTHER_SECRET"\nmodel = "gpt-5.6-sol"\n',
    );
    expect(await nativeRoutingFingerprint(value.input)).toBe(baseline);
    expect(baseline).not.toContain(
      createHash("sha256").update(canary).digest("hex"),
    );
  });

  test.each([
    ['base_url = "https://user:pass@example.test/v1"', "userinfo"],
    ['base_url = "https://example.test/v1?token=secret"', "query"],
    ['base_url = "https://example.test/v1#secret"', "fragment"],
    ['base_url = "file:///tmp/socket"', "scheme"],
    ['base_url = "/relative"', "relative"],
  ])("rejects a model-provider URL containing %s", async (line) => {
    const value = await fixture();
    const path = join(value.homeDir, ".codex", "config.toml");
    await writeNative(path, `[model_providers.private]\n${line}\n`);
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
  });

  test("accepts HTTP(S) host, IPv6, port, path, and encoded delimiters", async () => {
    const value = await fixture();
    const path = join(value.homeDir, ".codex", "config.toml");
    await writeNative(
      path,
      '[model_providers.private]\nbase_url = "https://[::1]:8443/v1/%3F/%23"\n',
    );
    await expect(nativeRoutingFingerprint(value.input)).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  test.each([
    ["duplicate key", 'model = "a"\nmodel = "b"\n'],
    ["wrong model type", "model = 42\n"],
    ["wrong provider table", 'model_providers = "not-a-table"\n'],
    [
      "wrong auth type",
      '[model_providers.private]\nrequires_openai_auth = "true"\n',
    ],
  ])("fails closed for %s with bounded diagnostics", async (_name, source) => {
    const value = await fixture();
    const path = join(value.homeDir, ".codex", "config.toml");
    const canary = "CODEx_DIAGNOSTIC_CANARY";
    await writeNative(path, `${source}# ${canary}\n`);
    let failure: unknown;
    try {
      await nativeRoutingFingerprint(value.input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toSatisfy(expectConfigError);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });
});

describe("Claude native routing projection", () => {
  test("projects model and all four effort levels without merging layers", async () => {
    const value = await fixture("claude");
    const user = join(value.homeDir, ".claude", "settings.json");
    const project = join(value.projectRoot, ".claude", "settings.json");
    await writeNative(user, '{"model":"sonnet","effortLevel":"xhigh"}');
    const baseline = await nativeRoutingFingerprint(value.input);
    await writeNative(project, '{"model":"sonnet","effortLevel":"xhigh"}');
    const both = await nativeRoutingFingerprint(value.input);
    expect(both).not.toBe(baseline);

    for (const effortLevel of ["low", "medium", "high", "xhigh"]) {
      await writeNative(user, JSON.stringify({ model: "sonnet", effortLevel }));
      await expect(nativeRoutingFingerprint(value.input)).resolves.toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
    }
  });

  test("ignores unknown values semantically, including non-finite JSON numbers", async () => {
    const value = await fixture("claude");
    const path = join(value.homeDir, ".claude", "settings.json");
    await writeNative(
      path,
      '{"model":"sonnet","unknownSecret":1e400,"token":"FIRST"}',
    );
    const baseline = await nativeRoutingFingerprint(value.input);
    await writeNative(
      path,
      '{ "token": "SECOND", "unknownSecret": -1e400, "model": "sonnet" }',
    );
    expect(await nativeRoutingFingerprint(value.input)).toBe(baseline);
  });

  test("distinguishes a missing layer from a present empty object and every lower-layer change", async () => {
    const value = await fixture("claude");
    const user = join(value.homeDir, ".claude", "settings.json");
    const project = join(value.projectRoot, ".claude", "settings.json");
    const missing = await nativeRoutingFingerprint(value.input);
    await writeNative(user, "{}");
    const empty = await nativeRoutingFingerprint(value.input);
    await writeNative(project, '{"model":"opus"}');
    const higher = await nativeRoutingFingerprint(value.input);
    await writeNative(user, '{"model":"haiku"}');
    const lowerChanged = await nativeRoutingFingerprint(value.input);
    expect(empty).not.toBe(missing);
    expect(higher).not.toBe(empty);
    expect(lowerChanged).not.toBe(higher);
  });

  test.each([
    ["top-level duplicate", '{"model":"sonnet","model":"opus"}'],
    ["nested duplicate", '{"model":"sonnet","x":{"a":1,"a":2}}'],
    ["escaped duplicate", '{"model":"sonnet","\\u0078":1,"x":2}'],
    ["comment", '{"model":"sonnet" /* no */}'],
    ["trailing comma", '{"model":"sonnet",}'],
    ["trailing content", '{"model":"sonnet"} false'],
    ["BOM", '\uFEFF{"model":"sonnet"}'],
    ["array root", '["sonnet"]'],
    ["invalid effort", '{"effortLevel":"max"}'],
    ["wrong model type", '{"model":42}'],
  ])("rejects strict JSON/schema case: %s", async (_name, source) => {
    const value = await fixture("claude");
    await writeNative(join(value.homeDir, ".claude", "settings.json"), source);
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
  });

  test("preserves exact Claude routing flag strings", async () => {
    const value = await fixture("claude");
    const canonical = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CODE_USE_BEDROCK: "true" },
    });
    const synonym = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CODE_USE_BEDROCK: "yes" },
    });
    const padded = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CODE_USE_BEDROCK: " true " },
    });
    const opaque = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CODE_USE_BEDROCK: "provider-owned-value" },
    });
    expect(synonym).not.toBe(canonical);
    expect(padded).not.toBe(canonical);
    expect(opaque).not.toBe(canonical);
    await expect(
      nativeRoutingFingerprint({
        ...value.input,
        env: { CLAUDE_CODE_USE_BEDROCK: "" },
      }),
    ).rejects.toSatisfy(expectConfigError);
  });
});

describe("native routing environment and paths", () => {
  test("every allowlisted environment field changes the selected fingerprint", async () => {
    for (const provider of ["codex", "claude"] as const) {
      const value = await fixture(provider);
      const baseline = await nativeRoutingFingerprint(value.input);
      const entries =
        provider === "codex"
          ? {
              OPENAI_BASE_URL: "https://api.example/v1",
              OPENAI_ORGANIZATION: "org",
              OPENAI_PROJECT: "project",
            }
          : {
              ANTHROPIC_MODEL: "sonnet",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
              ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
              ANTHROPIC_BASE_URL: "https://api.example/v1",
              CLAUDE_CODE_USE_BEDROCK: "true",
              CLAUDE_CODE_USE_VERTEX: "false",
              CLAUDE_CODE_USE_FOUNDRY: "true",
              AWS_REGION: "us-east-1",
              AWS_DEFAULT_REGION: "us-west-2",
              CLOUD_ML_REGION: "us-central1",
              ANTHROPIC_VERTEX_PROJECT_ID: "project",
            };
      for (const [name, setting] of Object.entries(entries)) {
        const changed = await nativeRoutingFingerprint({
          ...value.input,
          env: { [name]: setting },
        });
        expect(changed, `${provider} ${name}`).not.toBe(baseline);
      }
    }
  });

  test("never enumerates or invokes unlisted environment data", async () => {
    const value = await fixture("claude");
    let hookCalls = 0;
    const environment = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(environment, "ANTHROPIC_API_KEY", {
      enumerable: true,
      get: () => {
        hookCalls += 1;
        throw new Error("must not inspect secret");
      },
    });
    Object.defineProperty(environment, Symbol("secret"), {
      enumerable: true,
      get: () => {
        hookCalls += 1;
        throw new Error("must not inspect symbol");
      },
    });
    await expect(
      nativeRoutingFingerprint({ ...value.input, env: environment }),
    ).resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hookCalls).toBe(0);
  });

  test("rejects allowlisted accessors and proxies without invoking hooks", async () => {
    const value = await fixture();
    let hookCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "OPENAI_PROJECT", {
      enumerable: true,
      get: () => {
        hookCalls += 1;
        throw new Error("must not invoke");
      },
    });
    await expect(
      nativeRoutingFingerprint({ ...value.input, env: accessor }),
    ).rejects.toSatisfy(expectConfigError);

    const trap = () => {
      hookCalls += 1;
      throw new Error("must not invoke");
    };
    const proxy = new Proxy(
      {},
      {
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
      },
    );
    await expect(
      nativeRoutingFingerprint({ ...value.input, env: proxy }),
    ).rejects.toSatisfy(expectConfigError);
    expect(hookCalls).toBe(0);
  });

  test("uses locator variables only through lexical requested paths", async () => {
    const value = await fixture();
    const custom = join(value.root, "custom-codex");
    await writeNative(join(custom, "config.toml"), 'model = "gpt-5.6-sol"\n');
    const absolute = await nativeRoutingFingerprint({
      ...value.input,
      env: { CODEX_HOME: custom },
    });
    const relative = await nativeRoutingFingerprint({
      ...value.input,
      env: { CODEX_HOME: "../custom-codex" },
    });
    expect(relative).toBe(absolute);

    const fallback = await nativeRoutingFingerprint({
      ...value.input,
      env: { CODEX_HOME: "" },
    });
    expect(fallback).not.toBe(absolute);
  });

  test("derives the canonical Git root from a nested session cwd", async () => {
    const value = await fixture("claude");
    const nested = join(value.projectRoot, "packages", "child");
    await mkdir(nested, { recursive: true });
    const baseline = await nativeRoutingFingerprint({
      ...value.input,
      canonicalCwd: nested,
    });
    await writeNative(
      join(value.projectRoot, ".claude", "settings.json"),
      '{"model":"sonnet"}',
    );
    const changed = await nativeRoutingFingerprint({
      ...value.input,
      canonicalCwd: nested,
    });
    expect(changed).not.toBe(baseline);

    await expect(
      nativeRoutingFingerprint({
        ...value.input,
        canonicalCwd: nested,
        projectRoot: join(value.root, "wrong"),
      } as unknown as NativeRoutingFingerprintInput),
    ).rejects.toSatisfy(expectConfigError);
  });

  test("records both lexical requested path and canonical realpath", async () => {
    const value = await fixture("claude");
    const physical = join(value.root, "physical");
    const linked = join(value.root, "linked");
    await mkdir(physical);
    await writeNative(join(physical, "settings.json"), '{"model":"sonnet"}');
    await symlink(physical, linked, "dir");
    const linkedDigest = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CONFIG_DIR: linked },
    });
    const physicalDigest = await nativeRoutingFingerprint({
      ...value.input,
      env: { CLAUDE_CONFIG_DIR: physical },
    });
    expect(linkedDigest).not.toBe(physicalDigest);
  });

  test("treats a missing path as a marker but a broken symlink as fatal", async () => {
    const value = await fixture("claude");
    await expect(nativeRoutingFingerprint(value.input)).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    const path = join(value.homeDir, ".claude", "settings.json");
    await mkdir(join(path, ".."), { recursive: true });
    await symlink(join(value.root, "missing-target"), path);
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
  });

  test.each([
    ["query", "https://host/v1?api_key=NATIVE_URL_SECRET"],
    ["fragment", "https://host/v1#NATIVE_URL_SECRET"],
    ["userinfo", "https://user:NATIVE_URL_SECRET@host/v1"],
    ["relative", "/v1"],
    ["wrong scheme", "file:///v1"],
  ])(
    "rejects secret-bearing environment URL %s without leaking it",
    async (_name, source) => {
      const value = await fixture();
      let failure: unknown;
      try {
        await nativeRoutingFingerprint({
          ...value.input,
          env: { OPENAI_BASE_URL: source },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toSatisfy(expectConfigError);
      expect(String(failure)).not.toContain("NATIVE_URL_SECRET");
      expect(JSON.stringify(failure)).not.toContain("NATIVE_URL_SECRET");
    },
  );
});

describe("native routing source safety", () => {
  test("accepts exactly 512 KiB and rejects one byte more", async () => {
    const value = await fixture("claude");
    const path = join(value.homeDir, ".claude", "settings.json");
    const prefix = '{"model":"sonnet"}';
    await writeNative(
      path,
      `${prefix}${" ".repeat(512 * 1024 - prefix.length)}`,
    );
    await expect(nativeRoutingFingerprint(value.input)).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    await writeNative(
      path,
      `${prefix}${" ".repeat(512 * 1024 + 1 - prefix.length)}`,
    );
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
  });

  test("rejects invalid UTF-8 and directories", async () => {
    const value = await fixture("claude");
    const path = join(value.homeDir, ".claude", "settings.json");
    await writeNative(path, new Uint8Array([0x7b, 0xff, 0x7d]));
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
    await rm(path);
    await mkdir(path);
    await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
      expectConfigError,
    );
  });

  test.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking",
    async () => {
      const value = await fixture("claude");
      const path = join(value.homeDir, ".claude", "settings.json");
      await mkdir(join(path, ".."), { recursive: true });
      await promisify(execFile)("mkfifo", [path]);
      await expect(nativeRoutingFingerprint(value.input)).rejects.toSatisfy(
        expectConfigError,
      );
    },
  );

  test("bounds parser diagnostics and never exposes raw source or cause", async () => {
    const value = await fixture("claude");
    const path = join(value.homeDir, ".claude", "settings.json");
    const canary = "CLAUDE_PARSER_SECRET_CANARY";
    await writeNative(path, `{"model":"${canary}", broken}`);
    let failure: unknown;
    try {
      await nativeRoutingFingerprint(value.input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toSatisfy(expectConfigError);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect((failure as Error).stack).not.toContain(canary);
  });
});
