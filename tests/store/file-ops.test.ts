import { constants } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  type AtomicFileOps,
  type StoreFile,
  atomicWrite,
  fullWrite,
  immutableWrite,
  privateDirectory,
} from "../../src/store/file-ops.js";
import { MemoryAtomicFileOps } from "./support/memory-file-ops.js";

function fakeOps(log: string[]): AtomicFileOps {
  const regular = {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 2,
    size: 0,
    mode: 0o600,
  };
  const directory = {
    ...regular,
    isFile: () => false,
    isDirectory: () => true,
  };
  const file = (kind: "directory" | "file"): StoreFile => ({
    async read() {
      return { bytesRead: 0 };
    },
    async write(_bytes, offset = 0, length = 0) {
      log.push(`write:${offset}:${length}`);
      return { bytesWritten: length === 3 ? 1 : length };
    },
    async sync() {
      log.push(`sync:${kind}`);
    },
    async chmod(mode) {
      log.push(`chmod:${kind}:${mode.toString(8)}`);
    },
    async truncate() {},
    async close() {
      log.push(`close:${kind}`);
    },
    async stat() {
      return kind === "directory" ? directory : regular;
    },
  });
  return {
    async mkdir(path, mode) {
      log.push(`mkdir:${path}:${mode.toString(8)}`);
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
    async lstat(path) {
      log.push(`lstat:${path}`);
      return path === "/state" || path === "/state/scripts"
        ? directory
        : regular;
    },
    async open(path, flags, mode) {
      log.push(`open:${path}:${flags}:${mode?.toString(8) ?? ""}`);
      return flags & constants.O_DIRECTORY ? file("directory") : file("file");
    },
    async rename(from, to) {
      log.push(`rename:${from}:${to}`);
    },
    async link(from, to) {
      log.push(`link:${from}:${to}`);
    },
    async unlink(path) {
      log.push(`unlink:${path}`);
    },
    async truncate() {},
    async readFile() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async syncDir(path) {
      log.push(`syncDir:${path}`);
    },
  };
}

describe("immutableWrite", () => {
  test("atomically writes metadata through a private wx temp, full writes, sync, rename and directory sync", async () => {
    const ops = new MemoryAtomicFileOps();
    ops.writeLimit = 1;
    await atomicWrite(ops, "/state/run.json", Buffer.from("abc"));
    const temp = ops.log.find((entry) => entry.startsWith("open:/state/."));
    expect(temp).toContain(
      String(
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
      ),
    );
    expect(temp).toContain(":600");
    const tempPath = temp?.split(":")[1] ?? "";
    expect(ops.log).toContain(`write:${tempPath}:0:3`);
    expect(ops.log).toContain(`write:${tempPath}:1:2`);
    expect(ops.log).toContain(`write:${tempPath}:2:1`);
    expect(ops.log).toContain(`sync:${tempPath}`);
    expect(ops.log).toContain(`close:${tempPath}`);
    const rename = ops.log.findIndex(
      (entry) => entry === `rename:${tempPath}:/state/run.json`,
    );
    expect(rename).toBeGreaterThan(0);
    expect(ops.log[rename + 1]).toBe("syncDir:/state");
    expect(ops.entry("/state/run.json").mode).toBe(0o600);
  });

  test("cleans an unrenamed atomic temp on write, sync or rename failure without deleting a renamed target", async () => {
    for (const operation of ["write", "sync", "rename"] as const) {
      const ops = new MemoryAtomicFileOps();
      if (operation === "rename") ops.failOn("rename", 1, new Error("rename"));
      else ops.failOn(operation, 1, new Error(operation));
      await expect(
        atomicWrite(ops, "/state/run.json", Buffer.from("x")),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(ops.entries.has("/state/run.json")).toBe(false);
      expect(
        [...ops.entries.keys()].some((key) => key.startsWith("/state/.")),
      ).toBe(false);
    }
  });

  test("never deletes an existing temp when wx open collides, but syncs the directory after cleaning an owned temp", async () => {
    for (const write of [atomicWrite, immutableWrite]) {
      const collision = new MemoryAtomicFileOps();
      collision.openFailure = (path) =>
        path.startsWith("/state/.")
          ? Object.assign(new Error("exists"), { code: "EEXIST" })
          : undefined;
      await expect(
        write(collision, "/state/target", Buffer.from("x")),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      expect(
        collision.log.filter((entry) => entry.startsWith("unlink:/state/.")),
      ).toHaveLength(0);

      const owned = new MemoryAtomicFileOps();
      owned.writeLimit = 0;
      await expect(
        write(owned, "/state/target", Buffer.from("x")),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      const unlink = owned.log.findIndex((entry) =>
        entry.startsWith("unlink:/state/."),
      );
      expect(unlink).toBeGreaterThanOrEqual(0);
      expect(owned.log.slice(unlink + 1)).toContain("syncDir:/state");
    }
  });
  test("publishes a source file with wx, full writes, link, cleanup and directory sync", async () => {
    const log: string[] = [];
    await immutableWrite(
      fakeOps(log),
      "/state/scripts/source.js",
      Buffer.from("abc"),
    );
    const open = log.find((entry) => entry.startsWith("open:/state/scripts/."));
    expect(open).toContain(
      String(
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
      ),
    );
    expect(open).toContain(":600");
    expect(log).toContain("write:0:3");
    expect(log).toContain("write:1:2");
    expect(log).toContain("sync:file");
    expect(log).toContain("close:file");
    expect(log).toContain("chmod:directory:700");
    expect(log.findIndex((entry) => entry.startsWith("link:"))).toBeLessThan(
      log.findIndex((entry) => entry.startsWith("unlink:/state/scripts/.")),
    );
    expect(log.at(-1)).toBe("syncDir:/state/scripts");
  });

  test("rejects a zero-byte write instead of accepting a partial durable record", async () => {
    const file: StoreFile = {
      async read() {
        return { bytesRead: 0 };
      },
      async write() {
        return { bytesWritten: 0 };
      },
      async sync() {},
      async chmod() {},
      async truncate() {},
      async close() {},
      async stat() {
        return {
          isFile: () => true,
          isDirectory: () => false,
          dev: 1,
          ino: 1,
          size: 0,
          mode: 0o600,
        };
      },
    };
    await expect(fullWrite(file, Buffer.from("x"))).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
  });

  test("never renames over an existing immutable target after an EEXIST race", async () => {
    const log: string[] = [];
    const ops = fakeOps(log);
    ops.link = async (from, to) => {
      log.push(`link:${from}:${to}`);
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    let verified = false;
    await immutableWrite(
      ops,
      "/state/scripts/source.js",
      Buffer.from("abc"),
      async () => {
        verified = true;
      },
    );
    expect(verified).toBe(true);
    expect(log.some((entry) => entry.startsWith("rename:"))).toBe(false);
    expect(
      log.some((entry) => entry.startsWith("unlink:/state/scripts/.")),
    ).toBe(true);
    expect(log.at(-1)).toBe("syncDir:/state/scripts");
  });

  test("rejects a symlinked state directory before opening it", async () => {
    const ops = fakeOps([]);
    ops.lstat = async () => ({
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => true,
      dev: 1,
      ino: 1,
    });
    await expect(privateDirectory(ops, "/state/scripts")).rejects.toMatchObject(
      {
        code: "PERSISTENCE_ERROR",
      },
    );
  });
});
