import { describe, expect, test } from "vitest";

import {
  awslBehaviorFingerprint,
  modelMapFingerprint,
} from "../../src/config/fingerprints.js";
import type { ResolvedAwslConfig } from "../../src/config/types.js";

function config(): ResolvedAwslConfig {
  return {
    provider: "codex",
    stateDir: "/state/awsl",
    rawProviderEvents: false,
    providers: {
      codex: {
        id: "codex",
        executable: "codex",
        args: ["--search"],
        defaultModel: "gpt-5.6-terra",
        nativeModels: ["gpt-private"],
        models: {
          quality: { model: "gpt-5.6-sol", effort: "xhigh" },
        },
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
        args: ["--safe-mode"],
        defaultModel: "sonnet",
        nativeModels: ["claude-private"],
        models: {
          quality: { model: "opus", effort: "high" },
        },
        tiers: {
          fast: { model: "haiku", effort: "low" },
          balanced: { model: "sonnet", effort: "medium" },
          strong: { model: "opus", effort: "high" },
        },
      },
    },
    registry: {
      pluginDirs: ["./plugins/configured"],
    },
  };
}

function behavior(
  value: ResolvedAwslConfig = config(),
  enabledPluginRoots: readonly string[] = ["/plugins/enabled"],
): string {
  return awslBehaviorFingerprint({
    config: value,
    enabledPluginRoots,
  });
}

function configError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "CONFIG_ERROR" &&
    (error as Error & { recoverable?: unknown }).recoverable === false &&
    error.cause === undefined
  );
}

describe("awsl behavior fingerprint", () => {
  test("is a deterministic lowercase SHA-256 independent of object insertion order", () => {
    const first = config();
    const second = config();
    second.providers.codex.models = Object.fromEntries(
      Object.entries(second.providers.codex.models).reverse(),
    );
    second.providers = Object.fromEntries(
      Object.entries(second.providers).reverse(),
    ) as unknown as ResolvedAwslConfig["providers"];

    expect(behavior(first)).toBe(
      "sha256:18443685b0139e1dc1a20fbbad6c0f9bdf1287cac0b2014d6bf72a34beed3c66",
    );
    expect(behavior(second)).toBe(behavior(first));
  });

  test.each([
    [
      "selected executable",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.executable = "/other/codex";
      },
    ],
    [
      "selected args",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.args = ["--strict-config"];
      },
    ],
    [
      "selected profile",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.profile = "other-profile";
      },
    ],
    [
      "unselected provider",
      (value: ResolvedAwslConfig) => {
        value.providers.claude.tiers = {
          ...value.providers.claude.tiers,
          fast: {
            model: "sonnet",
            effort: "medium",
          },
        };
      },
    ],
    [
      "state directory",
      (value: ResolvedAwslConfig) => {
        value.stateDir = "/other-state/awsl";
      },
    ],
    [
      "raw event policy",
      (value: ResolvedAwslConfig) => {
        value.rawProviderEvents = true;
      },
    ],
    [
      "registry roots",
      (value: ResolvedAwslConfig) => {
        value.registry.pluginDirs = ["./plugins/other"];
      },
    ],
  ])("changes when complete behavior changes: %s", (_name, mutate) => {
    const baseline = config();
    const changed = config();
    mutate(changed);
    expect(behavior(changed)).not.toBe(behavior(baseline));
  });

  test("includes explicitly injected enabled plugin roots in exact order", () => {
    const baseline = behavior(config(), ["/plugins/a", "/plugins/b"]);
    expect(behavior(config(), ["/plugins/a"])).not.toBe(baseline);
    expect(behavior(config(), ["/plugins/b", "/plugins/a"])).not.toBe(baseline);
  });

  test.each([
    ["relative root", ["plugins/enabled"]],
    ["noncanonical root", ["/plugins/../enabled"]],
    ["duplicate root", ["/plugins/enabled", "/plugins/enabled"]],
  ])("rejects an invalid enabled root vector: %s", (_name, roots) => {
    expect(() => behavior(config(), roots)).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
        cause: undefined,
      }),
    );
  });

  test("rejects duplicate resolved registry roots", () => {
    const value = config();
    value.registry.pluginDirs = ["./plugins/shared", "./plugins/shared"];
    expect(() => behavior(value)).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test("rejects extra secret-bearing config data without hashing or exposing it", () => {
    const canary = "PRIVATE_CONFIG_SECRET_CANARY";
    const hostile = config() as ResolvedAwslConfig & {
      authorization?: string;
    };
    hostile.authorization = canary;
    let failure: unknown;
    try {
      behavior(hostile);
    } catch (error) {
      failure = error;
    }
    expect(failure).toSatisfy(configError);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  test("does not invoke top-level or nested hostile hooks", () => {
    let hookCalls = 0;
    const trap = () => {
      hookCalls += 1;
      throw new Error("fingerprint hook must not run");
    };
    const proxied = new Proxy(
      { config: config(), enabledPluginRoots: ["/plugins/enabled"] },
      {
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
      },
    );
    expect(() => awslBehaviorFingerprint(proxied)).toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );

    const nested = config();
    Object.defineProperty(nested.providers.codex, "executable", {
      enumerable: true,
      get: trap,
    });
    expect(() => behavior(nested)).toThrowError(
      expect.objectContaining({ code: "CONFIG_ERROR" }),
    );
    expect(hookCalls).toBe(0);
  });
});

describe("selected provider model-map fingerprint", () => {
  test("locks the selected map, aliases, and builtin defaults to a golden", () => {
    expect(modelMapFingerprint(config())).toBe(
      "sha256:9be94d304f683dc6a4e53ae613d400bd6d4c7f31e41609d540b15466d97616dd",
    );
  });

  test.each([
    [
      "default model",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.defaultModel = "gpt-5.6-sol";
      },
    ],
    [
      "native model",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.nativeModels = ["gpt-private", "gpt-other"];
      },
    ],
    [
      "exact model key",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.models = {
          ...value.providers.codex.models,
          other: {
            model: "gpt-5.6-terra",
            effort: "low",
          },
        };
      },
    ],
    [
      "exact model target",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.models = {
          ...value.providers.codex.models,
          quality: {
            model: "gpt-5.6-terra",
            effort: "low",
          },
        };
      },
    ],
    [
      "tier target",
      (value: ResolvedAwslConfig) => {
        value.providers.codex.tiers = {
          ...value.providers.codex.tiers,
          strong: {
            model: "gpt-5.6-terra",
            effort: "max",
          },
        };
      },
    ],
  ])("changes for selected routing input: %s", (_name, mutate) => {
    const baseline = config();
    const changed = config();
    mutate(changed);
    expect(modelMapFingerprint(changed)).not.toBe(
      modelMapFingerprint(baseline),
    );
  });

  test("ignores every unselected provider and non-model field", () => {
    const baseline = config();
    const changed = config();
    changed.providers = {
      ...changed.providers,
      claude: {
        ...changed.providers.claude,
        executable: "/other/claude",
        nativeModels: ["claude-other"],
        tiers: {
          ...changed.providers.claude.tiers,
          strong: { model: "claude-opus-new", effort: "max" },
        },
      },
    };
    changed.stateDir = "/other-state";
    changed.rawProviderEvents = true;
    changed.registry.pluginDirs = ["./other-plugin"];

    expect(modelMapFingerprint(changed)).toBe(modelMapFingerprint(baseline));
  });

  test("switching the selected provider selects only its complete model map", () => {
    const codex = config();
    const claude = config();
    claude.provider = "claude";
    expect(modelMapFingerprint(claude)).not.toBe(modelMapFingerprint(codex));
  });
});
