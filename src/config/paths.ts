import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { AwslError } from "../core/errors.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_SOURCE_BYTES = 512 * 1024;
const missingSourceErrors = new WeakSet<AwslError>();
function configError(message: string): AwslError {
  return new AwslError("CONFIG_ERROR", message, { recoverable: false });
}
function missingSourceError(): AwslError {
  const error = configError("source does not exist");
  missingSourceErrors.add(error);
  return error;
}
export function isMissingSourceError(error: unknown): boolean {
  return error instanceof AwslError && missingSourceErrors.has(error);
}
function unsafePath(path: string): boolean {
  return (
    path.includes("\0") ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:(?:$|[^\\/])/.test(path)
  );
}
export function lexicalPath(path: string, cwd: string): string {
  if (typeof path !== "string" || !path || unsafePath(path))
    throw configError("invalid path");
  if (typeof cwd !== "string" || !cwd || unsafePath(cwd))
    throw configError("invalid cwd path");
  return resolve(cwd, path);
}
export async function canonicalCwd(cwd: string): Promise<string> {
  let result: string;
  try {
    result = await realpath(lexicalPath(cwd, process.cwd()));
  } catch {
    throw configError("cwd does not exist");
  }
  try {
    if (!(await stat(result)).isDirectory())
      throw configError("cwd must be a directory");
  } catch (error) {
    if (error instanceof AwslError) throw error;
    throw configError("cannot inspect cwd");
  }
  return result;
}
export interface ReadSnapshot {
  realpath: string;
  bytes: Uint8Array;
  source: string;
  sha256: `sha256:${string}`;
}
export interface ReadTextSnapshot {
  realpath: string;
  source: string;
}
/** Dependency seam for deterministic race tests; production callers omit it. */
export interface RegularUtf8ReadOps {
  lstat(path: string): ReturnType<typeof lstat>;
  realpath(path: string): Promise<string>;
  stat(path: string): ReturnType<typeof stat>;
  open(path: string, flags: number): Promise<FileHandle>;
}
interface ReadBytesSnapshot extends ReadTextSnapshot {
  bytes: Uint8Array;
}
const regularUtf8ReadOps: RegularUtf8ReadOps = Object.freeze({
  lstat: (path: string) => lstat(path),
  realpath: (path: string) => realpath(path),
  stat: (path: string) => stat(path),
  open: (path: string, flags: number) => open(path, flags),
});
async function readRegularUtf8Bytes(
  path: string,
  cwd: string,
  maxBytes = MAX_SOURCE_BYTES,
  ops: RegularUtf8ReadOps = regularUtf8ReadOps,
): Promise<ReadBytesSnapshot> {
  const target = lexicalPath(path, cwd);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw configError("invalid source byte limit");
  try {
    await ops.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw missingSourceError();
    throw configError("cannot resolve source");
  }
  let physical: string;
  try {
    physical = await ops.realpath(target);
  } catch {
    throw configError("cannot resolve source");
  }
  let beforeOpen: Awaited<ReturnType<typeof stat>>;
  try {
    beforeOpen = await ops.stat(physical);
    if (!beforeOpen.isFile())
      throw configError("source must be a regular file");
  } catch (error) {
    if (error instanceof AwslError) throw error;
    throw configError("cannot inspect source");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await ops.open(
      physical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile()) throw configError("source must be a regular file");
    if (info.dev !== beforeOpen.dev || info.ino !== beforeOpen.ino)
      throw configError("source changed while opening");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes + 1 - length));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      length += result.bytesRead;
      if (length > maxBytes)
        throw configError(`source exceeds ${maxBytes} bytes`);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch {
      throw configError("source is not valid UTF-8");
    }
    return {
      realpath: physical,
      bytes,
      source,
    };
  } catch (error) {
    if (error instanceof AwslError) throw error;
    throw configError("cannot read source");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
/**
 * Reads bounded UTF-8 through one regular-file descriptor without deriving a
 * content identity. Native provider projections use this secret-safe surface.
 */
export async function readRegularUtf8Text(
  path: string,
  cwd: string,
  maxBytes = MAX_SOURCE_BYTES,
  ops: RegularUtf8ReadOps = regularUtf8ReadOps,
): Promise<ReadTextSnapshot> {
  const snapshot = await readRegularUtf8Bytes(path, cwd, maxBytes, ops);
  return Object.freeze({
    realpath: snapshot.realpath,
    source: snapshot.source,
  });
}
export async function readRegularUtf8(
  path: string,
  cwd: string,
  maxBytes = MAX_SOURCE_BYTES,
  ops: RegularUtf8ReadOps = regularUtf8ReadOps,
): Promise<ReadSnapshot> {
  const snapshot = await readRegularUtf8Bytes(path, cwd, maxBytes, ops);
  return {
    ...snapshot,
    sha256: `sha256:${createHash("sha256")
      .update(snapshot.bytes)
      .digest("hex")}`,
  };
}
export async function resolveProjectRoot(cwd: string): Promise<string> {
  let current = await canonicalCwd(cwd);
  while (true) {
    const dotGit = join(current, ".git");
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(dotGit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw configError("cannot inspect .git");
    }
    if (info) {
      if (info.isSymbolicLink())
        throw configError(".git must not be a symlink");
      if (info.isDirectory()) return current;
      if (!info.isFile())
        throw configError(".git must be a directory or gitdir file");
      const snapshot = await readRegularUtf8(dotGit, current, 4096);
      const match = /^gitdir: ([^\r\n\0]+)\n?$/.exec(snapshot.source);
      if (!match) throw configError("malformed .git gitdir file");
      let gitDir: string;
      try {
        gitDir = await realpath(lexicalPath(match[1], current));
      } catch {
        throw configError("gitdir target does not exist");
      }
      try {
        if (!(await stat(gitDir)).isDirectory())
          throw configError("gitdir target must be a directory");
      } catch (error) {
        if (error instanceof AwslError) throw error;
        throw configError("cannot inspect gitdir target");
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current || parse(current).root === current)
      return await canonicalCwd(cwd);
    current = parent;
  }
}
export async function resolveWorkflowPath(
  path: string,
  cwd: string,
): Promise<ReadSnapshot> {
  return readRegularUtf8(path, await canonicalCwd(cwd));
}
