import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  canonicalCwd,
  lexicalPath,
  readRegularUtf8,
  resolveProjectRoot,
  resolveWorkflowPath,
} from "../../src/config/paths.js";

describe("paths", () => {
  test.each([
    "bad\0.js",
    "//server/share/x.js",
    String.raw`\\server\share\x.js`,
    String.raw`C:x.js`,
    "C:",
  ])("rejects unsafe workflow path %j", async (value) => {
    await expect(
      resolveWorkflowPath(value, process.cwd()),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  test("rejects unsafe cwd and state path lexically before filesystem access", async () => {
    await expect(canonicalCwd("bad\0cwd")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    expect(() => lexicalPath(String.raw`C:relative`, process.cwd())).toThrow();
    expect(() => lexicalPath("//server/share", process.cwd())).toThrow();
  });

  test("reads to EOF instead of trusting the initial file size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awsl-paths-"));
    const file = join(dir, "source.js");
    await writeFile(file, "hello");
    await expect(readRegularUtf8(file, dir, 4)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(readRegularUtf8(file, dir, 5)).resolves.toMatchObject({
      source: "hello",
    });
  });

  test("preserves a UTF-8 BOM in the exact source and physical hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awsl-paths-"));
    const file = join(dir, "source.md");
    const bytes = Buffer.from("\uFEFF---\nname: agent\n", "utf8");
    await writeFile(file, bytes);

    const snapshot = await readRegularUtf8(file, dir);

    expect(snapshot.source).toBe("\uFEFF---\nname: agent\n");
    expect(Buffer.from(snapshot.bytes)).toEqual(bytes);
    expect(snapshot.sha256).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  test("requires a strict one-line gitdir marker", async () => {
    const repo = await mkdtemp(join(tmpdir(), "awsl-git-"));
    await mkdir(join(repo, "child"));
    await writeFile(join(repo, ".git"), "gitdir: ../bare\nextra\n");
    await expect(resolveProjectRoot(join(repo, "child"))).rejects.toMatchObject(
      {
        code: "CONFIG_ERROR",
      },
    );
  });

  test("treats a missing discovered gitdir target as fatal", async () => {
    const repo = await mkdtemp(join(tmpdir(), "awsl-git-missing-"));
    await mkdir(join(repo, "child"));
    await writeFile(join(repo, ".git"), "gitdir: ../missing\n");
    await expect(resolveProjectRoot(join(repo, "child"))).rejects.toMatchObject(
      {
        code: "CONFIG_ERROR",
      },
    );
  });

  test.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking on open",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "awsl-fifo-"));
      const fifo = join(dir, "source");
      try {
        await promisify(execFile)("mkfifo", [fifo]);
        const reading = readRegularUtf8(fifo, dir);
        let writer: Promise<void> | undefined;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => {
            resolveTimeout("timeout");
            writer = open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then(
              async (handle) => handle.close(),
            );
          }, 250);
        });
        const outcome = await Promise.race([
          reading.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
          timeout,
        ]);
        if (timer) clearTimeout(timer);
        if (outcome === "timeout") {
          await writer;
          await reading.catch(() => undefined);
        }
        expect(outcome).toBe("rejected");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
