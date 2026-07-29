import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  resolveChildWorkflow,
  resolveRootWorkflow,
} from "../../src/config/workflow-resolver.js";

const source = (name = "workflow") =>
  `export const meta={name:${JSON.stringify(name)},description:"test"}; return null`;

describe("workflow resolver", () => {
  test("resolves root and exact child paths from the same canonical session cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "workflow.js"), source());
    await writeFile(join(cwd, "child.js"), source("child"));
    await writeFile(join(cwd, "nested", "child.js"), source("wrong-child"));

    const root = await resolveRootWorkflow("workflow.js", cwd);
    const child = await resolveChildWorkflow(
      { scriptPath: "workflow.js" },
      cwd,
    );

    expect(root.realpath).toBe(await realpath(join(cwd, "workflow.js")));
    expect(child.realpath).toBe(root.realpath);
    expect(root.bytes).toBeInstanceOf(Uint8Array);
    expect(root.source).toBe(source());
    expect(root.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(root.reference).toBe("workflow.js");
    expect(root.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await resolveChildWorkflow({ scriptPath: "child.js" }, cwd)).meta.name,
    ).toBe("child");
  });

  test("canonicalizes a symlink target and rejects unsafe, directory, invalid UTF-8, oversized, and invalid workflows", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    await writeFile(join(cwd, "target.js"), source());
    await symlink(join(cwd, "target.js"), join(cwd, "linked.js"));
    await mkdir(join(cwd, "directory.js"));
    await writeFile(join(cwd, "utf8.js"), Buffer.from([0xff]));
    await writeFile(join(cwd, "large.js"), " ".repeat(512 * 1024 + 1));
    await writeFile(join(cwd, "bad.js"), "return null");

    await expect(resolveRootWorkflow("linked.js", cwd)).resolves.toMatchObject({
      realpath: await realpath(join(cwd, "target.js")),
    });
    await expect(resolveRootWorkflow("bad\0.js", cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(
      resolveRootWorkflow("directory.js", cwd),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(resolveRootWorkflow("utf8.js", cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(resolveRootWorkflow("large.js", cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(resolveRootWorkflow("bad.js", cwd)).rejects.toMatchObject({
      code: "COMPATIBILITY_ERROR",
    });
  });

  test("accepts only an exact plain child descriptor", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    await writeFile(join(cwd, "workflow.js"), source());
    const getter = Object.create(null, {
      scriptPath: { enumerable: true, get: () => "workflow.js" },
    });
    const proxy = new Proxy({ scriptPath: "workflow.js" }, {});

    await expect(
      resolveChildWorkflow("workflow.js" as never, cwd),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(
      resolveChildWorkflow(
        { scriptPath: "workflow.js", extra: true } as never,
        cwd,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(resolveChildWorkflow(getter, cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(resolveChildWorkflow(proxy, cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  test("uses exact bytes at the 512 KiB boundary and preserves the physical compile identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    const prefix = `export const meta={name:"x",description:"x"};/*`;
    const suffix = "*/";
    const remaining =
      512 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const chars = "中".repeat(Math.floor(remaining / 3));
    const exact =
      prefix +
      chars +
      " ".repeat(remaining - Buffer.byteLength(chars)) +
      suffix;
    await writeFile(join(cwd, "exact.js"), exact);
    await writeFile(join(cwd, "over.js"), `${exact}x`);
    const resolved = await resolveRootWorkflow("exact.js", cwd);
    expect(Buffer.byteLength(resolved.source)).toBe(512 * 1024);
    expect(resolved.filename).toBe(resolved.realpath);
    expect(resolved.sourceHash).toBe(resolved.sha256.slice("sha256:".length));
    await expect(resolveRootWorkflow("over.js", cwd)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  test("validates cwd even when the workflow reference is absolute", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    const workflow = join(cwd, "workflow.js");
    await writeFile(workflow, source());

    await expect(
      resolveRootWorkflow(workflow, join(cwd, "missing")),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("resolves parent traversal from the canonical target of a symlink cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    const physicalParent = join(root, "physical");
    const physicalCwd = join(physicalParent, "session");
    const lexicalParent = join(root, "lexical");
    const linkedCwd = join(lexicalParent, "session-link");
    await mkdir(physicalCwd, { recursive: true });
    await mkdir(lexicalParent);
    await writeFile(join(physicalParent, "workflow.js"), source("physical"));
    await writeFile(join(lexicalParent, "workflow.js"), source("lexical"));
    await symlink(physicalCwd, linkedCwd, "dir");

    const resolved = await resolveChildWorkflow(
      { scriptPath: "../workflow.js" },
      linkedCwd,
    );

    expect(resolved.meta.name).toBe("physical");
    expect(resolved.realpath).toBe(
      await realpath(join(physicalParent, "workflow.js")),
    );
  });

  test("returns defensive workflow byte snapshots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    await writeFile(join(cwd, "workflow.js"), source());
    const resolved = await resolveRootWorkflow("workflow.js", cwd);
    const originalFirstByte = resolved.bytes[0];

    resolved.bytes[0] ^= 0xff;

    expect(resolved.bytes[0]).toBe(originalFirstByte);
    expect(Buffer.from(resolved.bytes).toString("utf8")).toBe(resolved.source);
    expect(resolved.sourceHash).toBe(resolved.sha256.slice("sha256:".length));
  });

  test("preserves a workflow BOM in source and both exact hashes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "awsl-workflow-"));
    await writeFile(join(cwd, "workflow.js"), `\uFEFF${source()}`);

    const resolved = await resolveRootWorkflow("workflow.js", cwd);

    expect(resolved.source.startsWith("\uFEFF")).toBe(true);
    expect(resolved.sourceHash).toBe(resolved.sha256.slice("sha256:".length));
    expect(Buffer.from(resolved.bytes).toString("utf8")).toBe(resolved.source);
  });
});
