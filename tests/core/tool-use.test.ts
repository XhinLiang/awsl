import { describe, expect, test } from "vitest";

import {
  appendToolUse,
  summarizeToolPayload,
  truncateToolField,
} from "../../src/core/tool-use.js";
import { TOOL_USE_LIMITS } from "../../src/core/types.js";

describe("tool-use trail helpers", () => {
  test("keeps a short field verbatim", () => {
    expect(truncateToolField("git status")).toBe("git status");
  });

  test("clamps an oversized field to the byte budget with an ellipsis", () => {
    const truncated = truncateToolField("x".repeat(1000));
    expect(Buffer.byteLength(truncated, "utf8")).toBe(
      TOOL_USE_LIMITS.maxFieldBytes,
    );
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("never splits a multi-byte character at the cut", () => {
    const truncated = truncateToolField("报".repeat(200));
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(
      TOOL_USE_LIMITS.maxFieldBytes,
    );
    expect(truncated.endsWith("…")).toBe(true);
    // Every retained character must still be a whole 报 (3 bytes each).
    for (const ch of truncated.slice(0, -1)) expect(ch).toBe("报");
  });

  test("serializes non-string payloads through the same budget", () => {
    const digest = summarizeToolPayload({ command: "a".repeat(500) });
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(
      TOOL_USE_LIMITS.maxFieldBytes,
    );
    expect(summarizeToolPayload(undefined)).toBe("");
  });

  test("drops trail entries past the cap", () => {
    const trail = [] as { tool: string }[];
    for (let index = 0; index < TOOL_USE_LIMITS.maxEntries + 20; index += 1) {
      appendToolUse(trail, { tool: `tool-${index}` });
    }
    expect(trail).toHaveLength(TOOL_USE_LIMITS.maxEntries);
    expect(trail.at(-1)?.tool).toBe(`tool-${TOOL_USE_LIMITS.maxEntries - 1}`);
  });
});
