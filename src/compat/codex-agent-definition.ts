import { createHash } from "node:crypto";
import { parse } from "smol-toml";

import { AwslError } from "../core/errors.js";
import type { AgentEffort } from "../core/types.js";
import {
  type AgentDefinitionSource,
  type RawAgentDefinition,
  freezeAgentDefinition,
  snapshotAgentDefinitionSource,
} from "./agent-definition.js";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_INSTRUCTION_BYTES = 65536;
const REQUIRED_FIELDS = [
  "name",
  "description",
  "developer_instructions",
] as const;
const ALLOWED_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
  "nickname_candidates",
]);
const EFFORTS = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const SANDBOXES = new Set<NonNullable<RawAgentDefinition["sandboxMode"]>>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function invalid(): never {
  throw new AwslError(
    "COMPATIBILITY_ERROR",
    "Codex agent definition is invalid",
    {
      recoverable: false,
    },
  );
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid();
  return value;
}

function validateNicknames(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const candidates = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !candidate ||
      candidate !== candidate.trim() ||
      candidate.includes("\0") ||
      candidates.has(candidate)
    )
      invalid();
    candidates.add(candidate);
  }
}

/** Parses one standalone ~/.codex/agents/*.toml definition. */
export function parseCodexAgentDefinition(
  toml: string,
  source: AgentDefinitionSource,
): RawAgentDefinition | null {
  try {
    const sourceSnapshot = snapshotAgentDefinitionSource(source);
    if (
      typeof toml !== "string" ||
      toml.includes("\0") ||
      Buffer.byteLength(toml, "utf8") > MAX_DOCUMENT_BYTES
    )
      invalid();
    const sha256 =
      `sha256:${createHash("sha256").update(toml, "utf8").digest("hex")}` as const;
    if (sourceSnapshot.sha256 !== sha256) invalid();

    const fields = parse(toml);
    for (const key of Object.keys(fields))
      if (!ALLOWED_FIELDS.has(key)) invalid();
    const markerCount = REQUIRED_FIELDS.filter(
      (field) => fields[field] !== undefined,
    ).length;
    if (markerCount === 0) return null;
    if (markerCount !== REQUIRED_FIELDS.length) invalid();

    const instructions = nonemptyString(fields.developer_instructions);
    if (Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTION_BYTES)
      invalid();
    const result: RawAgentDefinition = {
      name: nonemptyString(fields.name),
      description: nonemptyString(fields.description),
      instructions,
      source: sourceSnapshot,
    };
    if (fields.model !== undefined) result.model = nonemptyString(fields.model);
    if (fields.model_reasoning_effort !== undefined) {
      const effort = nonemptyString(fields.model_reasoning_effort);
      if (!EFFORTS.has(effort as AgentEffort)) invalid();
      result.effort = effort as AgentEffort;
    }
    if (fields.sandbox_mode !== undefined) {
      const sandboxMode = nonemptyString(fields.sandbox_mode);
      if (
        !SANDBOXES.has(
          sandboxMode as NonNullable<RawAgentDefinition["sandboxMode"]>,
        )
      )
        invalid();
      result.sandboxMode = sandboxMode as NonNullable<
        RawAgentDefinition["sandboxMode"]
      >;
    }
    if (fields.nickname_candidates !== undefined)
      validateNicknames(fields.nickname_candidates);
    return freezeAgentDefinition(result);
  } catch {
    return invalid();
  }
}
