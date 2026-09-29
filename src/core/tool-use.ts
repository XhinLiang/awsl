import { type AgentToolUse, TOOL_USE_LIMITS } from "./types.js";

/** Validate the bounded trail accepted from providers and stored in the journal. */
export function isCapturableToolUses(value: unknown): value is AgentToolUse[] {
  if (!Array.isArray(value) || value.length > TOOL_USE_LIMITS.maxEntries) {
    return false;
  }
  return value.every((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => !["tool", "input", "error", "exitCode"].includes(key),
      ) ||
      typeof entry.tool !== "string" ||
      entry.tool.length === 0
    ) {
      return false;
    }
    for (const field of ["input", "error"] as const) {
      const text = entry[field];
      if (
        text !== undefined &&
        (typeof text !== "string" ||
          Buffer.byteLength(text, "utf8") > TOOL_USE_LIMITS.maxFieldBytes)
      ) {
        return false;
      }
    }
    return entry.exitCode === undefined || Number.isSafeInteger(entry.exitCode);
  });
}

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
