import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createRegistry } from "../../src/compat/agent-registry.js";

const workflow = (name: string, description = name) =>
  `export const meta={name:${JSON.stringify(name)},description:${JSON.stringify(description)}}; return null`;
const agent = (name: string, instructions = name) =>
  `---\nname: ${name}\ndescription: ${name}\n---\n${instructions}\n`;

interface Layout {
  root: string;
  cwd: string;
  projectClaude: string;
  userClaude: string;
  projectCodex: string;
  userCodex: string;
}

async function layout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "awsl-registry-"));
  const cwd = join(root, "project", "nested");
  const projectClaude = join(root, "project", ".claude");
  const userClaude = join(root, "user", ".claude");
  const projectCodex = join(root, "project", ".codex");
  const userCodex = join(root, "user", ".codex");
  await mkdir(join(root, "project", ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, cwd, projectClaude, userClaude, projectCodex, userCodex };
}

async function writeWorkflow(
  root: string,
  relative: string,
  name: string,
): Promise<string> {
  const path = join(root, "workflows", relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, workflow(name));
  return path;
}

async function writeAgent(
  root: string,
  relative: string,
  name: string,
  instructions = name,
): Promise<string> {
  const path = join(root, "agents", relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, agent(name, instructions));
  return path;
}

async function writeCodexAgent(
  root: string,
  relative: string,
  name: string,
  model = "gpt-5.6",
): Promise<string> {
  const path = join(root, "agents", relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(name)}\ndeveloper_instructions = ${JSON.stringify(`instructions for ${name}`)}\nmodel = ${JSON.stringify(model)}\n`,
  );
  return path;
}

async function writePlugin(root: string, manifest: string): Promise<void> {
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(join(root, ".claude-plugin", "plugin.json"), manifest);
}

const options = (value: Layout) => ({
  cwd: value.cwd,
  provider: "claude" as const,
  claudeConfigDir: value.userClaude,
  homeDir: join(value.root, "unused-home"),
});

describe("agent registry", () => {
  test("selects the provider-native agent definition while retaining Claude workflows", async () => {
    const value = await layout();
    await writeAgent(
      value.projectClaude,
      "same.md",
      "shared",
      "claude instructions",
    );
    await writeCodexAgent(
      value.projectCodex,
      "same.toml",
      "shared",
      "gpt-5.6-codex",
    );
    await writeWorkflow(value.projectClaude, "workflow.js", "still-claude");

    const claude = await createRegistry(options(value));
    const codex = await createRegistry({
      cwd: value.cwd,
      provider: "codex",
      claudeConfigDir: value.userClaude,
      codexConfigDir: value.userCodex,
      homeDir: join(value.root, "unused-home"),
    });

    await expect(claude.resolveAgent("shared")).resolves.toMatchObject({
      agent: { instructions: "claude instructions\n" },
    });
    await expect(codex.resolveAgent("shared")).resolves.toMatchObject({
      agent: {
        instructions: "instructions for shared",
        model: "gpt-5.6-codex",
      },
    });
    await expect(codex.resolveWorkflow("still-claude")).resolves.toMatchObject({
      tier: "project",
    });
  });

  test("Claude ignores malformed Codex agent definitions", async () => {
    const value = await layout();
    await mkdir(join(value.projectCodex, "agents"), { recursive: true });
    await writeFile(
      join(value.projectCodex, "agents", "malformed.toml"),
      'name = "unterminated',
    );

    await expect(createRegistry(options(value))).resolves.toMatchObject({
      agents: expect.any(Array),
    });
  });

  test("Codex ignores malformed Claude agent definitions", async () => {
    const value = await layout();
    await mkdir(join(value.projectClaude, "agents"), { recursive: true });
    await writeFile(
      join(value.projectClaude, "agents", "malformed.md"),
      "not an agent definition",
    );

    await expect(
      createRegistry({
        cwd: value.cwd,
        provider: "codex",
        codexConfigDir: value.userCodex,
        homeDir: join(value.root, "unused-home"),
      }),
    ).resolves.toMatchObject({ agents: expect.any(Array) });
  });

  test("uses Codex project precedence, skips fragments, and rejects duplicate names", async () => {
    const value = await layout();
    await writeCodexAgent(value.projectCodex, "override.toml", "native");
    await writeCodexAgent(value.userCodex, "user.toml", "native", "user-model");
    await mkdir(join(value.projectCodex, "agents"), { recursive: true });
    await writeFile(
      join(value.projectCodex, "agents", "professional_xhigh.toml"),
      'model_reasoning_effort = "xhigh"\n',
    );
    const registry = await createRegistry({
      cwd: value.cwd,
      provider: "codex",
      codexConfigDir: value.userCodex,
      homeDir: join(value.root, "unused-home"),
    });
    await expect(registry.resolveAgent("native")).resolves.toMatchObject({
      tier: "project",
    });
    await expect(registry.resolveAgent("professional_xhigh")).rejects.toThrow();

    await writeCodexAgent(value.projectCodex, "duplicate.toml", "native");
    await expect(
      createRegistry({
        cwd: value.cwd,
        provider: "codex",
        codexConfigDir: value.userCodex,
        homeDir: join(value.root, "unused-home"),
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: 'duplicate project agent frontmatter name "native"',
    });
  });

  test("resolves explicit, ambient, and empty CODEX_HOME from canonical cwd", async () => {
    const value = await layout();
    const relative = "relative-codex";
    const home = join(value.root, "home");
    await writeCodexAgent(
      join(value.cwd, relative),
      "relative.toml",
      "relative",
    );
    await writeCodexAgent(join(home, ".codex"), "fallback.toml", "fallback");
    const previous = process.env.CODEX_HOME;
    try {
      const explicit = await createRegistry({
        cwd: value.cwd,
        provider: "codex",
        codexConfigDir: relative,
        homeDir: home,
      });
      await expect(explicit.resolveAgent("relative")).resolves.toMatchObject({
        tier: "user",
      });
      process.env.CODEX_HOME = relative;
      const ambient = await createRegistry({
        cwd: value.cwd,
        provider: "codex",
        homeDir: home,
      });
      await expect(ambient.resolveAgent("relative")).resolves.toMatchObject({
        tier: "user",
      });
      process.env.CODEX_HOME = "";
      const fallback = await createRegistry({
        cwd: value.cwd,
        provider: "codex",
        homeDir: home,
      });
      await expect(fallback.resolveAgent("fallback")).resolves.toMatchObject({
        tier: "user",
      });
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      else process.env.CODEX_HOME = previous;
    }
  });

  test("does not expose Claude plugin agents for the Codex provider", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "plugin");
    await writePlugin(pluginRoot, '{"name":"plugin"}');
    await writeAgent(pluginRoot, "helper.md", "helper");
    const registry = await createRegistry({
      cwd: value.cwd,
      provider: "codex",
      codexConfigDir: value.userCodex,
      homeDir: join(value.root, "unused-home"),
      pluginDirs: [pluginRoot],
    });
    await expect(registry.resolveAgent("plugin:helper")).rejects.toThrow();
  });

  test("deduplicates Codex agent symlinks by canonical realpath", async () => {
    const value = await layout();
    const source = await writeCodexAgent(
      value.projectCodex,
      "source.toml",
      "deduped",
    );
    await symlink(source, join(value.projectCodex, "agents", "duplicate.toml"));
    const registry = await createRegistry({
      cwd: value.cwd,
      provider: "codex",
      codexConfigDir: value.userCodex,
      homeDir: join(value.root, "unused-home"),
    });

    expect(
      registry.agents.filter((entry) => entry.key === "deduped"),
    ).toHaveLength(1);
  });

  test("applies project, user, and builtin precedence and freezes completed discovery", async () => {
    const value = await layout();
    await writeWorkflow(value.projectClaude, "project.js", "same");
    await writeWorkflow(value.userClaude, "user.js", "same");
    await writeAgent(value.projectClaude, "override.md", "workflow-subagent");
    await writeAgent(value.userClaude, "user.md", "workflow-subagent");

    const registry = await createRegistry(options(value));

    const resolvedWorkflow = await registry.resolveWorkflow("same");
    expect(resolvedWorkflow.tier).toBe("project");
    expect((await registry.resolveAgent("workflow-subagent")).tier).toBe(
      "project",
    );
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.workflows)).toBe(true);
    expect(Object.isFrozen(resolvedWorkflow)).toBe(true);
    expect(Object.isFrozen(resolvedWorkflow.meta)).toBe(true);
    const firstByte = resolvedWorkflow.bytes[0];
    resolvedWorkflow.bytes[0] ^= 0xff;
    expect(resolvedWorkflow.bytes[0]).toBe(firstByte);
    expect(
      Object.isFrozen((await registry.resolveAgent("workflow-subagent")).agent),
    ).toBe(true);

    await writeWorkflow(value.projectClaude, "late.js", "late");
    await expect(registry.resolveWorkflow("late")).rejects.toThrow();
  });

  test("uses the builtin agent when optional project and user roots are missing", async () => {
    const value = await layout();
    const registry = await createRegistry(options(value));

    const resolved = await registry.resolveAgent("workflow-subagent");

    expect(resolved.tier).toBe("builtin");
    expect(resolved.source).toMatchObject({
      tier: "builtin",
      identifier: "workflow-subagent",
      realpath: null,
    });
  });

  test("resolves a relative CLAUDE_CONFIG_DIR from canonical session cwd", async () => {
    const value = await layout();
    const relative = "relative-user";
    await writeAgent(join(value.cwd, relative), "nested/user.md", "relative");

    const registry = await createRegistry({
      cwd: value.cwd,
      provider: "claude",
      claudeConfigDir: relative,
      homeDir: join(value.root, "unused-home"),
    });

    expect((await registry.resolveAgent("relative")).tier).toBe("user");
  });

  test("uses ambient CLAUDE_CONFIG_DIR and falls back to home/.claude when empty", async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const value = await layout();
    const ambientRelative = "ambient-relative";
    const home = join(value.root, "home");
    await writeAgent(join(value.cwd, ambientRelative), "ambient.md", "ambient");
    await writeAgent(join(home, ".claude"), "home.md", "home");
    try {
      process.env.CLAUDE_CONFIG_DIR = ambientRelative;
      const ambient = await createRegistry({
        cwd: value.cwd,
        provider: "claude",
        homeDir: home,
      });
      expect((await ambient.resolveAgent("ambient")).tier).toBe("user");

      process.env.CLAUDE_CONFIG_DIR = "";
      const fallback = await createRegistry({
        cwd: value.cwd,
        provider: "claude",
        homeDir: home,
      });
      expect((await fallback.resolveAgent("home")).tier).toBe("user");
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "CLAUDE_CONFIG_DIR");
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("uses manifest namespace, standard plugin roots, and complete provenance", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "directory-name-is-ignored");
    await writePlugin(
      pluginRoot,
      '{"name":"vendor.plugin","opaque":{"workflows":"redirected"}}',
    );
    await writeWorkflow(pluginRoot, "nested/run.js", "run");
    await writeAgent(pluginRoot, "nested/helper.md", "helper");
    await mkdir(join(pluginRoot, "redirected"), { recursive: true });
    await writeFile(
      join(pluginRoot, "redirected", "evil.js"),
      workflow("evil"),
    );

    const registry = await createRegistry({
      ...options(value),
      pluginDirs: [pluginRoot],
    });

    const resolved = await registry.resolveWorkflow("vendor.plugin:run");
    expect(resolved.tier).toBe("plugin");
    expect(resolved.plugin).toMatchObject({
      name: "vendor.plugin",
      reference: pluginRoot,
      rootRealpath: await realpath(pluginRoot),
      manifestRealpath: await realpath(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      ),
      manifestSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect((await registry.resolveAgent("vendor.plugin:helper")).tier).toBe(
      "plugin",
    );
    await expect(registry.resolveWorkflow("run")).rejects.toThrow();
    await expect(registry.resolveWorkflow("evil")).rejects.toThrow();
  });

  test("does not crawl an unconfigured plugin", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "ambient-plugin");
    await writePlugin(pluginRoot, '{"name":"ambient"}');
    await writeWorkflow(pluginRoot, "run.js", "run");

    const registry = await createRegistry(options(value));

    await expect(registry.resolveWorkflow("ambient:run")).rejects.toThrow();
  });

  test("requires the manifest name to be an own property", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "plugin");
    await writePlugin(pluginRoot, "{}");
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "name",
    );
    let failure: unknown;

    try {
      Object.defineProperty(Object.prototype, "name", {
        configurable: true,
        value: "inherited-plugin",
        writable: true,
      });
      try {
        await createRegistry({
          ...options(value),
          pluginDirs: [pluginRoot],
        });
      } catch (error) {
        failure = error;
      }
    } finally {
      if (descriptor === undefined)
        Reflect.deleteProperty(Object.prototype, "name");
      else Object.defineProperty(Object.prototype, "name", descriptor);
    }

    expect(failure).toMatchObject({ code: "CONFIG_ERROR" });
  });

  test.each([
    ["missing", async (root: string) => root],
    [
      "non-directory",
      async (root: string) => {
        await writeFile(root, "not a directory");
        return root;
      },
    ],
    [
      "missing manifest",
      async (root: string) => {
        await mkdir(root, { recursive: true });
        return root;
      },
    ],
    [
      "JSON comment",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid"} // secret-comment');
        return root;
      },
    ],
    [
      "YAML",
      async (root: string) => {
        await writePlugin(root, "name: valid");
        return root;
      },
    ],
    [
      "trailing content",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid"} trailing-secret');
        return root;
      },
    ],
    [
      "duplicate JSON key",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid","name":"other"}');
        return root;
      },
    ],
    [
      "nested duplicate JSON key",
      async (root: string) => {
        await writePlugin(
          root,
          '{"name":"valid","opaque":{"secret":1,"secret":2}}',
        );
        return root;
      },
    ],
    [
      "escaped-equivalent duplicate JSON key",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid","\\u006eame":"other"}');
        return root;
      },
    ],
    [
      "trailing comma",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid",}');
        return root;
      },
    ],
    [
      "alias syntax",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid","opaque":*alias}');
        return root;
      },
    ],
    [
      "anchor syntax",
      async (root: string) => {
        await writePlugin(root, '{"name":"valid","opaque":&anchor 1}');
        return root;
      },
    ],
    [
      "bad name",
      async (root: string) => {
        await writePlugin(root, '{"name":"Bad:Name"}');
        return root;
      },
    ],
    [
      "oversized",
      async (root: string) => {
        await writePlugin(
          root,
          `{"name":"valid","secret":"${"x".repeat(512 * 1024)}"}`,
        );
        return root;
      },
    ],
  ])(
    "fails closed for an explicit plugin root with %s",
    async (_name, setup) => {
      const value = await layout();
      const pluginRoot = await setup(join(value.root, "plugin"));

      let failure: unknown;
      try {
        await createRegistry({
          ...options(value),
          enabledPluginRoots: [pluginRoot],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "CONFIG_ERROR" });
      expect(String(failure)).not.toContain("secret");
    },
  );

  test("canonicalizes and deduplicates configured and enabled plugin roots", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "plugin");
    const linkedRoot = join(value.root, "linked-plugin");
    await writePlugin(pluginRoot, '{"name":"deduped"}');
    await writeWorkflow(pluginRoot, "run.js", "run");
    await symlink(pluginRoot, linkedRoot, "dir");

    const registry = await createRegistry({
      ...options(value),
      pluginDirs: [pluginRoot],
      enabledPluginRoots: [linkedRoot, pluginRoot],
    });

    expect(registry.plugins).toHaveLength(1);
    expect((await registry.resolveWorkflow("deduped:run")).tier).toBe("plugin");
  });

  test("deduplicates canonical files within each registry namespace", async () => {
    const value = await layout();
    const projectWorkflow = await writeWorkflow(
      value.projectClaude,
      "shared.js",
      "shared",
    );
    const projectAgent = await writeAgent(
      value.projectClaude,
      "shared.md",
      "shared",
    );
    const firstPlugin = join(value.root, "first-plugin");
    const secondPlugin = join(value.root, "second-plugin");
    await writePlugin(firstPlugin, '{"name":"p"}');
    await writePlugin(secondPlugin, '{"name":"q"}');
    await mkdir(join(firstPlugin, "workflows"), { recursive: true });
    await mkdir(join(firstPlugin, "agents"), { recursive: true });
    await mkdir(join(secondPlugin, "workflows"), { recursive: true });
    await mkdir(join(secondPlugin, "agents"), { recursive: true });
    await symlink(projectWorkflow, join(firstPlugin, "workflows", "first.js"));
    await symlink(projectWorkflow, join(firstPlugin, "workflows", "second.js"));
    await symlink(projectAgent, join(firstPlugin, "agents", "first.md"));
    await symlink(projectAgent, join(firstPlugin, "agents", "second.md"));
    await symlink(
      projectWorkflow,
      join(secondPlugin, "workflows", "shared.js"),
    );
    await symlink(projectAgent, join(secondPlugin, "agents", "shared.md"));

    const registry = await createRegistry({
      ...options(value),
      pluginDirs: [firstPlugin, secondPlugin],
    });

    await expect(registry.resolveWorkflow("shared")).resolves.toMatchObject({
      tier: "project",
    });
    await expect(registry.resolveWorkflow("p:shared")).resolves.toMatchObject({
      tier: "plugin",
    });
    await expect(registry.resolveWorkflow("q:shared")).resolves.toMatchObject({
      tier: "plugin",
    });
    await expect(registry.resolveAgent("shared")).resolves.toMatchObject({
      tier: "project",
    });
    await expect(registry.resolveAgent("p:shared")).resolves.toMatchObject({
      tier: "plugin",
    });
    await expect(registry.resolveAgent("q:shared")).resolves.toMatchObject({
      tier: "plugin",
    });
    expect(
      registry.workflows.filter((entry) => entry.key === "p:shared"),
    ).toHaveLength(1);
    expect(
      registry.agents.filter((entry) => entry.key === "p:shared"),
    ).toHaveLength(1);
  });

  test.each(["project", "user", "plugin"])(
    "rejects an existing broken symlink %s registry root",
    async (tier) => {
      const value = await layout();
      const missing = join(value.root, "missing-target");
      if (tier === "project") {
        await mkdir(value.projectClaude, { recursive: true });
        await symlink(missing, join(value.projectClaude, "workflows"), "dir");
        await expect(createRegistry(options(value))).rejects.toMatchObject({
          code: "CONFIG_ERROR",
        });
      } else if (tier === "user") {
        await mkdir(value.userClaude, { recursive: true });
        await symlink(missing, join(value.userClaude, "agents"), "dir");
        await expect(createRegistry(options(value))).rejects.toMatchObject({
          code: "CONFIG_ERROR",
        });
      } else {
        const pluginRoot = join(value.root, "plugin");
        await writePlugin(pluginRoot, '{"name":"broken"}');
        await symlink(missing, join(pluginRoot, "workflows"), "dir");
        await expect(
          createRegistry({ ...options(value), pluginDirs: [pluginRoot] }),
        ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
      }
    },
  );

  test("accepts symlink roots and final symlink files but never descends through symlink directories", async () => {
    const value = await layout();
    const physicalWorkflows = join(value.root, "physical-workflows");
    const outside = join(value.root, "outside");
    await mkdir(physicalWorkflows, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(physicalWorkflows, "actual.js"), workflow("actual"));
    await symlink(
      join(physicalWorkflows, "actual.js"),
      join(physicalWorkflows, "duplicate.js"),
    );
    await writeFile(join(outside, "hidden.js"), workflow("hidden"));
    await symlink(outside, join(physicalWorkflows, "linked-directory"), "dir");
    await mkdir(value.projectClaude, { recursive: true });
    await symlink(
      physicalWorkflows,
      join(value.projectClaude, "workflows"),
      "dir",
    );

    const registry = await createRegistry(options(value));

    expect((await registry.resolveWorkflow("actual")).tier).toBe("project");
    expect(
      registry.workflows.filter((entry) => entry.key === "actual"),
    ).toHaveLength(1);
    await expect(registry.resolveWorkflow("hidden")).rejects.toThrow();
  });

  test("preserves exact plugin provenance across symlink manifests and deduplicated external files", async () => {
    const value = await layout();
    const physicalPlugin = join(value.root, "physical-plugin");
    const linkedPlugin = join(value.root, "linked-plugin");
    const external = join(value.root, "external");
    const hiddenDirectory = join(value.root, "hidden-directory");
    const manifestSource = '{"name":"linked"}';
    const workflowSource = workflow("external-workflow");
    const agentSource = agent("external-agent");
    await mkdir(join(physicalPlugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(physicalPlugin, "workflows"), { recursive: true });
    await mkdir(join(physicalPlugin, "agents"), { recursive: true });
    await mkdir(external, { recursive: true });
    await mkdir(hiddenDirectory, { recursive: true });
    const manifestPath = join(external, "manifest.json");
    const workflowPath = join(external, "workflow.js");
    const agentPath = join(external, "agent.md");
    await writeFile(manifestPath, manifestSource);
    await writeFile(workflowPath, workflowSource);
    await writeFile(agentPath, agentSource);
    await writeFile(join(hiddenDirectory, "hidden.js"), workflow("hidden"));
    await symlink(
      manifestPath,
      join(physicalPlugin, ".claude-plugin", "plugin.json"),
    );
    await symlink(workflowPath, join(physicalPlugin, "workflows", "first.js"));
    await symlink(workflowPath, join(physicalPlugin, "workflows", "second.js"));
    await symlink(agentPath, join(physicalPlugin, "agents", "first.md"));
    await symlink(agentPath, join(physicalPlugin, "agents", "second.md"));
    await symlink(
      hiddenDirectory,
      join(physicalPlugin, "workflows", "linked-directory"),
      "dir",
    );
    await symlink(physicalPlugin, linkedPlugin, "dir");

    const registry = await createRegistry({
      ...options(value),
      pluginDirs: [linkedPlugin],
    });
    const plugin = registry.plugins[0];
    const resolvedWorkflow = await registry.resolveWorkflow(
      "linked:external-workflow",
    );
    const resolvedAgent = await registry.resolveAgent("linked:external-agent");

    expect(plugin).toEqual({
      name: "linked",
      reference: linkedPlugin,
      rootRealpath: await realpath(physicalPlugin),
      manifestRealpath: await realpath(manifestPath),
      manifestSha256: `sha256:${createHash("sha256").update(manifestSource).digest("hex")}`,
    });
    expect(resolvedWorkflow.realpath).toBe(await realpath(workflowPath));
    expect(resolvedWorkflow.sha256).toBe(
      `sha256:${createHash("sha256").update(workflowSource).digest("hex")}`,
    );
    expect(resolvedAgent.source).toMatchObject({
      realpath: await realpath(agentPath),
      sha256: `sha256:${createHash("sha256").update(agentSource).digest("hex")}`,
    });
    expect(
      registry.workflows.filter(
        (entry) => entry.key === "linked:external-workflow",
      ),
    ).toHaveLength(1);
    expect(
      registry.agents.filter((entry) => entry.key === "linked:external-agent"),
    ).toHaveLength(1);
    await expect(registry.resolveWorkflow("linked:hidden")).rejects.toThrow();
  });

  test.each([
    [
      "workflow",
      "duplicate.js",
      'duplicate project workflow meta.name "duplicate"',
    ],
    [
      "agent",
      "duplicate.md",
      'duplicate project agent frontmatter name "duplicate"',
    ],
  ])("rejects a same-tier duplicate %s name", async (kind, second, message) => {
    const value = await layout();
    if (kind === "workflow") {
      await writeWorkflow(value.projectClaude, "first.js", "duplicate");
      await writeWorkflow(value.projectClaude, second, "duplicate");
    } else {
      await writeAgent(value.projectClaude, "first.md", "duplicate");
      await writeAgent(value.projectClaude, second, "duplicate");
    }

    await expect(createRegistry(options(value))).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message,
    });
  });

  test.each([
    [
      "project workflow",
      async (value: Layout) =>
        writeWorkflow(value.projectClaude, "bad.js", "bad:name"),
    ],
    [
      "project agent",
      async (value: Layout) =>
        writeAgent(value.projectClaude, "bad.md", "bad:name"),
    ],
  ])("rejects colon in an unqualified %s name", async (_name, setup) => {
    const value = await layout();
    await setup(value);

    await expect(createRegistry(options(value))).rejects.toThrow();
  });

  test("rejects colon in plugin raw names and duplicate namespaced keys", async () => {
    const value = await layout();
    const first = join(value.root, "first");
    const second = join(value.root, "second");
    await writePlugin(first, '{"name":"same"}');
    await writePlugin(second, '{"name":"same"}');
    await writeWorkflow(first, "colon.js", "bad:name");
    await writeWorkflow(second, "run.js", "run");

    await expect(
      createRegistry({ ...options(value), pluginDirs: [first] }),
    ).rejects.toThrow();

    await writeFile(join(first, "workflows", "colon.js"), workflow("run"));
    await expect(
      createRegistry({ ...options(value), pluginDirs: [first, second] }),
    ).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: 'duplicate plugin workflow registry key "same:run"',
    });
  });

  test("compiles and parses every matching candidate while ignoring wrong extensions", async () => {
    const value = await layout();
    await writeWorkflow(value.projectClaude, "bad.js", "valid");
    await writeFile(
      join(value.projectClaude, "workflows", "bad.js"),
      "not valid workflow source",
    );
    await writeFile(
      join(value.projectClaude, "workflows", "ignored.md"),
      "not a workflow",
    );

    await expect(createRegistry(options(value))).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
    });

    await writeFile(
      join(value.projectClaude, "workflows", "bad.js"),
      workflow("valid"),
    );
    await writeAgent(value.projectClaude, "bad.md", "valid");
    await writeFile(
      join(value.projectClaude, "agents", "bad.md"),
      "not an agent definition",
    );
    await expect(createRegistry(options(value))).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
    });
  });

  test("visits candidates in UTF-8 byte order across Unicode planes", async () => {
    const value = await layout();
    await writeWorkflow(
      value.projectClaude,
      `${String.fromCodePoint(0x10000)}.js`,
      "supplementary",
    );
    await writeWorkflow(
      value.projectClaude,
      `${String.fromCodePoint(0xe000)}.js`,
      "private-use",
    );

    const registry = await createRegistry(options(value));

    expect(
      registry.workflows
        .filter((entry) => entry.tier === "project")
        .map((entry) => entry.key),
    ).toEqual(["private-use", "supplementary"]);
  });

  test.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "rejects an invalid UTF-8 registry entry name before path resolution",
    async () => {
      const value = await layout();
      const root = join(value.projectClaude, "workflows");
      await mkdir(root, { recursive: true });
      const path = Buffer.concat([
        Buffer.from(`${root}/`),
        Buffer.from([0xff, 0x2e, 0x6a, 0x73]),
      ]);
      await writeFile(path, workflow("invalid-name"));

      await expect(createRegistry(options(value))).rejects.toThrowError(
        /entry name is not valid UTF-8/,
      );
    },
  );

  test("snapshots exact options and arrays before its first await", async () => {
    const value = await layout();
    const pluginRoot = join(value.root, "plugin");
    await writePlugin(pluginRoot, '{"name":"snapshotted"}');
    const pluginDirs = [pluginRoot];
    const pending = createRegistry({ ...options(value), pluginDirs });
    pluginDirs.push(join(value.root, "missing-after-call"));

    await expect(pending).resolves.toMatchObject({
      plugins: [{ name: "snapshotted" }],
    });

    const enabledRoot = join(value.root, "enabled");
    await writePlugin(enabledRoot, '{"name":"enabled"}');
    const enabledPluginRoots = [enabledRoot];
    const enabledPending = createRegistry({
      ...options(value),
      enabledPluginRoots,
    });
    enabledPluginRoots.push(join(value.root, "missing-enabled-after-call"));
    await expect(enabledPending).resolves.toMatchObject({
      plugins: [{ name: "enabled" }],
    });

    let optionGetterCalls = 0;
    const getter = Object.create(Object.prototype, {
      cwd: { enumerable: true, value: value.cwd },
      pluginDirs: { enumerable: true, value: [] },
      enabledPluginRoots: { enumerable: true, value: [] },
      claudeConfigDir: {
        enumerable: true,
        get: () => {
          optionGetterCalls += 1;
          return value.userClaude;
        },
      },
      homeDir: {
        enumerable: true,
        value: join(value.root, "unused-home"),
      },
    });
    await expect(createRegistry(getter)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    expect(optionGetterCalls).toBe(0);
    await expect(
      createRegistry(new Proxy(options(value), {})),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      createRegistry({ ...options(value), extra: true } as never),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      createRegistry({ ...options(value), [Symbol("x")]: true } as never),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      createRegistry({
        cwd: value.cwd,
        homeDir: join(value.root, "unused-home"),
      } as never),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      createRegistry({ ...options(value), provider: "other" } as never),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    let arrayGetterCalls = 0;
    const accessorArray = [pluginRoot];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return pluginRoot;
      },
    });
    await expect(
      createRegistry({ ...options(value), pluginDirs: accessorArray }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(arrayGetterCalls).toBe(0);

    await expect(
      createRegistry({
        ...options(value),
        pluginDirs: new Array<string>(1),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    const extraArray = [pluginRoot] as string[] & { extra?: boolean };
    extraArray.extra = true;
    await expect(
      createRegistry({ ...options(value), pluginDirs: extraArray }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    const symbolArray = [pluginRoot];
    Object.defineProperty(symbolArray, Symbol("x"), {
      enumerable: true,
      value: true,
    });
    await expect(
      createRegistry({ ...options(value), pluginDirs: symbolArray }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
