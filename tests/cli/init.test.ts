import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";
import { compileWorkflow } from "../../src/compat/compile.js";

const temporaryRoots: string[] = [];

async function memoryCli() {
  const cwd = await mkdtemp(join(tmpdir(), "awsl-init-"));
  temporaryRoots.push(cwd);
  let stdout = "";
  let stderr = "";
  return {
    cwd,
    context: {
      cwd,
      env: {
        ...process.env,
        AWSL_CODEX_COMMAND: join(cwd, "must-not-run"),
        AWSL_STATE_DIR: join(cwd, "must-not-exist"),
      },
      homeDir: cwd,
      stdoutIsTTY: false,
      stdin: { isTTY: true, read: async () => "" },
      writeStdout: async (value: string) => {
        stdout += value;
      },
      writeStderr: async (value: string) => {
        stderr += value;
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("awsl init", () => {
  test("creates a compact runnable starter without invoking a provider", async () => {
    const cli = await memoryCli();

    expect(await executeCli(["init"], cli.context)).toBe(0);

    const path = join(cli.cwd, "workflow.js");
    const source = await readFile(path, "utf8");
    expect(compileWorkflow(source, path).meta.name).toBe("starter");
    expect(source.split("\n").length).toBeLessThan(30);
    expect(cli.output()).toMatchObject({
      stderr: "",
      stdout: expect.stringContaining("awsl run"),
    });
  });

  test("copies a selected gallery template into a nested path", async () => {
    const cli = await memoryCli();

    expect(
      await executeCli(
        ["init", "workflows/review.js", "--template", "code-review"],
        cli.context,
      ),
    ).toBe(0);

    const path = join(cli.cwd, "workflows", "review.js");
    const source = await readFile(path, "utf8");
    expect(compileWorkflow(source, path).meta.name).toBe(
      "parallel-code-review",
    );
  });

  test("never overwrites an existing workflow", async () => {
    const cli = await memoryCli();
    const path = join(cli.cwd, "workflow.js");
    await writeFile(path, "user-owned\n");

    expect(await executeCli(["init"], cli.context)).toBe(2);
    expect(await readFile(path, "utf8")).toBe("user-owned\n");
    expect(cli.output()).toMatchObject({
      stdout: "",
      stderr: "USAGE_ERROR: invalid command line\n",
    });
  });

  test("rejects an unknown template without creating a file", async () => {
    const cli = await memoryCli();

    expect(
      await executeCli(["init", "nope.js", "--template", "nope"], cli.context),
    ).toBe(2);
    await expect(
      readFile(join(cli.cwd, "nope.js"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not render hostile filenames inside executable commands", async () => {
    const cli = await memoryCli();
    const filename = "$(printf injected).js";

    expect(await executeCli(["init", filename], cli.context)).toBe(0);
    expect(await readFile(join(cli.cwd, filename), "utf8")).toContain(
      'name: "starter"',
    );
    expect(cli.output().stdout).toContain(JSON.stringify(filename));
    expect(cli.output().stdout).not.toContain(
      `awsl run ${JSON.stringify(filename)}`,
    );
    expect(cli.output().stdout).toContain("awsl run <created-file>");
  });

  test("atomically allows only one concurrent creator", async () => {
    const first = await memoryCli();
    const second = {
      ...first,
      context: { ...first.context },
    };

    const exitCodes = await Promise.all([
      executeCli(["init"], first.context),
      executeCli(["init"], second.context),
    ]);

    expect(exitCodes.sort()).toEqual([0, 2]);
    const path = join(first.cwd, "workflow.js");
    expect(compileWorkflow(await readFile(path, "utf8"), path).meta.name).toBe(
      "starter",
    );
  });

  test("refuses a final symlink without changing its target", async () => {
    const cli = await memoryCli();
    const target = join(cli.cwd, "owned.js");
    await writeFile(target, "user-owned\n");
    await symlink(target, join(cli.cwd, "workflow.js"));

    expect(await executeCli(["init"], cli.context)).toBe(2);
    expect(await readFile(target, "utf8")).toBe("user-owned\n");
  });
});
