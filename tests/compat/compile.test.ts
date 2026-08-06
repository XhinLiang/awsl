import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { compileWorkflow } from "../../src/compat/compile.js";
import { AwslError } from "../../src/core/errors.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/workflows/basic.js", import.meta.url),
);
const source = `export const meta = {
  name: "basic",
  description: "basic workflow",
  phases: [{ title: "Run" }],
}
await Promise.resolve()
return { ok: true, value: args.value }
`;

function expectCompatibilityError(action: () => unknown, message: RegExp) {
  expect(action).toThrowError(message);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AwslError);
    expect((error as AwslError).code).toBe("COMPATIBILITY_ERROR");
  }
}

describe("compileWorkflow", () => {
  test("extracts pure metadata and permits top-level await and return", () => {
    const compiled = compileWorkflow(source, "/tmp/basic.js");

    expect(compiled).toMatchObject({
      filename: "/tmp/basic.js",
      workflowAbi: "awsl-workflow@1",
      meta: { name: "basic", description: "basic workflow" },
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(compiled.code).toContain('"use strict"');
    expect(compiled.code).not.toContain("export const meta");
    expect(compiled.code).toContain("await Promise.resolve()");
    expect(compiled.code).toContain("return { ok: true, value: args.value }");
  });

  test("compiles the fixture with display-only phase metadata", async () => {
    const compiled = compileWorkflow(
      await readFile(fixturePath, "utf8"),
      fixturePath,
    );

    expect(compiled.meta).toEqual({
      name: "basic",
      description: "basic workflow",
      title: "Basic",
      whenToUse: "Run the basic fixture",
      phases: [{ title: "Run", detail: "Execute", model: "display-only" }],
    });
  });

  test("drops unknown metadata and ignores optional values with wrong types", () => {
    const compiled = compileWorkflow(
      `export const meta={name:"x",description:"y",title:1,whenToUse:false,unknown:"drop",phases:[{title:"A",detail:2,model:false},{title:1},{title:"B",detail:"ok",model:"shown"}]}; return null`,
      "/tmp/meta.js",
    );

    expect(compiled.meta).toEqual({
      name: "x",
      description: "y",
      phases: [{ title: "A" }, { title: "B", detail: "ok", model: "shown" }],
    });
    expect(compiled.workflowAbi).toBe("awsl-workflow@1");
  });

  test("accepts finite numeric literal object keys as string keys", () => {
    const compiled = compileWorkflow(
      "export const meta={name:'x',description:'x',nested:{1:'one'}}; return null",
      "/tmp/numeric-key.js",
    );

    expect(compiled.meta).toEqual({ name: "x", description: "x" });
    expect(compiled.code).toContain("return null");
  });

  test.each([
    [
      "reference",
      'export const meta={name:foo,description:"x"}; const foo="x"; return null',
    ],
    ["call", 'export const meta={name:make(),description:"x"}; return null'],
    [
      "spread",
      'export const meta={...{name:"x"},description:"x"}; return null',
    ],
    [
      "computed key",
      'export const meta={["name"]:"x",description:"x"}; return null',
    ],
    ["method", 'export const meta={name(){},description:"x"}; return null'],
    [
      "accessor",
      'export const meta={get name(){return "x"},description:"x"}; return null',
    ],
    [
      "array hole",
      'export const meta={name:"x",description:"x",phases:[,]}; return null',
    ],
    [
      "reserved key",
      'export const meta={name:"x",description:"x",constructor:1}; return null',
    ],
    ["bigint", 'export const meta={name:"x",description:1n}; return null'],
    ["regex", 'export const meta={name:"x",description:/x/}; return null'],
    [
      "template interpolation",
      'export const meta={name:`x${1}`,description:"x"}; return null',
    ],
  ])("rejects nonliteral metadata %s", (_name, invalidSource) => {
    expectCompatibilityError(
      () => compileWorkflow(invalidSource, "/tmp/invalid.js"),
      /pure literal/,
    );
  });

  test.each([
    [
      "import declaration",
      'import "node:fs"; export const meta={name:"x",description:"x"}; return null',
    ],
    [
      "import expression",
      'export const meta={name:"x",description:"x"}; return import("node:fs")',
    ],
  ])("rejects %s", (_name, invalidSource) => {
    expectCompatibilityError(
      () => compileWorkflow(invalidSource, "/tmp/import.js"),
      /import.*not allowed/,
    );
  });

  test.each([
    [
      "named export after metadata",
      'export const meta={name:"x",description:"x"}; export const value = 1; return value',
    ],
    [
      "default export after metadata",
      'export const meta={name:"x",description:"x"}; export default 1',
    ],
    [
      "export all after metadata",
      'export const meta={name:"x",description:"x"}; export * from "./other.js"',
    ],
    [
      "import meta in workflow body",
      'export const meta={name:"x",description:"x"}; return import.meta.url',
    ],
  ])(
    "rejects unsupported workflow module syntax: %s",
    (_name, invalidSource) => {
      expectCompatibilityError(
        () => compileWorkflow(invalidSource, "/tmp/module-syntax.js"),
        /module syntax not allowed/,
      );
    },
  );

  test("leaves runtime capability checks and nondeterminism to the VM", () => {
    const compiled = compileWorkflow(
      `export const meta={name:"x",description:"x"}; if (false) { require("fs"); Date.now(); Math.random(); new Date(); } return typeof process === "undefined" ? eval : null`,
      "/tmp/detect.js",
    );

    expect(compiled.code).toContain("typeof process");
    expect(compiled.code).toContain('require("fs")');
    expect(compiled.code).toContain("Date.now()");
    expect(compiled.code).toContain("Math.random()");
    expect(compiled.code).toContain("new Date()");
  });

  test("enforces the UTF-8 512 KiB source limit at its boundary", () => {
    const prefix = `export const meta={name:"x",description:"x"};`;
    expect(() =>
      compileWorkflow(
        prefix + " ".repeat(512 * 1024 - Buffer.byteLength(prefix)),
        "/tmp/ok.js",
      ),
    ).not.toThrow();
    expectCompatibilityError(
      () =>
        compileWorkflow(
          prefix + " ".repeat(512 * 1024 - Buffer.byteLength(prefix) + 1),
          "/tmp/large.js",
        ),
      /512 KiB/,
    );
  });

  test("measures the source limit in UTF-8 bytes for multibyte source", () => {
    const prefix = `export const meta={name:"x",description:"x"};/*`;
    const suffix = "*/";
    const remaining =
      512 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const comment =
      "中".repeat(Math.floor(remaining / Buffer.byteLength("中"))) +
      " ".repeat(remaining % Buffer.byteLength("中"));
    const exactBoundary = `${prefix}${comment}${suffix}`;

    expect(Buffer.byteLength(exactBoundary)).toBe(512 * 1024);
    expect(() =>
      compileWorkflow(exactBoundary, "/tmp/utf8-ok.js"),
    ).not.toThrow();
    expectCompatibilityError(
      () => compileWorkflow(`${exactBoundary} `, "/tmp/utf8-large.js"),
      /512 KiB/,
    );
  });

  test("preserves original source line positions in the strict wrapper", () => {
    const compiled = compileWorkflow(source, "/tmp/lines.js");
    const bodyLines = compiled.code.split("\n");

    expect(bodyLines[0]).toMatch(
      /^\(async function __awslWorkflow__\(\) \{"use strict";\s*$/,
    );
    expect(bodyLines[5]).toBe("await Promise.resolve()");
  });
});
