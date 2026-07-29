import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { AwslError } from "../core/errors.js";

export interface StoreFile {
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
  truncate(length?: number): Promise<void>;
  close(): Promise<void>;
  stat(): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    dev: number;
    ino: number;
    size: number;
    mode: number;
  }>;
}
export interface AtomicFileOps {
  mkdir(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    dev: number;
    ino: number;
  }>;
  open(path: string, flags: number, mode?: number): Promise<StoreFile>;
  rename(from: string, to: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  truncate(path: string, length: number): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  syncDir(path: string): Promise<void>;
}

const fail = (message: string, cause?: unknown) =>
  new AwslError("PERSISTENCE_ERROR", message, { recoverable: false, cause });
function linuxOnly(): void {
  if (process.platform === "win32")
    throw fail("durable store is unsupported on native Windows");
}

export const nodeFileOps: AtomicFileOps = {
  async mkdir(path, mode) {
    linuxOnly();
    await mkdir(path, { recursive: false, mode });
  },
  lstat,
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  link,
  unlink: async (path) => {
    await rm(path, { force: false });
  },
  truncate,
  readFile,
  async syncDir(path) {
    linuxOnly();
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export async function privateDirectory(
  ops: AtomicFileOps,
  path: string,
): Promise<void> {
  linuxOnly();
  const parent = dirname(path);
  try {
    const parentStat = await ops.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
      throw fail("state directory parent is not a regular directory");
    let created = false;
    try {
      await ops.mkdir(path, 0o700);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await ops.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat();
      if (!stat.isDirectory() || stat.isFile())
        throw fail("state directory is not a regular directory");
      await directory.chmod(0o700);
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (created) {
      await ops.syncDir(parent);
      await ops.syncDir(path);
    }
  } catch (error) {
    throw error instanceof AwslError
      ? error
      : fail("could not secure state directory", error);
  }
}

export async function createPrivateDirectory(
  ops: AtomicFileOps,
  path: string,
): Promise<void> {
  linuxOnly();
  const parent = dirname(path);
  try {
    const parentStat = await ops.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
      throw fail("state directory parent is not a regular directory");
    try {
      await ops.mkdir(path, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw fail("run state already exists");
      throw error;
    }
    const directory = await ops.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat();
      if (!stat.isDirectory() || stat.isFile())
        throw fail("state directory is not a regular directory");
      await directory.chmod(0o700);
      await directory.sync();
    } finally {
      await directory.close();
    }
    await ops.syncDir(parent);
    await ops.syncDir(path);
  } catch (error) {
    throw error instanceof AwslError
      ? error
      : fail("could not create private state directory", error);
  }
}

export async function existingPrivateDirectory(
  ops: AtomicFileOps,
  path: string,
): Promise<void> {
  linuxOnly();
  try {
    const pathStat = await ops.lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory())
      throw fail("state directory is not a regular directory");
    const directory = await ops.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat();
      if (!stat.isDirectory() || stat.isFile() || (stat.mode & 0o777) !== 0o700)
        throw fail("state directory is not a private regular directory");
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw fail("run state does not exist", error);
    throw error instanceof AwslError
      ? error
      : fail("could not open existing state directory", error);
  }
}

export async function fullWrite(
  file: StoreFile,
  bytes: Uint8Array,
): Promise<void> {
  await fullWriteAt(file, bytes, null);
}

export async function fullWriteAt(
  file: StoreFile,
  bytes: Uint8Array,
  position: number | null,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position === null ? null : position + offset,
    );
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0)
      throw fail("short file write");
    offset += result.bytesWritten;
  }
}

export async function atomicWrite(
  ops: AtomicFileOps,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  linuxOnly();
  const directory = dirname(target);
  await privateDirectory(ops, directory);
  const temp = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  let file: StoreFile | undefined;
  let renamed = false;
  let tempOwned = false;
  try {
    file = await ops.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    tempOwned = true;
    await fullWrite(file, bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await ops.rename(temp, target);
    renamed = true;
    await ops.syncDir(directory);
  } catch (error) {
    try {
      await file?.close();
    } catch {
      /* preserve primary failure */
    }
    if (!renamed && tempOwned) {
      try {
        await ops.unlink(temp);
        await ops.syncDir(directory);
      } catch {
        /* preserve the primary failure; never remove a renamed target */
      }
    }
    throw error instanceof AwslError
      ? error
      : fail("atomic metadata write failed", error);
  }
}

/** Atomically creates a durable immutable target without ever replacing it. */
export async function immutableWrite(
  ops: AtomicFileOps,
  target: string,
  bytes: Uint8Array,
  verifyExisting: () => Promise<void> = async () => {
    throw fail("immutable state file already exists");
  },
): Promise<void> {
  linuxOnly();
  const directory = dirname(target);
  await privateDirectory(ops, directory);
  const temp = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  let file: StoreFile | undefined;
  let tempOwned = false;
  try {
    file = await ops.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    tempOwned = true;
    await fullWrite(file, bytes);
    await file.sync();
    await file.close();
    file = undefined;
    try {
      await ops.link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyExisting();
    }
    await ops.unlink(temp);
    await ops.syncDir(directory);
  } catch (error) {
    try {
      await file?.close();
    } catch {
      /* preserve primary failure */
    }
    if (tempOwned)
      try {
        await ops.unlink(temp);
        await ops.syncDir(directory);
      } catch {
        /* preserve primary failure */
      }
    throw error instanceof AwslError
      ? error
      : fail("immutable state write failed", error);
  }
}

export async function regularFile(
  ops: AtomicFileOps,
  path: string,
): Promise<void> {
  try {
    const stat = await ops.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw fail("state file is not regular");
  } catch (error) {
    throw error instanceof AwslError
      ? error
      : fail("could not verify state file", error);
  }
}
