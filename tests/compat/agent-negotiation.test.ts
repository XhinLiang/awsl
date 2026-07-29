import { describe, expect, test } from "vitest";

import type { RawAgentDefinition } from "../../src/compat/agent-definition.js";
import { negotiateAgent } from "../../src/compat/agent-negotiation.js";
import type {
  ProviderCapabilities,
  ResolvedAgentSelection,
} from "../../src/core/types.js";
import { CLAUDE_CAPABILITIES } from "../../src/providers/claude.js";
import { CODEX_CAPABILITIES } from "../../src/providers/codex.js";

const source = Object.freeze({
  tier: "project" as const,
  realpath: "/agents/reviewer.md",
  sha256: `sha256:${"a".repeat(64)}` as const,
});

function raw(overrides: Partial<RawAgentDefinition> = {}): RawAgentDefinition {
  return {
    name: "reviewer",
    instructions: "Review the requested change.",
    source,
    ...overrides,
  };
}

function withoutClaudeCapability(
  override: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  return {
    ...CLAUDE_CAPABILITIES,
    ...override,
  };
}

function assertSelection(_selection: ResolvedAgentSelection): void {}

describe("agent policy negotiation", () => {
  test("separates central model selection from a deeply frozen request policy", () => {
    const tools = ["Read"];
    const nested = { args: ["--stdio"], command: "demo-server" };
    const mcp = { demo: nested };
    const selection = negotiateAgent(
      raw({
        color: "blue",
        description: "Display metadata",
        effort: "xhigh",
        initialPrompt: "Display-only prompt",
        mcp,
        model: "claude-opus-4-8",
        permissionMode: "manual",
        skills: [],
        tools,
      }),
      "claude",
      CLAUDE_CAPABILITIES,
    );
    assertSelection(selection);

    expect(selection).toEqual({
      agentEffort: "xhigh",
      agentModel: "claude-opus-4-8",
      policy: {
        instructions: "Review the requested change.",
        mcp: {
          demo: { args: ["--stdio"], command: "demo-server" },
        },
        name: "reviewer",
        permissionMode: "manual",
        tools: ["Read"],
      },
    });
    expect(Object.keys(selection.policy)).not.toContain("description");
    expect(Object.keys(selection.policy)).not.toContain("initialPrompt");
    expect(Object.keys(selection.policy)).not.toContain("skills");
    expect(Object.keys(selection.policy)).not.toContain("source");

    tools.push("Bash");
    nested.args.push("--changed");
    expect(selection.policy.tools).toEqual(["Read"]);
    expect(selection.policy.mcp).toEqual({
      demo: { args: ["--stdio"], command: "demo-server" },
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.policy)).toBe(true);
    expect(Object.isFrozen(selection.policy.tools)).toBe(true);
    expect(Object.isFrozen(selection.policy.mcp)).toBe(true);
    expect(Object.isFrozen(selection.policy.mcp?.demo)).toBe(true);
    expect(
      Object.isFrozen(
        (selection.policy.mcp?.demo as { args?: readonly string[] })?.args,
      ),
    ).toBe(true);
  });

  test("preserves every explicit empty Claude restriction", () => {
    const selection = negotiateAgent(
      raw({
        disallowedTools: [],
        mcp: {},
        permissionMode: "manual",
        skills: [],
        tools: [],
      }),
      "claude",
      CLAUDE_CAPABILITIES,
    );

    expect(selection.policy).toEqual({
      disallowedTools: [],
      instructions: "Review the requested change.",
      mcp: {},
      name: "reviewer",
      permissionMode: "manual",
      tools: [],
    });
    expect(Object.hasOwn(selection.policy, "tools")).toBe(true);
    expect(Object.hasOwn(selection.policy, "disallowedTools")).toBe(true);
    expect(Object.hasOwn(selection.policy, "mcp")).toBe(true);
  });

  test.each([
    ["tools", ["Read", "--dangerously-skip-permissions"]],
    ["disallowedTools", ["--permission-mode"]],
    ["tools", [" Read"]],
    ["disallowedTools", ["Bash(git diff:*) "]],
  ] as const)("rejects a direct non-normalized %s policy", (field, value) => {
    expect(() =>
      negotiateAgent(raw({ [field]: value }), "claude", CLAUDE_CAPABILITIES),
    ).toThrowError(
      expect.objectContaining({
        code: "COMPATIBILITY_ERROR",
        provider: "claude",
        recoverable: false,
      }),
    );
  });

  test.each([
    [
      "a nonempty tool allowlist without allowlist support",
      raw({ tools: ["Read"] }),
      withoutClaudeCapability({
        tools: { ...CLAUDE_CAPABILITIES.tools, allowlist: false },
      }),
    ],
    [
      "an empty tool allowlist without deny-all support",
      raw({ tools: [] }),
      withoutClaudeCapability({
        tools: { ...CLAUDE_CAPABILITIES.tools, denyAll: false },
      }),
    ],
    [
      "an explicit empty denylist without denylist support",
      raw({ disallowedTools: [] }),
      withoutClaudeCapability({
        tools: { ...CLAUDE_CAPABILITIES.tools, denylist: false },
      }),
    ],
    [
      "an explicit empty MCP replacement without strict replacement",
      raw({ mcp: {} }),
      withoutClaudeCapability({
        mcp: { ...CLAUDE_CAPABILITIES.mcp, strictReplacement: false },
      }),
    ],
    [
      "a permission mode outside the provider capability",
      raw({ permissionMode: "manual" }),
      withoutClaudeCapability({ permissionModes: [] }),
    ],
  ])("rejects Claude policy with %s", (_name, definition, capabilities) => {
    expect(() =>
      negotiateAgent(definition, "claude", capabilities),
    ).toThrowError(
      expect.objectContaining({
        code: "COMPATIBILITY_ERROR",
        provider: "claude",
        recoverable: false,
      }),
    );
  });

  test.each([
    ["tools", []],
    ["tools", ["Read"]],
    ["disallowedTools", []],
    ["disallowedTools", ["Bash"]],
    ["mcp", {}],
    ["mcp", { demo: { command: "demo-server" } }],
    ["permissionMode", "manual"],
  ] as const)(
    "rejects an explicit Codex %s policy before provider launch",
    (field, value) => {
      expect(() =>
        negotiateAgent(raw({ [field]: value }), "codex", CODEX_CAPABILITIES),
      ).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider: "codex",
          recoverable: false,
        }),
      );
    },
  );

  test.each([
    [
      "codex",
      CODEX_CAPABILITIES,
      { ...CODEX_CAPABILITIES, systemPrompt: false } as ProviderCapabilities,
    ],
    [
      "claude",
      CLAUDE_CAPABILITIES,
      { ...CLAUDE_CAPABILITIES, systemPrompt: false } as ProviderCapabilities,
    ],
  ] as const)(
    "requires the exact %s instruction capability",
    (provider, capabilities, unsupported) => {
      expect(() => negotiateAgent(raw(), provider, unsupported)).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider,
        }),
      );
      expect(
        negotiateAgent(raw(), provider, capabilities).policy,
      ).toMatchObject({
        instructions: "Review the requested change.",
        name: "reviewer",
      });
    },
  );

  test.each([
    ["codex", CODEX_CAPABILITIES],
    ["claude", CLAUDE_CAPABILITIES],
  ] as const)(
    "treats empty skills as absent but rejects nonempty skills for %s",
    (provider, capabilities) => {
      expect(
        negotiateAgent(raw({ skills: [] }), provider, capabilities),
      ).toEqual({
        policy: {
          instructions: "Review the requested change.",
          name: "reviewer",
        },
      });
      expect(() =>
        negotiateAgent(
          raw({ skills: ["repository-skill"] }),
          provider,
          capabilities,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider,
        }),
      );
    },
  );

  test("rejects proxies and accessors without invoking user code", () => {
    let getterCalls = 0;
    const accessor = Object.create(null, {
      instructions: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "must not run";
        },
      },
      name: { enumerable: true, value: "hostile" },
      source: { enumerable: true, value: source },
    }) as RawAgentDefinition;
    const target = raw();
    const proxy = new Proxy(target, {
      get: (value, key, receiver) => {
        getterCalls += 1;
        return Reflect.get(value, key, receiver);
      },
    });

    for (const definition of [accessor, proxy]) {
      expect(() =>
        negotiateAgent(definition, "claude", CLAUDE_CAPABILITIES),
      ).toThrowError(
        expect.objectContaining({
          code: "COMPATIBILITY_ERROR",
          provider: "claude",
        }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  test("keeps hostile diagnostics bounded", () => {
    let failure: unknown;
    try {
      negotiateAgent(
        raw({ permissionMode: `secret-${"x".repeat(10_000)}` }),
        "claude",
        CLAUDE_CAPABILITIES,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "COMPATIBILITY_ERROR",
      provider: "claude",
    });
    expect(String(failure)).not.toContain("secret-");
    expect(String(failure).length).toBeLessThan(512);
  });
});
