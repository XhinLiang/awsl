import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

async function packagedTextFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await packagedTextFiles(path)));
    else if (
      entry.isFile() &&
      /\.(?:c?js|d\.ts|json|map|md|txt)$/u.test(entry.name)
    )
      result.push(path);
  }
  return result;
}

async function expectRelativeMarkdownLinksInPackage(
  packageRoot: string,
  reportPath: string,
): Promise<void> {
  const report = await readFile(reportPath, "utf8");
  const links = [...report.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map(
    (match) => match[1] as string,
  );
  for (const link of links) {
    const target = link.split(/[?#]/u, 1)[0] as string;
    if (!target || isAbsolute(target) || /^[a-z][a-z0-9+.-]*:/iu.test(target))
      continue;
    const resolved = resolve(dirname(reportPath), target);
    const packageRelative = relative(packageRoot, resolved);
    expect(
      packageRelative === "" || !packageRelative.startsWith(".."),
      link,
    ).toBe(true);
    await expect(access(resolved), link).resolves.toBeUndefined();
  }
}

async function runInstalled(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly code: number | null; stdout: string; stderr: string }> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("installed CLI timed out"));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

test("packed CLI installs and runs from a clean directory", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "awsl-install-smoke-")),
  );
  const packDirectory = join(root, "pack");
  const packSource = join(root, "source");
  const project = join(root, "project");
  const fakeCodex = join(root, "fake-codex.mjs");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  await createIsolatedPackSource({
    repositoryRoot,
    destination: packSource,
  });
  await writeFile(
    fakeCodex,
    "#!/usr/bin/env node\n" +
      'if (!process.argv.includes("--version")) process.exit(9)\n' +
      'process.stdout.write("codex-cli 0.145.0\\n")\n',
    { mode: 0o700 },
  );
  await chmod(fakeCodex, 0o700);
  await writeFile(
    join(project, "package.json"),
    '{"name":"awsl-install-smoke","private":true,"type":"module"}\n',
  );
  await writeFile(
    join(project, "smoke.js"),
    "export const meta = { name: 'package-smoke', description: 'package smoke' }\n" +
      "return { installed: true, input: args }\n",
  );

  try {
    const liveDistBeforePack = await snapshotTree(join(repositoryRoot, "dist"));
    await run("pnpm", ["pack", "--pack-destination", packDirectory], {
      cwd: packSource,
      timeout: 20_000,
    });
    expect(await snapshotTree(join(repositoryRoot, "dist"))).toEqual(
      liveDistBeforePack,
    );
    const archives = (await readdir(packDirectory)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    expect(archives).toHaveLength(1);
    const archive = join(packDirectory, archives[0] as string);
    const listing = await run("tar", ["-tzf", archive], {
      cwd: packDirectory,
      timeout: 20_000,
    });
    const entries = listing.stdout.trim().split("\n");
    expect(entries).toEqual(
      expect.arrayContaining([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/CHANGELOG.md",
        "package/SECURITY.md",
        "package/docs/compatibility/claude-code-2.1.218.md",
        "package/docs/implementation/260729-real-codex-acceptance.md",
        "package/sbom.cdx.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/cli/main.js",
      ]),
    );
    expect(
      entries.every(
        (entry) =>
          entry === "package/package.json" ||
          entry === "package/README.md" ||
          entry === "package/LICENSE" ||
          entry === "package/CHANGELOG.md" ||
          entry === "package/SECURITY.md" ||
          entry === "package/docs/compatibility/claude-code-2.1.218.md" ||
          entry ===
            "package/docs/implementation/260729-real-codex-acceptance.md" ||
          entry === "package/sbom.cdx.json" ||
          entry.startsWith("package/dist/"),
      ),
    ).toBe(true);
    expect(entries.join("\n")).not.toMatch(
      /(?:^|\/)(?:src|tests|oracle|\.git|\.github|\.env|\.npmrc)(?:\/|$)|pnpm-lock\.yaml|\.pem$|\.key$/mu,
    );

    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await run("tar", ["-xzf", archive, "-C", extracted], {
      cwd: packDirectory,
      timeout: 20_000,
    });
    const packageRoot = join(extracted, "package");
    await expectRelativeMarkdownLinksInPackage(
      packageRoot,
      join(packageRoot, "docs", "compatibility", "claude-code-2.1.218.md"),
    );
    const packagedText = (
      await Promise.all(
        (
          await packagedTextFiles(packageRoot)
        ).map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    const personalPathCanary = ["/Us", "ers/", "private-build-user"].join("");
    const packagedSecretPattern = new RegExp(
      [
        ["/Us", "ers/", "[A-Za-z0-9._-]+"].join(""),
        "AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\\s*=",
        "BEGIN [A-Z ]*PRIVATE KEY",
        "npm_[A-Za-z0-9_-]{20,}",
      ].join("|"),
      "u",
    );
    expect(packagedSecretPattern.test(personalPathCanary)).toBe(true);
    expect(packagedText).not.toMatch(packagedSecretPattern);
    for (const path of await packagedTextFiles(
      join(extracted, "package", "dist"),
    ))
      if (path.endsWith(".map"))
        expect(await readFile(path, "utf8")).not.toContain('"sourcesContent"');

    await run("pnpm", ["add", "--offline", "--ignore-scripts", archive], {
      cwd: project,
      timeout: 20_000,
    });

    const executable = join(project, "node_modules", ".bin", "awsl");
    const execution = await runInstalled(
      executable,
      [
        join(project, "smoke.js"),
        "--args",
        '{"source":"installed-tarball"}',
        "--format",
        "json",
      ],
      {
        cwd: project,
        env: {
          HOME: join(root, "home"),
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: root,
          AWSL_CODEX_COMMAND: fakeCodex,
          AWSL_STATE_DIR: join(root, "state"),
          CODEX_HOME: join(root, "codex-home"),
        },
      },
    );
    expect(execution.code).toBe(0);
    expect(execution.stderr).toBe("");
    expect(JSON.parse(execution.stdout)).toMatchObject({
      status: "completed",
      result: {
        installed: true,
        input: { source: "installed-tarball" },
      },
    });

    const installedPackage = JSON.parse(
      await readFile(
        join(project, "node_modules", "awsl", "package.json"),
        "utf8",
      ),
    ) as {
      author?: string;
      bin?: { awsl?: string };
      bugs?: { url?: string };
      engines?: { node?: string };
      homepage?: string;
      repository?: { type?: string; url?: string };
    };
    expect(installedPackage.bin?.awsl).toBe("./dist/cli/main.js");
    expect(installedPackage.engines?.node).toBe(">=22");
    expect(installedPackage).toMatchObject({
      author: "xhinliang <xhinliang@gmail.com>",
      bugs: { url: "https://github.com/XhinLiang/awsl/issues" },
      homepage: "https://github.com/XhinLiang/awsl#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/XhinLiang/awsl.git",
      },
    });

    const version = await runInstalled(executable, ["--version"], {
      cwd: project,
      env: {
        HOME: join(root, "home"),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: root,
      },
    });
    expect(version).toMatchObject({
      code: 0,
      stderr: "",
      stdout: `${(installedPackage as { version: string }).version}\n`,
    });

    const library = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("awsl").then((value) => process.stdout.write(value.COMPAT_PROFILE.id))',
      ],
      { cwd: project, timeout: 20_000 },
    );
    expect(library.stdout).toBe("claude-code@2.1.218");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
