import { isAbsolute } from "node:path";

import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type {
  AgentEffort,
  JsonValue,
  NegotiatedAgentPolicy,
  ProviderCapabilities,
  ProviderId,
  ResolvedAgentSelection,
} from "../core/types.js";
import type { RawAgentDefinition } from "./agent-definition.js";

const rawFields = new Set([
  "name",
  "instructions",
  "description",
  "color",
  "initialPrompt",
  "model",
  "effort",
  "tools",
  "disallowedTools",
  "mcp",
  "permissionMode",
  "sandboxMode",
  "skills",
  "source",
]);
const efforts = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const codexSandboxModes = new Set<
  NonNullable<RawAgentDefinition["sandboxMode"]>
>(["read-only", "workspace-write", "danger-full-access"]);

function fail(provider: ProviderId, message: string): never {
  throw new AwslError("COMPATIBILITY_ERROR", message, {
    provider,
    recoverable: false,
  });
}

function snapshotRecord(
  value: unknown,
  provider: ProviderId,
  message: string,
): Record<string, unknown> {
  try {
    const snapshot = strictJsonClone(value, "agent negotiation input");
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot)
    )
      return fail(provider, message);
    return snapshot as Record<string, unknown>;
  } catch {
    return fail(provider, message);
  }
}

function stringValue(
  value: unknown,
  provider: ProviderId,
  message: string,
): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    return fail(provider, message);
  return value;
}

function stringList(value: unknown, provider: ProviderId): readonly string[] {
  if (!Array.isArray(value))
    return fail(provider, "agent definition is not normalized");
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item ||
      item !== item.trim() ||
      item.startsWith("-") ||
      item.includes("\0") ||
      result.includes(item)
    )
      return fail(provider, "agent definition is not normalized");
    result.push(item);
  }
  return Object.freeze(result);
}

function validSource(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const hash = source.sha256;
  if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash))
    return false;
  if (source.tier === "builtin")
    return (
      keys.length === 4 &&
      source.identifier === "workflow-subagent" &&
      source.realpath === null
    );
  return (
    (source.tier === "project" ||
      source.tier === "user" ||
      source.tier === "plugin") &&
    keys.length === 3 &&
    typeof source.realpath === "string" &&
    isAbsolute(source.realpath) &&
    !source.realpath.includes("\0")
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotRaw(
  value: RawAgentDefinition,
  provider: ProviderId,
): Record<string, unknown> {
  const raw = snapshotRecord(
    value,
    provider,
    "agent definition must be exact data",
  );
  const keys = Object.keys(raw);
  if (
    keys.some((key) => !rawFields.has(key)) ||
    !Object.hasOwn(raw, "name") ||
    !Object.hasOwn(raw, "instructions") ||
    !Object.hasOwn(raw, "source") ||
    !validSource(raw.source)
  )
    return fail(provider, "agent definition is not normalized");

  const name = stringValue(
    raw.name,
    provider,
    "agent definition is not normalized",
  );
  const instructions = stringValue(
    raw.instructions,
    provider,
    "agent definition is not normalized",
  );
  if (
    name.includes(":") ||
    !instructions.trim() ||
    Buffer.byteLength(instructions, "utf8") > 65_536
  )
    return fail(provider, "agent definition is not normalized");
  for (const field of [
    "description",
    "color",
    "initialPrompt",
    "model",
    "permissionMode",
    "sandboxMode",
  ])
    if (Object.hasOwn(raw, field))
      stringValue(raw[field], provider, "agent definition is not normalized");
  if (
    Object.hasOwn(raw, "effort") &&
    (typeof raw.effort !== "string" || !efforts.has(raw.effort as AgentEffort))
  )
    return fail(provider, "agent definition is not normalized");
  for (const field of ["tools", "disallowedTools", "skills"])
    if (Object.hasOwn(raw, field))
      raw[field] = stringList(raw[field], provider);
  if (
    Object.hasOwn(raw, "mcp") &&
    (raw.mcp === null || typeof raw.mcp !== "object" || Array.isArray(raw.mcp))
  )
    return fail(provider, "agent definition is not normalized");
  return raw;
}

function snapshotCapabilities(
  value: ProviderCapabilities,
  provider: ProviderId,
): Record<string, unknown> {
  return snapshotRecord(
    value,
    provider,
    "provider capabilities must be exact data",
  );
}

export function negotiateAgent(
  definition: RawAgentDefinition,
  provider: ProviderId,
  capabilities: ProviderCapabilities,
): ResolvedAgentSelection {
  if (provider !== "codex" && provider !== "claude")
    throw new AwslError(
      "COMPATIBILITY_ERROR",
      "agent provider is unsupported",
      { recoverable: false },
    );
  const raw = snapshotRaw(definition, provider);
  const supported = snapshotCapabilities(capabilities, provider);
  if (supported.skills !== false)
    return fail(provider, "provider skill capability is invalid");
  const expectedPrompt = provider === "codex" ? "prompt-prefix" : "replace";
  if (supported.systemPrompt !== expectedPrompt)
    return fail(provider, "provider cannot preserve agent instructions");

  const skills = Object.hasOwn(raw, "skills")
    ? stringList(raw.skills, provider)
    : Object.freeze([]);
  if (skills.length > 0)
    return fail(provider, "provider cannot preserve agent skills");

  const policy: {
    name: string;
    instructions: string;
    tools?: readonly string[];
    disallowedTools?: readonly string[];
    mcp?: Readonly<Record<string, JsonValue>>;
    permissionMode?: string;
    sandboxMode?: NonNullable<RawAgentDefinition["sandboxMode"]>;
  } = {
    name: raw.name as string,
    instructions: raw.instructions as string,
  };

  if (provider === "codex") {
    if (
      Object.hasOwn(raw, "tools") ||
      Object.hasOwn(raw, "disallowedTools") ||
      Object.hasOwn(raw, "mcp") ||
      Object.hasOwn(raw, "permissionMode")
    )
      return fail(provider, "Codex cannot preserve explicit agent policy");
    if (Object.hasOwn(raw, "sandboxMode")) {
      const sandboxMode = raw.sandboxMode;
      if (
        typeof sandboxMode !== "string" ||
        !codexSandboxModes.has(
          sandboxMode as NonNullable<RawAgentDefinition["sandboxMode"]>,
        ) ||
        !Array.isArray(supported.sandboxModes) ||
        !supported.sandboxModes.includes(
          sandboxMode as NonNullable<RawAgentDefinition["sandboxMode"]>,
        )
      )
        return fail(
          provider,
          "Codex cannot preserve the requested sandbox mode",
        );
      policy.sandboxMode = sandboxMode as NonNullable<
        RawAgentDefinition["sandboxMode"]
      >;
    }
  } else {
    if (Object.hasOwn(raw, "sandboxMode"))
      return fail(provider, "Claude cannot preserve a Codex sandbox mode");
    const toolCapabilities = snapshotRecord(
      supported.tools,
      provider,
      "provider tool capabilities are invalid",
    );
    const mcpCapabilities = snapshotRecord(
      supported.mcp,
      provider,
      "provider MCP capabilities are invalid",
    );
    if (Object.hasOwn(raw, "tools")) {
      const tools = raw.tools as readonly string[];
      if (
        (tools.length === 0 && toolCapabilities.denyAll !== true) ||
        (tools.length > 0 && toolCapabilities.allowlist !== true)
      )
        return fail(provider, "Claude cannot preserve the tool policy");
      policy.tools = tools;
    }
    if (Object.hasOwn(raw, "disallowedTools")) {
      if (toolCapabilities.denylist !== true)
        return fail(provider, "Claude cannot preserve the tool policy");
      policy.disallowedTools = raw.disallowedTools as readonly string[];
    }
    if (Object.hasOwn(raw, "mcp")) {
      if (mcpCapabilities.strictReplacement !== true)
        return fail(provider, "Claude cannot preserve the MCP policy");
      policy.mcp = raw.mcp as Readonly<Record<string, JsonValue>>;
    }
    if (Object.hasOwn(raw, "permissionMode")) {
      const modes = supported.permissionModes;
      if (
        !Array.isArray(modes) ||
        !modes.includes(raw.permissionMode as string)
      )
        return fail(provider, "Claude cannot preserve the permission mode");
      policy.permissionMode = raw.permissionMode as string;
    }
  }

  const selection: {
    policy: NegotiatedAgentPolicy;
    agentModel?: string;
    agentEffort?: AgentEffort;
  } = {
    policy: deepFreeze(policy),
  };
  if (Object.hasOwn(raw, "model")) selection.agentModel = raw.model as string;
  if (Object.hasOwn(raw, "effort"))
    selection.agentEffort = raw.effort as AgentEffort;
  return deepFreeze(selection);
}
