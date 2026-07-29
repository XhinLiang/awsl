import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  type RegularUtf8ReadOps,
  readRegularUtf8Text,
} from "../../src/config/paths.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("rejects a resolved source replaced between stat and open", async () => {
  const root = await mkdtemp(join(tmpdir(), "awsl-path-race-"));
  cleanup.push(root);
  const target = join(root, "source.json");
  const replacement = join(root, "replacement.json");
  const displaced = join(root, "displaced.json");
  const canary = "REPLACEMENT_SECRET_CANARY";
  await writeFile(target, '{"model":"first"}');
  await writeFile(replacement, `{"model":"${canary}"}`);
  const physicalTarget = await realpath(target);
  let armed = true;
  const ops: RegularUtf8ReadOps = {
    lstat: (path) => lstat(path),
    realpath: (path) => realpath(path),
    stat: (path) => stat(path),
    open: async (path, flags) => {
      if (armed && path === physicalTarget) {
        armed = false;
        await rename(target, displaced);
        await rename(replacement, target);
      }
      return open(path, flags);
    },
  };

  let failure: unknown;
  try {
    await readRegularUtf8Text(target, root, 512 * 1024, ops);
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    code: "CONFIG_ERROR",
    recoverable: false,
    cause: undefined,
  });
  expect(String(failure)).not.toContain(canary);
  expect(JSON.stringify(failure)).not.toContain(canary);
  expect(armed).toBe(false);
});
