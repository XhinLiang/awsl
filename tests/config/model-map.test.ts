import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import {
  resolveModel,
  validateProviderArgs,
} from "../../src/config/model-map.js";

describe("resolveModel", () => {
  test.each([
    ["codex", "haiku", "gpt-5.6-terra", "low", "tier:fast"],
    ["codex", "sonnet", "gpt-5.6-terra", "medium", "tier:balanced"],
    ["codex", "opus", "gpt-5.6-sol", "xhigh", "tier:strong"],
    ["claude", "haiku", "haiku", "low", "native"],
    ["claude", "sonnet", "sonnet", "medium", "native"],
    ["claude", "opus", "opus", "high", "native"],
  ] as const)(
    "freezes defaults for %s/%s",
    (provider, requested, model, effort, modelSource) => {
      expect(
        resolveModel({
          provider,
          callOptionsModel: requested,
          config: DEFAULT_CONFIG.providers[provider],
        }),
      ).toMatchObject({
        model,
        effort,
        modelSource,
        requestSource: "workflow",
        effectiveRequestedModel: requested,
      });
    },
  );

  test("exact mappings beat native aliases and workflow effort beats map effort", () => {
    const config = {
      ...DEFAULT_CONFIG.providers.codex,
      models: { opus: { model: "gpt-custom", effort: "low" as const } },
    };
    expect(
      resolveModel({
        provider: "codex",
        callOptionsModel: "opus",
        callOptionsEffort: "max",
        config,
      }),
    ).toMatchObject({
      model: "gpt-custom",
      effort: "max",
      modelSource: "exact:opus",
      effortSource: "workflow",
    });
  });

  test.each([
    [
      "workflow model with agent effort",
      {
        callOptionsModel: "opus",
        agentModel: "haiku",
        agentEffort: "low" as const,
      },
      {
        effectiveRequestedEffort: "low",
        effectiveRequestedModel: "opus",
        effort: "low",
        effortSource: "agent",
        model: "gpt-5.6-sol",
        modelSource: "tier:strong",
        requestSource: "workflow",
      },
    ],
    [
      "agent model with workflow effort",
      {
        agentModel: "haiku",
        agentEffort: "low" as const,
        callOptionsEffort: "max" as const,
      },
      {
        effectiveRequestedEffort: "max",
        effectiveRequestedModel: "haiku",
        effort: "max",
        effortSource: "workflow",
        model: "gpt-5.6-terra",
        modelSource: "tier:fast",
        requestSource: "agent",
      },
    ],
    [
      "agent effort without a requested model",
      {
        agentEffort: "high" as const,
      },
      {
        effectiveRequestedEffort: "high",
        effort: "high",
        effortSource: "agent",
        modelSource: "implicit",
        requestSource: "none",
      },
    ],
  ])("resolves independent %s provenance", (_name, input, expected) => {
    expect(
      resolveModel({
        provider: "codex",
        config: DEFAULT_CONFIG.providers.codex,
        ...input,
      }),
    ).toEqual(expected);
  });

  test("preserves a native alias even when its semantic tier target changes", () => {
    const config = {
      ...DEFAULT_CONFIG.providers.claude,
      tiers: {
        ...DEFAULT_CONFIG.providers.claude.tiers,
        fast: { model: "sonnet", effort: "medium" as const },
      },
    };
    expect(
      resolveModel({
        provider: "claude",
        callOptionsModel: "haiku",
        config,
      }),
    ).toMatchObject({
      model: "haiku",
      effort: "medium",
      modelSource: "native",
      effortSource: "tier:fast",
    });
  });

  test("uses selected provider default or stays implicit", () => {
    expect(
      resolveModel({
        provider: "codex",
        config: {
          ...DEFAULT_CONFIG.providers.codex,
          defaultModel: "gpt-default",
        },
      }),
    ).toMatchObject({
      model: "gpt-default",
      modelSource: "configured-default",
    });
    expect(
      resolveModel({
        provider: "codex",
        config: DEFAULT_CONFIG.providers.codex,
      }),
    ).toMatchObject({ modelSource: "implicit", effortSource: "none" });
  });

  test("returns a detached frozen ordered provider argv snapshot", () => {
    const input = ["--safe-mode", "--setting-sources=local,user"];
    const result = validateProviderArgs("claude", input);
    input.reverse();

    expect(result).toEqual(["--safe-mode", "--setting-sources=local,user"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("rejects every inexact provider-args vector without invoking hostile code", () => {
    const sentinel = new Error("provider args trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const proxy = new Proxy(["--safe-mode"], {
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      ownKeys: trapped,
    });
    const accessor = ["placeholder"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: trapped,
    });
    const sparse = new Array<string>(1);
    class CustomArgs extends Array<string> {
      override toString(): string {
        return trapped();
      }
    }
    const custom = new CustomArgs("--safe-mode");
    const coercibleEntry = { toString: trapped };

    for (const args of [
      proxy,
      accessor,
      sparse,
      custom,
      [42],
      [coercibleEntry],
    ]) {
      expect(() =>
        validateProviderArgs("claude", args as unknown as readonly string[]),
      ).toThrowError(
        expect.objectContaining({
          code: "CONFIG_ERROR",
          recoverable: false,
        }),
      );
    }
    expect(trapCalls).toBe(0);
  });

  test.each([
    ["codex", [""]],
    ["codex", [`--search${String.fromCharCode(0)}`]],
    ["codex", ["positional"]],
    ["codex", ["--"]],
    ["codex", ["--model", "secret"]],
    ["codex", ["https://example.invalid/v1"]],
    ["codex", ["exec"]],
    ["codex", ["--json"]],
    ["codex", ["--output-schema"]],
    ["codex", ["--tools"]],
    ["codex", ["--permission-mode"]],
    ["codex", ["--mcp-config"]],
    ["codex", ["--config"]],
    ["codex", ["--cwd"]],
    ["codex", ["--sandbox"]],
    ["codex", ["--ask-for-approval"]],
    ["codex", ["--resume"]],
    ["codex", ["--plugin"]],
    ["codex", ["--debug"]],
    ["codex", ["--api-key"]],
    ["codex", ["--search", "--search"]],
    ["claude", ["--model"]],
    ["claude", ["--json-schema"]],
    ["claude", ["--system-prompt"]],
    ["claude", ["--tools"]],
    ["claude", ["--permission-mode"]],
    ["claude", ["--mcp-config"]],
    ["claude", ["--settings"]],
    ["claude", ["--header"]],
    ["claude", ["--continue"]],
    ["claude", Array.from({ length: 33 }, () => "--safe-mode")],
  ] as const)("rejects forbidden %s argv %j", (provider, args) => {
    expect(() => validateProviderArgs(provider, args)).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test.each([
    ["codex", ["--setting-sources=user"]],
    ["claude", ["--setting-sources="]],
    ["claude", ["--setting-sources=user,"]],
    ["claude", ["--setting-sources=,user"]],
    ["claude", ["--setting-sources=user,user"]],
    ["claude", ["--setting-sources=user,unknown"]],
    ["claude", ["--setting-sources=user, project"]],
    ["claude", ["--setting-sources=user", "--setting-sources=project"]],
  ] as const)("rejects invalid %s setting sources %j", (provider, args) => {
    expect(() => validateProviderArgs(provider, args)).toThrowError(
      expect.objectContaining({
        code: "CONFIG_ERROR",
        recoverable: false,
      }),
    );
  });

  test.each([
    "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    ["A", "KIA", "ABCDEFGHIJKLMNOP"].join(""),
    "private-model-name",
  ])("never echoes an unknown model in CONFIG_ERROR diagnostics", (secret) => {
    let error: Error | undefined;
    try {
      resolveModel({
        provider: "codex",
        callOptionsModel: secret,
        config: DEFAULT_CONFIG.providers.codex,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(`${error?.message}\n${error?.stack ?? ""}`).not.toContain(secret);
  });

  test.each([
    ["codex", { agentModel: "claude-private" }],
    ["claude", { agentModel: "gpt-private" }],
    [
      "codex",
      { callOptionsModel: "claude-private", agentModel: "gpt-5.6-sol" },
    ],
  ] as const)(
    "rejects unknown %s model provenance without falling back",
    (provider, input) => {
      expect(() =>
        resolveModel({
          provider,
          config: DEFAULT_CONFIG.providers[provider],
          ...input,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "CONFIG_ERROR",
          recoverable: false,
        }),
      );
    },
  );
});
