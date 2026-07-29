import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";
import { isMap, isScalar, parseDocument, visit } from "yaml";

import { AwslError } from "../core/errors.js";
import type { AgentEffort, JsonValue } from "../core/types.js";
export type AgentDefinitionSource =
  | {
      tier: "project" | "user" | "plugin";
      realpath: string;
      sha256: `sha256:${string}`;
    }
  | {
      tier: "builtin";
      identifier: "workflow-subagent";
      realpath: null;
      sha256: `sha256:${string}`;
    };
export interface RawAgentDefinition {
  name: string;
  instructions: string;
  description?: string;
  color?: string;
  initialPrompt?: string;
  model?: string;
  effort?: AgentEffort;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  mcp?: Readonly<Record<string, JsonValue>>;
  permissionMode?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  skills?: readonly string[];
  source: AgentDefinitionSource;
}

const allowed = new Set([
  "name",
  "description",
  "model",
  "effort",
  "tools",
  "disallowedTools",
  "mcpServers",
  "permissionMode",
  "skills",
  "color",
  "initialPrompt",
]);
const efforts = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_INSTRUCTION_BYTES = 65536;

function fail(message: string): never {
  throw new AwslError("COMPATIBILITY_ERROR", message, { recoverable: false });
}
function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    fail(`agent ${field} must be a nonempty NUL-free string`);
  return value;
}
export function freezeAgentDefinition<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeAgentDefinition(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshotAgentDefinitionSource(
  value: unknown,
): AgentDefinitionSource {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value))
    fail("agent source must be exact immutable data");
  try {
    const proto = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (
      (proto !== Object.prototype && proto !== null) ||
      keys.some((key) => typeof key !== "string")
    )
      fail("agent source must be exact immutable data");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys as string[])
      if (!descriptors[key]?.enumerable || !("value" in descriptors[key]))
        fail("agent source must be exact immutable data");
    const actual = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) actual[key] = descriptors[key].value;
    const hash = actual.sha256;
    if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash))
      fail("agent source must be exact immutable data");
    if (
      actual.tier === "builtin" &&
      keys.length === 4 &&
      actual.identifier === "workflow-subagent" &&
      actual.realpath === null
    )
      return freezeAgentDefinition({
        tier: "builtin",
        identifier: "workflow-subagent",
        realpath: null,
        sha256: hash as `sha256:${string}`,
      });
    if (
      (actual.tier === "project" ||
        actual.tier === "user" ||
        actual.tier === "plugin") &&
      keys.length === 3 &&
      typeof actual.realpath === "string" &&
      isAbsolute(actual.realpath) &&
      actual.realpath &&
      !actual.realpath.includes("\0")
    )
      return freezeAgentDefinition({
        tier: actual.tier,
        realpath: actual.realpath,
        sha256: hash as `sha256:${string}`,
      });
  } catch (error) {
    if (error instanceof AwslError) throw error;
  }
  return fail("agent source must be exact immutable data");
}
function tokens(value: unknown, field: string): readonly string[] {
  const values =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : fail(`agent ${field} must be CSV or an array`);
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string")
      fail(`agent ${field} entries must be strings`);
    const token = item.trim();
    if (
      !token ||
      token.startsWith("-") ||
      token.includes("\0") ||
      result.includes(token)
    )
      fail(`agent ${field} entries must be unique nonempty strings`);
    result.push(token);
  }
  return freezeAgentDefinition(result);
}
function jsonClone(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : fail("agent mcpServers must be JSON data");
  if (Array.isArray(value)) return freezeAgentDefinition(value.map(jsonClone));
  if (!value || typeof value !== "object" || utilTypes.isProxy(value))
    fail("agent mcpServers must be a JSON object");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    fail("agent mcpServers must be JSON data");
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value))
    Object.defineProperty(result, key, {
      value: jsonClone((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  return freezeAgentDefinition(result);
}

export function parseAgentDefinition(
  markdown: string,
  source: AgentDefinitionSource,
): RawAgentDefinition {
  const sourceSnapshot = snapshotAgentDefinitionSource(source);
  if (
    typeof markdown !== "string" ||
    Buffer.byteLength(markdown, "utf8") > MAX_DOCUMENT_BYTES
  )
    fail("agent definition exceeds 512 KiB");
  const sha256 =
    `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}` as const;
  if (sourceSnapshot.sha256 !== sha256)
    fail("agent source hash does not match its content");
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n"))
    fail("agent definition must begin with frontmatter");
  const firstEnd = markdown.indexOf("\n");
  const start = firstEnd + 1;
  const terminator = /(?:^|\n)---\r?\n/g;
  terminator.lastIndex = start - 1;
  const match = terminator.exec(markdown);
  if (!match) fail("agent frontmatter is unterminated");
  const yamlText = markdown.slice(
    start,
    match.index + (match[0].startsWith("\n") ? 0 : 0),
  );
  const body = markdown.slice(match.index + match[0].length);
  if (
    !body.trim() ||
    body.includes("\0") ||
    Buffer.byteLength(body, "utf8") > MAX_INSTRUCTION_BYTES
  )
    fail(
      "agent instructions must be nonempty NUL-free text within 65536 bytes",
    );
  const document = parseDocument(yamlText, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
  });
  if (document.errors.length || document.warnings.length)
    fail("agent frontmatter is invalid YAML");
  let forbidden = false;
  visit(document, {
    Alias: () => {
      forbidden = true;
    },
    Map: (_key, map) => {
      if (map?.anchor) forbidden = true;
      if (map)
        for (const pair of map.items)
          if (
            !isScalar(pair.key) ||
            typeof pair.key.value !== "string" ||
            pair.key.value === "<<"
          )
            forbidden = true;
    },
    Scalar: (_key, scalar) => {
      if (scalar?.anchor) forbidden = true;
    },
    Seq: (_key, sequence) => {
      if (sequence?.anchor) forbidden = true;
    },
  });
  if (forbidden || !isMap(document.contents))
    fail("agent frontmatter must be a plain mapping");
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("agent frontmatter must be a plain mapping");
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields))
    if (!allowed.has(key)) fail("agent frontmatter contains an unknown field");
  const name = nonemptyString(fields.name, "name");
  if (name.includes(":")) fail("agent name must not contain ':'");
  const result: RawAgentDefinition = {
    name,
    instructions: body,
    source: sourceSnapshot,
  };
  for (const field of [
    "description",
    "model",
    "permissionMode",
    "color",
    "initialPrompt",
  ] as const)
    if (fields[field] !== undefined)
      result[field] = nonemptyString(fields[field], field);
  if (fields.effort !== undefined) {
    if (
      typeof fields.effort !== "string" ||
      !efforts.has(fields.effort as AgentEffort)
    )
      fail("agent effort is invalid");
    result.effort = fields.effort as AgentEffort;
  }
  if (fields.tools !== undefined) result.tools = tokens(fields.tools, "tools");
  if (fields.disallowedTools !== undefined)
    result.disallowedTools = tokens(fields.disallowedTools, "disallowedTools");
  if (fields.skills !== undefined) {
    if (
      !Array.isArray(fields.skills) ||
      fields.skills.some(
        (item) => typeof item !== "string" || !item || item.includes("\0"),
      ) ||
      new Set(fields.skills).size !== fields.skills.length
    )
      fail("agent skills must be unique nonempty strings");
    result.skills = freezeAgentDefinition([...fields.skills] as string[]);
  }
  if (fields.mcpServers !== undefined) {
    if (
      !fields.mcpServers ||
      typeof fields.mcpServers !== "object" ||
      Array.isArray(fields.mcpServers)
    )
      fail("agent mcpServers must be a JSON object");
    result.mcp = jsonClone(fields.mcpServers) as Readonly<
      Record<string, JsonValue>
    >;
  }
  return freezeAgentDefinition(result);
}
