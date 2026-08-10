import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { executeCli } from "../../src/cli/commands.js";

test("--install-skills installs the user-level Codex skill", async () => {
  const home = await mkdtemp(join(tmpdir(), "awsl-cli-skills-"));
  let stdout = "";
  let stderr = "";
  const context = {
    cwd: home,
    env: {},
    homeDir: home,
    stdoutIsTTY: true,
    stdin: { isTTY: true, read: async () => "" },
    writeStdout: async (value: string) => {
      stdout += value;
    },
    writeStderr: async (value: string) => {
      stderr += value;
    },
  };

  expect(await executeCli(["--install-skills"], context)).toBe(0);
  expect(stdout).toBe(
    `Installed: ${join(home, ".agents", "skills", "awsl")}\n`,
  );
  expect(stderr).toBe("");
  expect(
    await readFile(join(home, ".agents", "skills", "awsl", "SKILL.md"), "utf8"),
  ).toContain("Do not search for or select repository Skills");
});
