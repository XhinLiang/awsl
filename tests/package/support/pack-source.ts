import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  readFile,
  readdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { join, relative } from "node:path";

export interface TreeEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly mtimeMs: number;
  readonly sha256?: string;
  readonly target?: string;
}

export async function snapshotTree(
  root: string,
): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    const entry = {
      path: relative(root, path),
      mode: metadata.mode & 0o7777,
      mtimeMs: metadata.mtimeMs,
    };
    if (metadata.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const child of await readdir(path)) await visit(join(path, child));
      return;
    }
    if (metadata.isFile()) {
      entries.push({
        ...entry,
        type: "file",
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
      return;
    }
    if (metadata.isSymbolicLink()) {
      entries.push({ ...entry, type: "symlink", target: await readlink(path) });
      return;
    }
    throw new Error(`unsupported tree entry: ${path}`);
  };
  await visit(root);
  return Object.freeze(
    entries.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

export async function createIsolatedPackSource(options: {
  readonly repositoryRoot: string;
  readonly destination: string;
}): Promise<void> {
  await cp(options.repositoryRoot, options.destination, {
    recursive: true,
    filter: (source) =>
      source !== join(options.repositoryRoot, ".git") &&
      source !== join(options.repositoryRoot, "node_modules"),
  });
  await symlink(
    join(options.repositoryRoot, "node_modules"),
    join(options.destination, "node_modules"),
    "dir",
  );
}
