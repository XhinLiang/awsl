import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { parseAgentDefinition } from "../../src/compat/agent-definition.js";
import { WORKFLOW_SUBAGENT_SOURCE } from "../../src/compat/builtins/workflow-subagent.js";
import { readRegularUtf8 } from "../../src/config/paths.js";

const markdown = (frontmatter: string, body = "Do the task.") =>
  `---\n${frontmatter}\n---\n${body}`;
const sourceFor = (document: string) => ({
  tier: "project" as const,
  realpath: "/agent.md",
  sha256:
    `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}` as const,
});
const parse = (frontmatter: string, body?: string) => {
  const document = markdown(frontmatter, body);
  return parseAgentDefinition(document, sourceFor(document));
};

describe("agent definitions", () => {
  test("parses allowed metadata, CSV and arrays without turning display metadata into instructions", () => {
    const definition = parse(
      "name: agent\ndescription: display\ncolor: blue\ninitialPrompt: hello\nmodel: gpt\neffort: high\ntools: ' shell , read '\ndisallowedTools: [ write, edit ]\npermissionMode: plan\nskills: []",
    );
    expect(definition).toMatchObject({
      name: "agent",
      instructions: "Do the task.",
      description: "display",
      color: "blue",
      initialPrompt: "hello",
      model: "gpt",
      effort: "high",
      tools: ["shell", "read"],
      disallowedTools: ["write", "edit"],
      permissionMode: "plan",
      skills: [],
      source: sourceFor(
        markdown(
          "name: agent\ndescription: display\ncolor: blue\ninitialPrompt: hello\nmodel: gpt\neffort: high\ntools: ' shell , read '\ndisallowedTools: [ write, edit ]\npermissionMode: plan\nskills: []",
        ),
      ),
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.tools)).toBe(true);
  });

  test.each([
    ["missing frontmatter", "name: x", ""],
    ["unterminated frontmatter", "---\nname: x", undefined],
    ["duplicate key", "name: x\nname: y", undefined],
    ["alias", "name: &x agent\ndescription: *x", undefined],
    ["merge", "<<: {name: agent}\nname: agent", undefined],
    ["unknown key", "name: agent\nunknown: no", undefined],
    ["empty body", "name: agent", ""],
    ["colon name", "name: plugin:agent", undefined],
    ["invalid effort", "name: agent\neffort: huge", undefined],
    ["bad tools type", "name: agent\ntools: 1", undefined],
    ["empty CSV segment", "name: agent\ntools: a,,b", undefined],
    ["duplicate CSV", "name: agent\ntools: a, a", undefined],
    ["bad array item", "name: agent\ntools: [a, 1]", undefined],
    ["duplicate skills", "name: agent\nskills: [a, a]", undefined],
    ["bad mcp", "name: agent\nmcpServers: [x]", undefined],
  ])("rejects %s", (_name, frontmatter, body) => {
    expect(() =>
      body === "" && frontmatter === "name: x"
        ? parseAgentDefinition("name: x", sourceFor("name: x"))
        : parse(frontmatter, body),
    ).toThrow();
  });

  test.each([
    [
      "tool allowlist",
      'name: agent\ntools: [Read, " --dangerously-skip-permissions "]',
    ],
    [
      "tool denylist",
      'name: agent\ndisallowedTools: "Bash, --permission-mode"',
    ],
  ])("rejects option-like tokens in the %s", (_name, frontmatter) => {
    expect(() => parse(frontmatter)).toThrowError(
      /agent (tools|disallowedTools) entries/,
    );
  });

  test("rejects NUL-containing fields", () => {
    expect(() => parse(`name: "a${String.fromCharCode(0)}b"`)).toThrow();
  });

  test("normalizes JSON-domain MCP to a null-prototype frozen clone", () => {
    const definition = parse(
      "name: agent\nmcpServers:\n  server:\n    command: x\n    enabled: true\n    none: null\n    values: [1, two]",
    );
    expect(definition.mcp).toEqual({
      server: { command: "x", enabled: true, none: null, values: [1, "two"] },
    });
    expect(Object.getPrototypeOf(definition.mcp)).toBeNull();
    expect(Object.isFrozen(definition.mcp)).toBe(true);
    expect(Object.isFrozen(definition.mcp?.server)).toBe(true);
  });

  test("keeps CRLF and LF body bytes exactly while rejecting BOM, leading whitespace, and whitespace-only bodies", () => {
    const crlf = "---\r\nname: agent\r\n---\r\nline one\r\nline two\r\n";
    expect(parseAgentDefinition(crlf, sourceFor(crlf)).instructions).toBe(
      "line one\r\nline two\r\n",
    );
    const bom = "\uFEFF---\nname: agent\n---\nbody";
    expect(() => parseAgentDefinition(bom, sourceFor(bom))).toThrow();
    const indented = " ---\nname: agent\n---\nbody";
    expect(() => parseAgentDefinition(indented, sourceFor(indented))).toThrow();
    expect(() => parse("name: agent", " \n\t")).toThrow();
  });

  test.each([
    ["non-string optional", "name: agent\ndescription: 1"],
    ["non-string permission", "name: agent\npermissionMode: false"],
    ["nonfinite", "name: agent\nmcpServers: {x: .inf}"],
    ["tagged value", "name: agent\nmcpServers: {x: !!binary eA==}"],
    ["complex key", "name: agent\nmcpServers: {? [x]: y}"],
    ["nested duplicate", "name: agent\nmcpServers: {x: {a: 1, a: 2}}"],
    ["anchor alias", "name: agent\nmcpServers: {x: &a {a: 1}, y: *a}"],
    ["merge key", "name: agent\nmcpServers: {<<: {x: 1}}"],
    ["anchor-only name", "name: &name agent"],
    [
      "anchor-only display field",
      "name: agent\ndescription: &description display",
    ],
    [
      "anchor-only nested MCP",
      "name: agent\nmcpServers: {server: &server {command: x}}",
    ],
  ])("rejects strict YAML %s", (_name, frontmatter) => {
    expect(() => parse(frontmatter)).toThrow();
  });

  test("retains an own __proto__ MCP key without prototype pollution and deep-freezes every output", () => {
    const definition = parse(
      "name: agent\nmcpServers:\n  __proto__: {polluted: false}\n  nested: {items: [one]}",
    );
    expect(Object.hasOwn(definition.mcp ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(definition.mcp)).toBeNull();
    expect(
      Object.isFrozen((definition.mcp?.nested as { items?: unknown })?.items),
    ).toBe(true);
    expect(Object.isFrozen(definition.source)).toBe(true);
    expect(() => {
      (definition.mcp as Record<string, unknown>).newKey = true;
    }).toThrow();
  });

  test("enforces frontmatter and instruction UTF-8 boundaries", () => {
    const name = "a".repeat(512 * 1024);
    const oversized = markdown(`name: ${name}`);
    expect(() =>
      parseAgentDefinition(oversized, sourceFor(oversized)),
    ).toThrow();
    const prefix = "中".repeat(Math.floor(65536 / Buffer.byteLength("中")));
    const exact = prefix + " ".repeat(65536 - Buffer.byteLength(prefix));
    expect(parse("name: agent", exact).instructions).toBe(exact);
    expect(() => parse("name: agent", `${exact}x`)).toThrow();
  });

  test("rejects hostile source objects and emits the exact builtin asset", () => {
    const document = markdown("name: agent");
    const source = sourceFor(document);
    const proxy = new Proxy(source, {});
    expect(() => parseAgentDefinition(document, proxy)).toThrow();
    expect(() =>
      parseAgentDefinition(document, Object.create(source)),
    ).toThrow();
    expect(() =>
      parseAgentDefinition(
        document,
        Object.create(null, {
          tier: { enumerable: true, get: () => "project" },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseAgentDefinition(document, {
        ...source,
        [Symbol("x")]: 1,
      } as never),
    ).toThrow();
    expect(WORKFLOW_SUBAGENT_SOURCE).toBe(
      "---\nname: workflow-subagent\ndescription: Default awsl workflow subagent\n---\nYou are a workflow subagent. Complete the requested task in the provided\nworking directory, follow the inherited project instructions and provider\npolicy, and return the result needed by the parent workflow.\n",
    );
  });

  test("rejects a physical source hash that does not match the Markdown", () => {
    const document = markdown("name: agent");
    expect(() =>
      parseAgentDefinition(document, {
        ...sourceFor(document),
        sha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow();
  });

  test("requires an absolute physical source realpath", () => {
    const document = markdown("name: agent");
    expect(() =>
      parseAgentDefinition(document, {
        ...sourceFor(document),
        realpath: "relative/agent.md",
      }),
    ).toThrow();
  });

  test("binds the builtin identity to the exact builtin Markdown hash", () => {
    const builtinSource = {
      tier: "builtin" as const,
      identifier: "workflow-subagent" as const,
      realpath: null,
      sha256: sourceFor(WORKFLOW_SUBAGENT_SOURCE).sha256,
    };
    expect(
      parseAgentDefinition(WORKFLOW_SUBAGENT_SOURCE, builtinSource).name,
    ).toBe("workflow-subagent");
    expect(() =>
      parseAgentDefinition(WORKFLOW_SUBAGENT_SOURCE, {
        ...builtinSource,
        sha256: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow();
  });

  test("rejects a physical UTF-8 BOM before frontmatter at offset zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awsl-agent-"));
    const file = join(dir, "agent.md");
    await writeFile(file, `\uFEFF${markdown("name: agent")}`);
    const snapshot = await readRegularUtf8(file, dir);

    expect(() =>
      parseAgentDefinition(snapshot.source, {
        tier: "project",
        realpath: snapshot.realpath,
        sha256: snapshot.sha256,
      }),
    ).toThrowError(/begin with frontmatter/);
  });
});
