import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { types as utilTypes } from "node:util";
import { parseDocument } from "yaml";

import {
  type ReadSnapshot,
  canonicalCwd,
  lexicalPath,
  readRegularUtf8,
  resolveProjectRoot,
} from "../config/paths.js";
import type { ResolvedWorkflowSource } from "../config/workflow-resolver.js";
import { AwslError } from "../core/errors.js";
import type { ProviderId } from "../core/types.js";
import {
  type AgentDefinitionSource,
  type RawAgentDefinition,
  parseAgentDefinition,
} from "./agent-definition.js";
import { WORKFLOW_SUBAGENT_SOURCE } from "./builtins/workflow-subagent.js";
import { parseCodexAgentDefinition } from "./codex-agent-definition.js";
import { type CompiledWorkflow, compileWorkflow } from "./compile.js";

export type RegistryTier = "project" | "user" | "builtin" | "plugin";

export interface RegistryPluginProvenance {
  readonly name: string;
  readonly reference: string;
  readonly rootRealpath: string;
  readonly manifestRealpath: string;
  readonly manifestSha256: `sha256:${string}`;
}

export interface RegistryWorkflowEntry extends ResolvedWorkflowSource {
  readonly key: string;
  readonly tier: Exclude<RegistryTier, "builtin">;
  readonly plugin?: RegistryPluginProvenance;
}

export interface RegistryAgentEntry {
  readonly key: string;
  readonly tier: RegistryTier;
  readonly source: AgentDefinitionSource;
  readonly agent: RawAgentDefinition;
  readonly plugin?: RegistryPluginProvenance;
}

export interface AgentRegistry {
  readonly workflows: readonly RegistryWorkflowEntry[];
  readonly agents: readonly RegistryAgentEntry[];
  readonly plugins: readonly RegistryPluginProvenance[];
  resolveWorkflow(key: string): Promise<RegistryWorkflowEntry>;
  resolveAgent(key: string): Promise<RegistryAgentEntry>;
}

export interface CreateRegistryOptions {
  cwd: string;
  provider: ProviderId;
  pluginDirs?: readonly string[];
  enabledPluginRoots?: readonly string[];
  claudeConfigDir?: string;
  codexConfigDir?: string;
  homeDir?: string;
}

interface SnapshottedOptions {
  cwd: string;
  provider: ProviderId;
  pluginDirs: readonly string[];
  enabledPluginRoots: readonly string[];
  claudeConfigDir?: string;
  codexConfigDir?: string;
  homeDir?: string;
}

const optionKeys = new Set([
  "cwd",
  "provider",
  "pluginDirs",
  "enabledPluginRoots",
  "claudeConfigDir",
  "codexConfigDir",
  "homeDir",
]);
const pluginName = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const entryNameDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

function registryError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function resolutionError(kind: "workflow" | "agent"): never {
  throw new AwslError(
    "COMPATIBILITY_ERROR",
    `${kind} registry entry was not found`,
    { recoverable: false },
  );
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value))
    return registryError(`${field} must be an exact string array`);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      return registryError(`${field} must be an exact string array`);
    const names = Reflect.ownKeys(value);
    if (
      names.length !== value.length + 1 ||
      names.some(
        (name) =>
          typeof name !== "string" ||
          (name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name)),
      )
    )
      return registryError(`${field} must be an exact string array`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        return registryError(`${field} must be an exact string array`);
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof AwslError) throw error;
    return registryError(`${field} must be an exact string array`);
  }
}

function snapshotOptions(value: unknown): SnapshottedOptions {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value))
    return registryError("registry options must be an exact data object");
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string" || !optionKeys.has(key))
    )
      return registryError("registry options must be an exact data object");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor))
        return registryError("registry options must be an exact data object");
      fields[key] = descriptor.value;
    }
    if (typeof fields.cwd !== "string")
      return registryError("registry cwd must be a string");
    if (fields.provider !== "codex" && fields.provider !== "claude")
      return registryError("registry provider must be codex or claude");
    for (const key of ["claudeConfigDir", "codexConfigDir", "homeDir"] as const)
      if (fields[key] !== undefined && typeof fields[key] !== "string")
        return registryError(`registry ${key} must be a string`);
    return {
      cwd: fields.cwd,
      provider: fields.provider,
      pluginDirs:
        fields.pluginDirs === undefined
          ? Object.freeze([])
          : stringArray(fields.pluginDirs, "pluginDirs"),
      enabledPluginRoots:
        fields.enabledPluginRoots === undefined
          ? Object.freeze([])
          : stringArray(fields.enabledPluginRoots, "enabledPluginRoots"),
      ...(fields.claudeConfigDir === undefined
        ? {}
        : { claudeConfigDir: fields.claudeConfigDir }),
      ...(fields.codexConfigDir === undefined
        ? {}
        : { codexConfigDir: fields.codexConfigDir }),
      ...(fields.homeDir === undefined ? {} : { homeDir: fields.homeDir }),
    } as SnapshottedOptions;
  } catch (error) {
    if (error instanceof AwslError) throw error;
    return registryError("registry options must be an exact data object");
  }
}

async function canonicalDirectory(
  reference: string,
  cwd: string,
  required: boolean,
): Promise<string | null> {
  const target = lexicalPath(reference, cwd);
  try {
    await lstat(target);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    return registryError("registry root is missing or inaccessible");
  }
  let physical: string;
  try {
    physical = await realpath(target);
  } catch {
    return registryError("registry root is missing or inaccessible");
  }
  try {
    if (!(await stat(physical)).isDirectory())
      return registryError("registry root must be a directory");
  } catch (error) {
    if (error instanceof AwslError) throw error;
    return registryError("registry root is inaccessible");
  }
  return physical;
}

function entryName(value: Buffer): string {
  try {
    return entryNameDecoder.decode(value);
  } catch {
    return registryError("registry entry name is not valid UTF-8");
  }
}

async function candidates(
  root: string | null,
  extension: ".js" | ".md" | ".toml",
): Promise<readonly string[]> {
  if (root === null) return Object.freeze([]);
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<Buffer>[];
    try {
      entries = await readdir(directory, {
        withFileTypes: true,
        encoding: "buffer",
      });
    } catch {
      return registryError("registry root cannot be scanned");
    }
    entries.sort((left, right) => Buffer.compare(left.name, right.name));
    for (const entry of entries) {
      const name = entryName(entry.name);
      const path = join(directory, name);
      if (entry.isSymbolicLink()) {
        if (extname(name) !== extension) continue;
        try {
          if ((await stat(path)).isDirectory()) continue;
        } catch {
          return registryError("registry symlink target is inaccessible");
        }
        result.push(path);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && extname(name) === extension) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return Object.freeze(result);
}

function deepFreezeMetadata(compiled: CompiledWorkflow): void {
  for (const phase of compiled.meta.phases ?? []) Object.freeze(phase);
  Object.freeze(compiled.meta.phases);
  Object.freeze(compiled.meta);
  Object.freeze(compiled);
}

function workflowEntry(
  key: string,
  tier: Exclude<RegistryTier, "builtin">,
  snapshot: ReadSnapshot,
  plugin?: RegistryPluginProvenance,
): RegistryWorkflowEntry {
  const compiled = compileWorkflow(snapshot.source, snapshot.realpath);
  if (compiled.meta.name.includes(":"))
    registryError("registry workflow name must not contain ':'");
  deepFreezeMetadata(compiled);
  const bytes = new Uint8Array(snapshot.bytes);
  const entry = {
    key,
    tier,
    reference: key,
    realpath: snapshot.realpath,
    source: snapshot.source,
    sha256: snapshot.sha256,
    ...compiled,
    ...(plugin === undefined ? {} : { plugin }),
  };
  Object.defineProperty(entry, "bytes", {
    enumerable: true,
    get: () => new Uint8Array(bytes),
  });
  return Object.freeze(entry) as RegistryWorkflowEntry;
}

function agentEntry(
  key: string,
  tier: RegistryTier,
  snapshot: ReadSnapshot | null,
  provider: ProviderId,
  plugin?: RegistryPluginProvenance,
): RegistryAgentEntry | null {
  const source: AgentDefinitionSource =
    tier === "builtin"
      ? {
          tier: "builtin",
          identifier: "workflow-subagent",
          realpath: null,
          sha256: `sha256:${createHash("sha256").update(WORKFLOW_SUBAGENT_SOURCE, "utf8").digest("hex")}`,
        }
      : {
          tier,
          realpath: (snapshot as ReadSnapshot).realpath,
          sha256: (snapshot as ReadSnapshot).sha256,
        };
  const definition =
    tier === "builtin" || provider === "claude"
      ? parseAgentDefinition(
          tier === "builtin"
            ? WORKFLOW_SUBAGENT_SOURCE
            : (snapshot as ReadSnapshot).source,
          source,
        )
      : parseCodexAgentDefinition((snapshot as ReadSnapshot).source, source);
  if (definition === null) return null;
  if (definition.name.includes(":"))
    registryError("registry agent name must not contain ':'");
  return Object.freeze({
    key,
    tier,
    source: definition.source,
    agent: definition,
    ...(plugin === undefined ? {} : { plugin }),
  });
}

function parseManifest(snapshot: ReadSnapshot): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.source);
  } catch {
    return registryError("plugin manifest is not strict JSON");
  }
  try {
    const document = parseDocument(snapshot.source, {
      version: "1.2",
      schema: "json",
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length)
      return registryError("plugin manifest is not unique-key JSON");
  } catch {
    return registryError("plugin manifest is not unique-key JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return registryError("plugin manifest must be an object");
  if (!Object.hasOwn(parsed, "name"))
    return registryError("plugin manifest name is invalid");
  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== "string" || !pluginName.test(name))
    return registryError("plugin manifest name is invalid");
  return name;
}

async function pluginProvenance(
  reference: string,
  rootRealpath: string,
  cwd: string,
): Promise<RegistryPluginProvenance> {
  const manifest = await readRegularUtf8(
    join(rootRealpath, ".claude-plugin", "plugin.json"),
    cwd,
  );
  return Object.freeze({
    name: parseManifest(manifest),
    reference,
    rootRealpath,
    manifestRealpath: manifest.realpath,
    manifestSha256: manifest.sha256,
  });
}

function boundedKey(key: string): string {
  return JSON.stringify(key.length <= 128 ? key : `${key.slice(0, 128)}...`);
}

function tierCollision(
  tier: "project" | "user",
  kind: "workflow" | "agent",
  key: string,
): never {
  const field = kind === "workflow" ? "meta.name" : "frontmatter name";
  return registryError(`duplicate ${tier} ${kind} ${field} ${boundedKey(key)}`);
}

function pluginCollision(kind: "workflow" | "agent", key: string): never {
  return registryError(
    `duplicate plugin ${kind} registry key ${boundedKey(key)}`,
  );
}

export async function createRegistry(
  input: CreateRegistryOptions,
): Promise<AgentRegistry> {
  const captured = snapshotOptions(input);
  const ambientClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const ambientCodexConfigDir = process.env.CODEX_HOME;
  const home = captured.homeDir ?? homedir();
  const claudeReference =
    captured.claudeConfigDir || ambientClaudeConfigDir || join(home, ".claude");
  const codexReference =
    captured.codexConfigDir || ambientCodexConfigDir || join(home, ".codex");
  const userAgentReference =
    captured.provider === "claude" ? claudeReference : codexReference;
  const cwd = await canonicalCwd(captured.cwd);
  const projectRoot = await resolveProjectRoot(cwd);
  const projectWorkflowRoot = await canonicalDirectory(
    join(projectRoot, ".claude", "workflows"),
    cwd,
    false,
  );
  const projectAgentRoot = await canonicalDirectory(
    join(projectRoot, `.${captured.provider}`, "agents"),
    cwd,
    false,
  );
  const userWorkflowRoot = await canonicalDirectory(
    join(claudeReference, "workflows"),
    cwd,
    false,
  );
  const userAgentRoot = await canonicalDirectory(
    join(userAgentReference, "agents"),
    cwd,
    false,
  );

  const pluginRoots: {
    reference: string;
    realpath: string;
  }[] = [];
  const seenPluginRoots = new Set<string>();
  for (const reference of [
    ...captured.pluginDirs,
    ...captured.enabledPluginRoots,
  ]) {
    const root = await canonicalDirectory(reference, cwd, true);
    if (root === null || seenPluginRoots.has(root)) continue;
    seenPluginRoots.add(root);
    pluginRoots.push({ reference, realpath: root });
  }

  const workflows = new Map<string, RegistryWorkflowEntry>();
  const agents = new Map<string, RegistryAgentEntry>();
  const seenUnqualifiedWorkflowRealpaths = new Set<string>();
  const seenUnqualifiedAgentRealpaths = new Set<string>();
  const tierWorkflowNames = new Map<string, Set<string>>();
  const tierAgentNames = new Map<string, Set<string>>();

  const scanWorkflowTier = async (
    tier: "project" | "user",
    root: string | null,
  ): Promise<void> => {
    const names = tierWorkflowNames.get(tier) ?? new Set<string>();
    tierWorkflowNames.set(tier, names);
    for (const path of await candidates(root, ".js")) {
      const snapshot = await readRegularUtf8(path, cwd);
      if (seenUnqualifiedWorkflowRealpaths.has(snapshot.realpath)) continue;
      seenUnqualifiedWorkflowRealpaths.add(snapshot.realpath);
      const compiled = compileWorkflow(snapshot.source, snapshot.realpath);
      const key = compiled.meta.name;
      if (key.includes(":"))
        registryError("registry workflow name must not contain ':'");
      if (names.has(key)) tierCollision(tier, "workflow", key);
      names.add(key);
      const entry = workflowEntry(key, tier, snapshot);
      if (!workflows.has(key)) workflows.set(key, entry);
    }
  };

  const scanAgentTier = async (
    tier: "project" | "user",
    root: string | null,
  ): Promise<void> => {
    const names = tierAgentNames.get(tier) ?? new Set<string>();
    tierAgentNames.set(tier, names);
    for (const path of await candidates(
      root,
      captured.provider === "claude" ? ".md" : ".toml",
    )) {
      const snapshot = await readRegularUtf8(path, cwd);
      if (seenUnqualifiedAgentRealpaths.has(snapshot.realpath)) continue;
      seenUnqualifiedAgentRealpaths.add(snapshot.realpath);
      const entry = agentEntry("", tier, snapshot, captured.provider);
      if (entry === null) continue;
      const key = entry.agent.name;
      if (key.includes(":"))
        registryError("registry agent name must not contain ':'");
      if (names.has(key)) tierCollision(tier, "agent", key);
      names.add(key);
      const keyed = Object.freeze({ ...entry, key });
      if (!agents.has(key)) agents.set(key, keyed);
    }
  };

  await scanWorkflowTier("project", projectWorkflowRoot);
  await scanWorkflowTier("user", userWorkflowRoot);
  await scanAgentTier("project", projectAgentRoot);
  await scanAgentTier("user", userAgentRoot);

  const builtin = agentEntry(
    "workflow-subagent",
    "builtin",
    null,
    captured.provider,
  );
  if (builtin === null) registryError("builtin agent definition is invalid");
  if (!agents.has(builtin.key)) agents.set(builtin.key, builtin);

  const plugins: RegistryPluginProvenance[] = [];
  const pluginWorkflowKeys = new Set<string>();
  const pluginAgentKeys = new Set<string>();
  const seenPluginWorkflowRealpaths = new Map<string, Set<string>>();
  const seenPluginAgentRealpaths = new Map<string, Set<string>>();
  for (const root of pluginRoots) {
    const plugin = await pluginProvenance(root.reference, root.realpath, cwd);
    plugins.push(plugin);
    const workflowRealpaths =
      seenPluginWorkflowRealpaths.get(plugin.name) ?? new Set<string>();
    const agentRealpaths =
      seenPluginAgentRealpaths.get(plugin.name) ?? new Set<string>();
    seenPluginWorkflowRealpaths.set(plugin.name, workflowRealpaths);
    seenPluginAgentRealpaths.set(plugin.name, agentRealpaths);
    const workflowRoot = await canonicalDirectory(
      join(root.realpath, "workflows"),
      cwd,
      false,
    );
    for (const path of await candidates(workflowRoot, ".js")) {
      const snapshot = await readRegularUtf8(path, cwd);
      if (workflowRealpaths.has(snapshot.realpath)) continue;
      workflowRealpaths.add(snapshot.realpath);
      const compiled = compileWorkflow(snapshot.source, snapshot.realpath);
      if (compiled.meta.name.includes(":"))
        registryError("registry workflow name must not contain ':'");
      const key = `${plugin.name}:${compiled.meta.name}`;
      if (pluginWorkflowKeys.has(key) || workflows.has(key))
        pluginCollision("workflow", key);
      pluginWorkflowKeys.add(key);
      workflows.set(key, workflowEntry(key, "plugin", snapshot, plugin));
    }
    if (captured.provider === "claude") {
      const agentRoot = await canonicalDirectory(
        join(root.realpath, "agents"),
        cwd,
        false,
      );
      for (const path of await candidates(agentRoot, ".md")) {
        const snapshot = await readRegularUtf8(path, cwd);
        if (agentRealpaths.has(snapshot.realpath)) continue;
        agentRealpaths.add(snapshot.realpath);
        const unkeyed = agentEntry(
          "",
          "plugin",
          snapshot,
          captured.provider,
          plugin,
        );
        if (unkeyed === null) continue;
        if (unkeyed.agent.name.includes(":"))
          registryError("registry agent name must not contain ':'");
        const key = `${plugin.name}:${unkeyed.agent.name}`;
        if (pluginAgentKeys.has(key) || agents.has(key))
          pluginCollision("agent", key);
        pluginAgentKeys.add(key);
        agents.set(key, Object.freeze({ ...unkeyed, key }));
      }
    }
  }

  const workflowEntries = Object.freeze([...workflows.values()]);
  const agentEntries = Object.freeze([...agents.values()]);
  const pluginEntries = Object.freeze([...plugins]);
  return Object.freeze({
    workflows: workflowEntries,
    agents: agentEntries,
    plugins: pluginEntries,
    async resolveWorkflow(key: string): Promise<RegistryWorkflowEntry> {
      if (typeof key !== "string" || !key || key.includes("\0"))
        return resolutionError("workflow");
      return workflows.get(key) ?? resolutionError("workflow");
    },
    async resolveAgent(key: string): Promise<RegistryAgentEntry> {
      if (typeof key !== "string" || !key || key.includes("\0"))
        return resolutionError("agent");
      return agents.get(key) ?? resolutionError("agent");
    },
  });
}
