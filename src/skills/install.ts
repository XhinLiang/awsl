import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AwslError } from "../core/errors.js";

const skillName = "awsl";
const bundledFiles = Object.freeze(["SKILL.md", "agents/openai.yaml"]);
const sourceRoot = fileURLToPath(
  new URL("../../skills/awsl/", import.meta.url),
);

export type SkillInstallStatus = "installed" | "updated" | "unchanged";

export interface SkillInstallResult {
  readonly root: string;
  readonly skills: readonly {
    readonly name: string;
    readonly path: string;
    readonly status: SkillInstallStatus;
  }[];
}

async function metadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

function invalidTarget(): never {
  throw new AwslError("CONFIG_ERROR", "skill install target is invalid", {
    recoverable: false,
  });
}

async function ensureDirectory(path: string): Promise<boolean> {
  const existing = await metadata(path);
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) invalidTarget();
    return false;
  }
  await mkdir(path, { mode: 0o700 });
  return true;
}

async function installFile(
  source: string,
  target: string,
): Promise<"created" | "updated" | "unchanged"> {
  const sourceMetadata = await metadata(source);
  if (sourceMetadata === undefined || !sourceMetadata.isFile())
    throw new AwslError("PERSISTENCE_ERROR", "bundled skill is unavailable", {
      recoverable: false,
    });
  const content = await readFile(source);
  const targetMetadata = await metadata(target);
  if (targetMetadata !== undefined) {
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink())
      invalidTarget();
    if ((await readFile(target)).equals(content)) return "unchanged";
  }

  const temporary = join(
    dirname(target),
    `.awsl-skill-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return targetMetadata === undefined ? "created" : "updated";
}

export async function installSkills(
  homeDir: string,
): Promise<SkillInstallResult> {
  try {
    const agentsRoot = join(homeDir, ".agents");
    const skillsRoot = join(agentsRoot, "skills");
    const targetRoot = join(skillsRoot, skillName);
    const agentsCreated = await ensureDirectory(agentsRoot);
    if (agentsCreated) await mkdir(skillsRoot, { mode: 0o700 });
    else await ensureDirectory(skillsRoot);
    const targetCreated = await ensureDirectory(targetRoot);
    await ensureDirectory(join(targetRoot, "agents"));

    const states = await Promise.all(
      bundledFiles.map((relativePath) =>
        installFile(
          join(sourceRoot, relativePath),
          join(targetRoot, relativePath),
        ),
      ),
    );
    const status: SkillInstallStatus = targetCreated
      ? "installed"
      : states.includes("updated") || states.includes("created")
        ? "updated"
        : "unchanged";
    return Object.freeze({
      root: skillsRoot,
      skills: Object.freeze([
        Object.freeze({ name: skillName, path: targetRoot, status }),
      ]),
    });
  } catch (error) {
    if (error instanceof AwslError) throw error;
    throw new AwslError("PERSISTENCE_ERROR", "skill installation failed", {
      recoverable: false,
      cause: error,
    });
  }
}
