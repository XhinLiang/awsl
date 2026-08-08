import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { installSkills } from "../../src/skills/install.js";

describe("skill installation", () => {
  test("installs, updates, and then leaves the bundled skill unchanged", async () => {
    const home = await mkdtemp(join(tmpdir(), "awsl-skills-"));
    const first = await installSkills(home);
    const target = join(home, ".agents", "skills", "awsl");
    expect(first).toEqual({
      root: join(home, ".agents", "skills"),
      skills: [{ name: "awsl", path: target, status: "installed" }],
    });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain(
      "name: awsl",
    );
    expect(
      await readFile(join(target, "agents", "openai.yaml"), "utf8"),
    ).toContain('display_name: "awsl Workflows"');

    await writeFile(join(target, "SKILL.md"), "stale\n");
    expect((await installSkills(home)).skills[0]?.status).toBe("updated");
    expect((await installSkills(home)).skills[0]?.status).toBe("unchanged");
  });

  test("refuses to write through a symlinked managed skill directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "awsl-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "awsl-skills-outside-"));
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(home, ".agents", "skills", "awsl"), "dir");

    await expect(installSkills(home)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });
});
