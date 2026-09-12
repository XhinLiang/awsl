import { type AgentToolUse, TOOL_USE_LIMITS } from "./types.js";

/**
 * Clamp a tool-use field to the shared byte budget, appending an ellipsis when
 * anything was dropped. Providers summarize unbounded payloads (tool inputs,
 * result bodies) through this before the trail reaches the journal.
 */
export function truncateToolField(value: string): string {
  const max = TOOL_USE_LIMITS.maxFieldBytes;
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  let out = "";
  for (const ch of value) {
    // Reserve 3 bytes for the trailing ellipsis.
    if (Buffer.byteLength(out + ch, "utf8") > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

/** Serialize an arbitrary tool payload (input object, result content) into a bounded digest. */
export function summarizeToolPayload(value: unknown): string {
  if (typeof value === "string") return truncateToolField(value);
  try {
    return truncateToolField(JSON.stringify(value) ?? "");
  } catch {
    // Non-serializable diagnostics payload; an empty digest beats a dead stream.
    return "";
  }
}

/** Append to a tool-use trail, dropping entries past the journal cap. */
export function appendToolUse(trail: AgentToolUse[], use: AgentToolUse): void {
  if (trail.length >= TOOL_USE_LIMITS.maxEntries) return;
  trail.push(use);
}
