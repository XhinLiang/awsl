import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import {
  createIsolatedPackSource,
  snapshotTree,
} from "./support/pack-source.js";

const run = promisify(execFile);
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

test("resolves the emitted builtin from an installed package tarball", async () => {
  const rootPackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { packageManager?: string };
  expect(rootPackage.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u);
  const root = await mkdtemp(join(tmpdir(), "awsl-packed-builtin-"));
  const packDirectory = join(root, "pack");
  const packSource = join(root, "source");
  const project = join(root, "project");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  await createIsolatedPackSource({
    repositoryRoot,
    destination: packSource,
  });
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({
      name: "packed-builtin-smoke",
      private: true,
      type: "module",
      packageManager: rootPackage.packageManager,
    })}\n`,
  );
  expect(
    (
      JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
        packageManager?: string;
      }
    ).packageManager,
  ).toBe(rootPackage.packageManager);

  try {
    const liveDistBeforePack = await snapshotTree(join(repositoryRoot, "dist"));
    await run("pnpm", ["pack", "--pack-destination", packDirectory], {
      cwd: packSource,
    });
    expect(await snapshotTree(join(repositoryRoot, "dist"))).toEqual(
      liveDistBeforePack,
    );
    const archives = (await readdir(packDirectory)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    expect(archives).toHaveLength(1);
    const archive = join(packDirectory, archives[0] as string);
    await run("pnpm", ["add", "--offline", "--ignore-scripts", archive], {
      cwd: project,
    });

    const smoke = String.raw`
        import { createHash } from "node:crypto";
        import { dirname, join } from "node:path";
        import { fileURLToPath, pathToFileURL } from "node:url";

        const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("awsl"))));
        const { createRegistry } = await import(pathToFileURL(
          join(packageRoot, "dist", "compat", "agent-registry.js"),
        ));
        const { WORKFLOW_SUBAGENT_SOURCE } = await import(pathToFileURL(
          join(packageRoot, "dist", "compat", "builtins", "workflow-subagent.js"),
        ));
        let deepImportBlocked = false;
        try {
          await import("awsl/dist/compat/agent-registry.js");
        } catch (error) {
          deepImportBlocked = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
        }

        const registry = await createRegistry({
          cwd: process.cwd(),
          claudeConfigDir: join(process.cwd(), "isolated-claude"),
          homeDir: join(process.cwd(), "isolated-home"),
        });
        const resolved = await registry.resolveAgent("workflow-subagent");
        process.stdout.write(JSON.stringify({
          exportedSource: WORKFLOW_SUBAGENT_SOURCE,
          instructions: resolved.agent.instructions,
          source: resolved.source,
          tier: resolved.tier,
          deepImportBlocked,
          expectedHash: "sha256:" + createHash("sha256")
            .update(WORKFLOW_SUBAGENT_SOURCE, "utf8")
            .digest("hex"),
        }));
      `;
    const execution = await run(
      process.execPath,
      ["--input-type=module", "--eval", smoke],
      { cwd: project, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(execution.stdout) as {
      exportedSource: string;
      expectedHash: string;
      deepImportBlocked: boolean;
      instructions: string;
      source: {
        identifier: string;
        realpath: null;
        sha256: string;
        tier: string;
      };
      tier: string;
    };

    expect(result.deepImportBlocked).toBe(true);
    expect(result.tier).toBe("builtin");
    expect(result.source).toEqual({
      identifier: "workflow-subagent",
      realpath: null,
      sha256: result.expectedHash,
      tier: "builtin",
    });
    expect(result.exportedSource).toContain(
      "name: workflow-subagent\ndescription: Default AWSl workflow subagent",
    );
    expect(result.instructions).toBe(
      "You are a workflow subagent. Complete the requested task in the provided\n" +
        "working directory, follow the inherited project instructions and provider\n" +
        "policy, and return the result needed by the parent workflow.\n",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
