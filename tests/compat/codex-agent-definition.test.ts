import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { parseCodexAgentDefinition } from "../../src/compat/codex-agent-definition.js";

const sourceFor = (document: string) => ({
  tier: "user" as const,
  realpath: "/agent.toml",
  sha256:
    `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}` as const,
});
const parse = (document: string) =>
  parseCodexAgentDefinition(document, sourceFor(document));

describe("Codex agent definitions", () => {
  test("normalizes a standalone agent and ignores nickname presentation metadata", () => {
    const document = [
      'name = "display-name"',
      'description = "Shown to users"',
      'developer_instructions = "Follow the task carefully."',
      'model = "gpt-5.6"',
      'model_reasoning_effort = "xhigh"',
      'sandbox_mode = "workspace-write"',
      'nickname_candidates = ["Dex", "Code"]',
    ].join("\n");

    expect(parse(document)).toEqual({
      name: "display-name",
      description: "Shown to users",
      instructions: "Follow the task carefully.",
      model: "gpt-5.6",
      effort: "xhigh",
      sandboxMode: "workspace-write",
      source: sourceFor(document),
    });
  });

  test("returns null for a reusable TOML config fragment without agent markers", () => {
    expect(parse('model = "gpt-5.6"')).toBeNull();
  });

  test.each([
    'name = "agent"',
    'description = "display"',
    'developer_instructions = "work"',
    'name = "agent"\ndescription = "display"',
  ])("rejects partial standalone markers", (document) => {
    expect(() => parse(document)).toThrow(/Codex agent definition is invalid/);
  });

  test.each([
    'name = "agent"\nname = "duplicate"\ndescription = "x"\ndeveloper_instructions = "work"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions =',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = 1',
    'name = ""\ndescription = "x"\ndeveloper_instructions = "work"',
    'name = "agent"\ndescription = ""\ndeveloper_instructions = "work"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = ""',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nmodel_reasoning_effort = "ultra"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nsandbox_mode = "full-access"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nnickname_candidates = ["Dex", "Dex"]',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nnickname_candidates = [" "]',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nnickname_candidates = [" Dex "]',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nnickname_candidates = "Dex"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nmcp_servers = {}',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nskills = []',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\napprovals = "never"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\nunknown = "x"',
    'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"\n__proto__ = "x"',
  ])("fails closed for invalid or unsupported TOML", (document) => {
    expect(() => parse(document)).toThrow(/Codex agent definition is invalid/);
  });

  test("does not echo hostile TOML values in errors", () => {
    const secret = "do-not-echo-this-agent-value";
    expect(() => parse(`name = "${secret}"`)).toThrowError(
      /Codex agent definition is invalid/,
    );
    try {
      parse(`name = "${secret}"`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test("rejects NUL-containing standalone strings", () => {
    expect(() =>
      parse(
        'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work\\u0000now"',
      ),
    ).toThrow(/Codex agent definition is invalid/);
  });

  test.each(["name", "description", "developer_instructions"] as const)(
    "rejects a whitespace-only required %s field",
    (field) => {
      const fields = {
        name: "agent",
        description: "display",
        developer_instructions: "work",
      };
      fields[field] = " \t ";
      expect(() =>
        parse(
          `name = "${fields.name}"\ndescription = "${fields.description}"\ndeveloper_instructions = "${fields.developer_instructions}"`,
        ),
      ).toThrow(/Codex agent definition is invalid/);
    },
  );

  test("enforces source hash and UTF-8 size limits", () => {
    const document =
      'name = "agent"\ndescription = "x"\ndeveloper_instructions = "work"';
    expect(() =>
      parseCodexAgentDefinition(document, {
        ...sourceFor(document),
        sha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow(/Codex agent definition is invalid/);
    expect(() => parse("x".repeat(512 * 1024 + 1))).toThrow(
      /Codex agent definition is invalid/,
    );
    const prefix = "中".repeat(Math.floor(65536 / Buffer.byteLength("中")));
    const exact = `${prefix}${" ".repeat(65536 - Buffer.byteLength(prefix))}`;
    expect(
      parse(
        `name = "agent"\ndescription = "x"\ndeveloper_instructions = "${exact}"`,
      )?.instructions,
    ).toBe(exact);
    expect(() =>
      parse(
        `name = "agent"\ndescription = "x"\ndeveloper_instructions = "${exact}x"`,
      ),
    ).toThrow(/Codex agent definition is invalid/);
  });

  test("deep-freezes its output and source snapshot", () => {
    const definition = parse(
      'name = "from-toml"\ndescription = "x"\ndeveloper_instructions = "work"',
    );
    expect(definition?.name).toBe("from-toml");
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.source)).toBe(true);
    expect(() => {
      (definition as { name: string }).name = "changed";
    }).toThrow();
  });
});
