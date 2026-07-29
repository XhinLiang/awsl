import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

test("pins every GitHub Action to an immutable commit", async () => {
  const workflowRoot = join(repositoryRoot, ".github", "workflows");
  const workflowNames = (await readdir(workflowRoot))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  expect(workflowNames).toEqual(["ci.yml", "release.yml"]);

  for (const name of workflowNames) {
    const workflow = await readFile(join(workflowRoot, name), "utf8");
    const uses = [...workflow.matchAll(/^\s*-\s+uses:\s+(\S+)/gmu)].map(
      (match) => match[1],
    );
    expect(uses.length, name).toBeGreaterThan(0);
    expect(
      uses.every((action) => /@[0-9a-f]{40}$/u.test(action ?? "")),
      name,
    ).toBe(true);
  }
});

test("keeps publication OIDC-only and fail-closed on release identity", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const security = await readFile(join(repositoryRoot, "SECURITY.md"), "utf8");
  expect(workflow).toMatch(/release:\s*\n\s+types:\s*\[published\]/u);
  expect(workflow).toMatch(/contents:\s+read/u);
  expect(workflow).toMatch(/id-token:\s+write/u);
  expect(workflow).toContain("npm@11.5.1");
  expect(workflow).toContain('case "$package_name" in');
  expect(workflow).toContain('expected_repository="git+https://github.com/');
  expect(workflow).toContain("security/advisories/new");
  expect(workflow).toContain("latest release");
  expect(security).toContain(
    "https://github.com/XhinLiang/awsl/security/advisories/new",
  );
  expect(security).toContain("| `main` and latest release | Supported |");
  expect(security).toContain("| Older releases | Unsupported |");
  expect(workflow).toContain("npm publish");
  expect(workflow).toContain("--provenance");
  expect(workflow).toContain("--access public");
  expect(workflow).not.toMatch(
    /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.[A-Za-z0-9_]+/u,
  );
});
