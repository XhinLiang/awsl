import { constants } from "node:fs";

import type { AtomicFileOps, StoreFile } from "../../../src/store/file-ops.js";

type Entry = {
  kind: "file" | "directory" | "symlink";
  bytes: Buffer;
  reportedSize?: number;
  mode: number;
  dev: number;
  ino: number;
};

export class MemoryAtomicFileOps implements AtomicFileOps {
  readonly log: string[] = [];
  readonly entries = new Map<string, Entry>();
  fail: Partial<
    Record<
      | "open"
      | "write"
      | "sync"
      | "close"
      | "unlink"
      | "syncDir"
      | "stat"
      | "read",
      Error
    >
  > = {};
  writeLimit: number | undefined;
  readLimit: number | undefined;
  syncGate: Promise<void> | undefined;
  failSyncPath: string | undefined;
  openFailure: ((path: string) => Error | undefined) | undefined;
  /** Exact fault injection: operation, path and invocation number. */
  readonly faults: Array<{
    operation: string;
    path?: string;
    nth: number;
    error: Error;
  }> = [];
  readonly hooks: Array<{
    operation: string;
    path?: string;
    nth: number;
    run: () => void | Promise<void>;
  }> = [];
  readonly counts = new Map<string, number>();
  #nextIno = 10;

  constructor(root = "/state") {
    if (root !== "/") this.entries.set("/", this.#entry("directory", 0o755));
    this.entries.set(root, this.#entry("directory", 0o700));
  }

  #entry(kind: Entry["kind"], mode: number, bytes = Buffer.alloc(0)): Entry {
    return { kind, bytes, mode, dev: 1, ino: this.#nextIno++ };
  }
  addFile(path: string, bytes = Buffer.alloc(0), mode = 0o600): void {
    this.entries.set(path, this.#entry("file", mode, Buffer.from(bytes)));
  }
  addSparseFile(path: string, size: number, mode = 0o600): void {
    const entry = this.#entry("file", mode);
    entry.reportedSize = size;
    this.entries.set(path, entry);
  }
  addSymlink(path: string): void {
    this.entries.set(path, this.#entry("symlink", 0o777));
  }
  failOn(operation: string, nth: number, error: Error, path?: string): void {
    this.faults.push({ operation, path, nth, error });
  }
  hookOn(
    operation: string,
    nth: number,
    run: () => void | Promise<void>,
    path?: string,
  ): void {
    this.hooks.push({ operation, path, nth, run });
  }
  async #before(operation: string, path: string): Promise<void> {
    const key = `${operation}:${path}`;
    const nth = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, nth);
    for (const hook of this.hooks)
      if (
        hook.operation === operation &&
        (!hook.path || hook.path === path) &&
        hook.nth === nth
      )
        await hook.run();
    for (const fault of this.faults)
      if (
        fault.operation === operation &&
        (!fault.path || fault.path === path) &&
        fault.nth === nth
      )
        throw fault.error;
  }
  entry(path: string): Entry {
    const entry = this.entries.get(path);
    if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return entry;
  }
  async mkdir(path: string, mode: number): Promise<void> {
    this.log.push(`mkdir:${path}:${mode.toString(8)}`);
    await this.#before("mkdir", path);
    if (this.entries.has(path))
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.entries.set(path, this.#entry("directory", mode));
  }
  async lstat(path: string) {
    const e = this.entry(path);
    this.log.push(`lstat:${path}`);
    await this.#before("lstat", path);
    return this.#stat(e);
  }
  async open(path: string, flags: number, mode?: number): Promise<StoreFile> {
    this.log.push(`open:${path}:${flags}:${mode?.toString(8) ?? ""}`);
    await this.#before("open", path);
    const openFailure = this.openFailure?.(path);
    if (openFailure) throw openFailure;
    if (this.fail.open) throw this.fail.open;
    let e = this.entries.get(path);
    if (!e) {
      if (!(flags & constants.O_CREAT))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      e = this.#entry("file", mode ?? 0o666);
      this.entries.set(path, e);
    } else if (flags & constants.O_EXCL && flags & constants.O_CREAT)
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    if (flags & constants.O_NOFOLLOW && e.kind === "symlink")
      throw Object.assign(new Error("link"), { code: "ELOOP" });
    return this.#file(path, e);
  }
  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename:${from}:${to}`);
    await this.#before("rename", from);
    const e = this.entry(from);
    this.entries.set(to, e);
    this.entries.delete(from);
  }
  async link(from: string, to: string): Promise<void> {
    this.log.push(`link:${from}:${to}`);
    await this.#before("link", to);
    if (this.entries.has(to))
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.entries.set(to, this.entry(from));
  }
  async unlink(path: string): Promise<void> {
    this.log.push(`unlink:${path}`);
    await this.#before("unlink", path);
    if (this.fail.unlink) throw this.fail.unlink;
    this.entry(path);
    this.entries.delete(path);
  }
  async truncate(path: string, length: number): Promise<void> {
    this.log.push(`truncate:${path}:${length}`);
    await this.#before("truncate", path);
    this.entry(path).bytes = this.entry(path).bytes.subarray(0, length);
  }
  async readFile(path: string): Promise<Buffer> {
    this.log.push(`readFile:${path}`);
    await this.#before("readFile", path);
    return Buffer.from(this.entry(path).bytes);
  }
  async syncDir(path: string): Promise<void> {
    this.log.push(`syncDir:${path}`);
    await this.#before("syncDir", path);
    if (this.fail.syncDir) throw this.fail.syncDir;
  }
  #stat(e: Entry) {
    return {
      isFile: () => e.kind === "file",
      isDirectory: () => e.kind === "directory",
      isSymbolicLink: () => e.kind === "symlink",
      dev: e.dev,
      ino: e.ino,
      size: e.reportedSize ?? e.bytes.length,
      mode: e.mode,
    };
  }
  #file(path: string, entry: Entry): StoreFile {
    return {
      read: async (
        buffer,
        offset = 0,
        length = buffer.length,
        position = 0,
      ) => {
        this.log.push(`read:${path}:${position ?? 0}:${length}`);
        await this.#before("read", path);
        if (this.fail.read) throw this.fail.read;
        const part = entry.bytes.subarray(
          position ?? 0,
          (position ?? 0) +
            (this.readLimit === undefined
              ? length
              : Math.min(length, this.readLimit)),
        );
        part.copy(buffer, offset);
        return { bytesRead: part.length };
      },
      write: async (
        buffer,
        offset = 0,
        length = buffer.length,
        position = null,
      ) => {
        this.log.push(`write:${path}:${offset}:${length}`);
        await this.#before("write", path);
        if (this.fail.write) throw this.fail.write;
        const count =
          this.writeLimit === undefined
            ? length
            : Math.min(length, this.writeLimit);
        const at = position === null ? entry.bytes.length : position;
        const next = Buffer.alloc(Math.max(entry.bytes.length, at + count));
        entry.bytes.copy(next);
        Buffer.from(buffer)
          .subarray(offset, offset + count)
          .copy(next, at);
        entry.bytes = next;
        entry.reportedSize = undefined;
        return { bytesWritten: count };
      },
      sync: async () => {
        this.log.push(`sync:${path}`);
        await this.#before("sync", path);
        await this.syncGate;
        if (this.failSyncPath === path) throw new Error("path sync failure");
        if (this.fail.sync) throw this.fail.sync;
      },
      chmod: async (mode) => {
        this.log.push(`chmod:${path}:${mode.toString(8)}`);
        entry.mode = mode;
      },
      truncate: async (length = 0) => {
        this.log.push(`ftruncate:${path}:${length}`);
        await this.#before("ftruncate", path);
        entry.bytes = entry.bytes.subarray(0, length);
        entry.reportedSize = undefined;
      },
      close: async () => {
        this.log.push(`close:${path}`);
        await this.#before("close", path);
        if (this.fail.close) throw this.fail.close;
      },
      stat: async () => {
        this.log.push(`stat:${path}`);
        await this.#before("stat", path);
        if (this.fail.stat) throw this.fail.stat;
        return this.#stat(entry);
      },
    };
  }
}
