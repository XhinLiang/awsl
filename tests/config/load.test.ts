import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config/load.js";

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

describe("loadConfig", () => {
  test("validates each layer, performs leaf merge, and tracks RFC6901 provenance", async () => {
    const loaded = await loadConfig({
      cwd: process.cwd(),
      userConfig: {
        providers: { codex: { tiers: { strong: { effort: "high" } } } },
      },
      projectConfig: {
        providers: { codex: { tiers: { strong: { model: "gpt-project" } } } },
      },
      cli: { provider: "claude" },
    });
    expect(loaded.value.providers.codex.tiers.strong).toEqual({
      model: "gpt-project",
      effort: "high",
    });
    expect(loaded.provenance["/provider"].layer).toBe("cli");
    expect(loaded.provenance["/providers/codex/tiers/strong/model"].layer).toBe(
      "project",
    );
  });

  test("does not let a later layer hide invalid input", async () => {
    await expect(
      loadConfig({
        cwd: process.cwd(),
        projectConfig: { provider: "wrong" },
        cli: { provider: "codex" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("does not let a later args vector hide unsafe lower-layer provider args", async () => {
    const unsafe = "--model";
    const error = await rejectedError(
      loadConfig({
        cwd: process.cwd(),
        projectConfig: {
          providers: { codex: { args: [unsafe] } },
        },
        cli: {
          providers: { codex: { args: ["--search"] } },
        },
      }),
    );

    expect(error).toMatchObject({
      code: "CONFIG_ERROR",
      recoverable: false,
    });
    expect(error.message).toContain(
      "project project config /providers/codex/args",
    );
    expect(error.message).not.toContain(unsafe);
  });

  test.each([
    ["codex", "claude", "--model"],
    ["claude", "codex", "--dangerously-skip-permissions"],
  ] as const)(
    "rejects unsafe %s args while %s is the selected provider",
    async (configuredProvider, selectedProvider, unsafe) => {
      const error = await rejectedError(
        loadConfig({
          cwd: process.cwd(),
          projectConfig: {
            provider: selectedProvider,
            providers: {
              [configuredProvider]: { args: [unsafe] },
            },
          },
        }),
      );

      expect(error).toMatchObject({
        code: "CONFIG_ERROR",
        recoverable: false,
      });
      expect(error.message).toContain(`/providers/${configuredProvider}/args`);
      expect(error.message).not.toContain(unsafe);
    },
  );

  test("does not let a valid CLI profile hide an unsafe project profile", async () => {
    const unsafe = "../bad";
    const error = await rejectedError(
      loadConfig({
        cwd: process.cwd(),
        projectConfig: {
          providers: { codex: { profile: unsafe } },
        },
        cli: {
          providers: { codex: { profile: "corp" } },
        },
      }),
    );

    expect(error).toMatchObject({
      code: "CONFIG_ERROR",
      recoverable: false,
    });
    expect(error.message).toContain("/providers/codex/profile");
    expect(error.message).not.toContain(unsafe);
  });

  test("keeps arrays atomic, rejects Claude profiles, and validates inactive targets", async () => {
    const loaded = await loadConfig({
      cwd: process.cwd(),
      projectConfig: { providers: { codex: { args: ["--search"] } } },
      cli: { providers: { codex: { args: ["--no-alt-screen"] } } },
    });
    expect(loaded.value.providers.codex.args).toEqual(["--no-alt-screen"]);
    expect(Object.isFrozen(loaded.value.providers.codex.args)).toBe(true);
    await expect(
      loadConfig({
        cwd: process.cwd(),
        cli: { providers: { claude: { profile: "not-allowed" } } },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      loadConfig({
        cwd: process.cwd(),
        cli: {
          providers: { claude: { tiers: { fast: { model: "gpt-foreign" } } } },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("escapes dynamic map names in provenance", async () => {
    const loaded = await loadConfig({
      cwd: process.cwd(),
      cli: {
        providers: {
          codex: {
            models: { "a/b~c": { model: "gpt-custom", effort: "low" } },
          },
        },
      },
    });
    expect(
      loaded.provenance["/providers/codex/models/a~1b~0c/model"].layer,
    ).toBe("cli");
  });

  test("snapshots untrusted inputs before validation and never invokes getters", async () => {
    let read = false;
    const cli = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(cli, "provider", {
      enumerable: true,
      get() {
        read = true;
        return "codex";
      },
    });
    await expect(loadConfig({ cwd: process.cwd(), cli })).rejects.toMatchObject(
      {
        code: "CONFIG_ERROR",
      },
    );
    expect(read).toBe(false);
  });

  test("rejects cycles, shared references, sparse arrays, and symbol keys", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared = { model: "gpt-5.6-sol", effort: "low" };
    const sparse: unknown[] = [];
    sparse[1] = "--search";
    for (const cli of [
      cyclic,
      { providers: { codex: { models: { one: shared, two: shared } } } },
      { providers: { codex: { args: sparse } } },
      Object.assign({ provider: "codex" }, { [Symbol("hidden")]: true }),
    ])
      await expect(
        loadConfig({ cwd: process.cwd(), cli }),
      ).rejects.toMatchObject({
        code: "CONFIG_ERROR",
      });
  });

  test("uses bounded secret-safe diagnostics for nested invalid values", async () => {
    for (const secret of [
      ["sk", "-live-super-secret-value"].join(""),
      "correct-horse",
      "opaqueValue",
    ]) {
      await expect(
        loadConfig({
          cwd: process.cwd(),
          cli: { provider: { ordinary: secret } },
        }),
      ).rejects.toThrow(/<redacted>/);
      await expect(
        loadConfig({
          cwd: process.cwd(),
          cli: { provider: { ordinary: secret } },
        }),
      ).rejects.not.toThrow(secret);
    }
  });

  test("resolves stateDir with the same lexical path contract", async () => {
    await expect(
      loadConfig({
        cwd: process.cwd(),
        cli: { state_dir: String.raw`C:state` },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("rejects a shell command in executable environment input", async () => {
    await expect(
      loadConfig({
        cwd: process.cwd(),
        env: { AWSL_CODEX_COMMAND: "codex --dangerously-skip-permissions" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("does not invoke environment getters while projecting known keys", async () => {
    let read = false;
    const env = Object.create(null) as Record<string, string | undefined>;
    Object.defineProperty(env, "AWSL_PROVIDER", {
      enumerable: true,
      get() {
        read = true;
        return "codex";
      },
    });
    await expect(loadConfig({ cwd: process.cwd(), env })).rejects.toMatchObject(
      {
        code: "CONFIG_ERROR",
      },
    );
    expect(read).toBe(false);
  });

  test("snapshots the top-level options without invoking getters", async () => {
    let reads = 0;
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, "cwd", {
      enumerable: true,
      get() {
        reads += 1;
        return process.cwd();
      },
    });
    await expect(loadConfig(options as never)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    expect(reads).toBe(0);
  });

  test.each([
    Object.assign(Object.create({ inherited: true }), { cwd: process.cwd() }),
    Object.assign({ cwd: process.cwd() }, { [Symbol("hidden")]: true }),
    new Proxy({ cwd: process.cwd() }, {}),
  ])("rejects a non-data top-level options object", async (options) => {
    await expect(loadConfig(options as never)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  test("does not inspect unknown environment properties", async () => {
    let reads = 0;
    const env = Object.create(null) as Record<string, string | undefined>;
    Object.defineProperty(env, "AWSL_FUTURE_SECRET", {
      enumerable: true,
      get() {
        reads += 1;
        return "Bearer should-never-be-read";
      },
    });
    await expect(
      loadConfig({ cwd: process.cwd(), env }),
    ).resolves.toBeDefined();
    expect(reads).toBe(0);
  });

  test("redacts malformed TOML source, parser cause, and sensitive path", async () => {
    const secret = "Bearer.eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const dir = await mkdtemp(join(tmpdir(), "awsl-secret-"));
    const sourcePath = join(dir, secret);
    await writeFile(sourcePath, `provider = "${secret}"\nbroken = [\n`);
    const error = (await rejectedError(
      loadConfig({
        cwd: process.cwd(),
        userConfigPath: sourcePath,
        projectConfig: {},
      }),
    )) as Error & { cause?: unknown; code?: string };
    expect(error.code).toBe("CONFIG_ERROR");
    expect(
      `${error.message}\n${error.stack ?? ""}\n${String(error.cause)}`,
    ).not.toContain(secret);
    expect(error.cause).toBeUndefined();
  });

  test("redacts sensitive dynamic keys and source paths", async () => {
    const secret = ["A", "KIA", "ABCDEFGHIJKLMNOP"].join("");
    const error = await rejectedError(
      loadConfig({
        cwd: process.cwd(),
        userConfigPath: `/private/${secret}/config.toml`,
        userConfig: { [secret]: true },
        projectConfig: {},
      }),
    );
    expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(secret);
    expect(error.message).toMatch(/user .*expected known key/);
  });

  test("accepts an explicit executable path containing spaces and parentheses", async () => {
    const executable = "/Applications/Codex (Beta)/bin/codex";
    const loaded = await loadConfig({
      cwd: process.cwd(),
      cli: { providers: { codex: { executable } } },
    });
    expect(loaded.value.providers.codex.executable).toBe(executable);
  });

  test.each([
    { userConfigPath: "", projectConfig: {} },
    { projectConfigPath: "", userConfig: {} },
  ])("rejects an explicitly empty config path", async (options) => {
    await expect(
      loadConfig({ cwd: process.cwd(), ...options }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("bounds recursive input snapshots with a CONFIG_ERROR", async () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 20_000; index++) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    await expect(
      loadConfig({ cwd: process.cwd(), cli: root }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test.each([
    [{ providers: "opaque-providers" }, "/providers"],
    [
      {
        providers: {
          codex: { tiers: { fast: "opaque-target" } },
        },
      },
      "/providers/codex/tiers/fast",
    ],
  ])(
    "reports nested object type errors with context and redacted actual",
    async (cli, pointer) => {
      const error = await rejectedError(
        loadConfig({ cwd: process.cwd(), cli }),
      );
      expect(error.message).toContain(`cli CLI ${pointer}: expected object`);
      expect(error.message).toContain("actual <redacted>");
      expect(error.message).not.toContain("opaque-");
    },
  );
});
