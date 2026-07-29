import { access, lstat, readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  createPrivateJsonFile,
  prepareCodexJsonSchema,
  prepareProviderJsonSchema,
  serializeProviderJson,
} from "../../src/providers/schema.js";

describe("provider JSON artifacts", () => {
  test("serializes strict JSON exactly once without invoking accessors", () => {
    let reads = 0;
    const schema = {};
    Object.defineProperty(schema, "type", {
      enumerable: true,
      get() {
        reads += 1;
        return "object";
      },
    });

    expect(() =>
      serializeProviderJson(schema, {
        label: "schema",
        provider: "codex",
      }),
    ).toThrow(/strict JSON/);
    expect(reads).toBe(0);
  });

  test("measures the limit in UTF-8 bytes", () => {
    const schema = { description: "界".repeat(30) };

    expect(() =>
      serializeProviderJson(schema, {
        label: "schema",
        maxBytes: 64,
        provider: "claude",
      }),
    ).toThrow(/64 bytes/);
  });

  test("preserves an own __proto__ JSON key", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;

    const packet = serializeProviderJson(schema, {
      label: "schema",
      provider: "codex",
    });

    expect(JSON.parse(packet)).toEqual(schema);
  });

  test.each([
    { type: "string", pattern: "^(a+)+$" },
    {
      type: "object",
      patternProperties: { "^(a+)+$": { type: "string" } },
    },
    { type: "string", format: "regex" },
    {
      type: "object",
      $defs: {
        unsafe: { type: "string", pattern: "^(a+)+$" },
      },
    },
  ])("rejects workflow-controlled regular expressions", (schema) => {
    expect(() =>
      prepareProviderJsonSchema(schema, {
        label: "schema",
        provider: "codex",
      }),
    ).toThrow(/not a valid JSON Schema/);
  });

  test.each([
    {
      const: { type: "string", pattern: "^(a+)+$" },
      allOf: [{ $ref: "#/const" }],
    },
    {
      $defs: { value: { type: "string" } },
      allOf: [{ $ref: "#/$defs/value" }],
    },
  ])("rejects workflow-controlled schema references", (schema) => {
    expect(() =>
      prepareProviderJsonSchema(schema, {
        label: "schema",
        provider: "codex",
      }),
    ).toThrow(/not a valid JSON Schema/);
  });

  test("does not confuse property or constant data keys with schema keywords", () => {
    const schema = prepareProviderJsonSchema(
      {
        type: "object",
        required: ["pattern", "value"],
        properties: {
          pattern: { type: "string" },
          value: { const: { pattern: "literal" } },
        },
      },
      {
        label: "schema",
        provider: "codex",
      },
    );

    expect(
      schema.matches({
        pattern: "ordinary property",
        value: { pattern: "literal" },
      }),
    ).toBe(true);
  });

  test("keeps optional workflow validation while only the Codex packet closes required fields", () => {
    const workflowSchema = {
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        note: { type: "string" },
      },
      required: ["id"],
      type: "object",
    };
    const originalPacket = JSON.stringify(workflowSchema);

    const codex = prepareCodexJsonSchema(workflowSchema, {
      label: "Codex schema",
    });
    const claude = prepareProviderJsonSchema(workflowSchema, {
      label: "Claude schema",
      provider: "claude",
    });

    expect(JSON.parse(codex.packet)).toEqual({
      ...workflowSchema,
      required: ["id", "note"],
    });
    expect(codex.matches({ id: "present" })).toBe(true);
    expect(codex.matches({ id: 42 })).toBe(false);
    expect(claude.packet).toBe(originalPacket);
    expect(JSON.stringify(workflowSchema)).toBe(originalPacket);
  });

  test("leaves an already closed Codex schema packet byte-for-byte stable", () => {
    const schema = {
      additionalProperties: false,
      properties: {
        first: { type: "string" },
        second: { type: "string" },
      },
      required: ["second", "first"],
      type: "object",
    };
    const original = prepareProviderJsonSchema(schema, {
      label: "schema",
      provider: "codex",
    });

    expect(
      prepareCodexJsonSchema(schema, {
        label: "schema",
      }).packet,
    ).toBe(original.packet);
  });

  test("creates mode-0600 files in a mode-0700 directory and removes both", async () => {
    const artifact = await createPrivateJsonFile('{"type":"object"}', {
      basename: "schema.json",
      prefix: "awsl-schema-test-",
    });

    expect(await readFile(artifact.path, "utf8")).toBe('{"type":"object"}');
    expect((await lstat(artifact.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(artifact.directory)).mode & 0o777).toBe(0o700);

    await artifact.dispose();
    await expect(access(artifact.path)).rejects.toThrow();
    await expect(access(artifact.directory)).rejects.toThrow();
    await expect(artifact.dispose()).resolves.toBeUndefined();
  });
});
