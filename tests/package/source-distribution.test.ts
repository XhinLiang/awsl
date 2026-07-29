import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

async function publicFiles(): Promise<string[]> {
  const options = {
    cwd: repositoryRoot,
    encoding: "buffer" as const,
    maxBuffer: 8 * 1024 * 1024,
  };
  const [listed, deleted] = await Promise.all([
    run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      options,
    ),
    run("git", ["ls-files", "--deleted", "-z"], options),
  ]);
  const deletedPaths = new Set(
    deleted.stdout.toString("utf8").split("\0").filter(Boolean),
  );
  return listed.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !deletedPaths.has(path))
    .sort();
}

function literalPattern(parts: readonly string[]): RegExp {
  return new RegExp(parts.join(""), "iu");
}

test("excludes the complete external fixture directory", async () => {
  const files = await publicFiles();
  const externalFixturePrefix = ["tests/fixtures/", "ven", "dor/"].join("");
  expect(
    files.filter((path) => path.startsWith(externalFixturePrefix)),
  ).toEqual([]);
});

test("keeps public source free of private context and release secrets", async () => {
  const files = await publicFiles();

  const forbiddenFile =
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc)$|\.(?:key|pem)$/u;
  expect(files.filter((path) => forbiddenFile.test(path))).toEqual([]);

  const personalPathPattern = new RegExp(
    ["/Us", "ers/", "[A-Za-z0-9._-]+"].join(""),
    "u",
  );
  const personalPathCanary = ["/Us", "ers/", "private-build-user"].join("");
  expect(personalPathPattern.test(personalPathCanary)).toBe(true);
  const privateKeyHeaderPattern = new RegExp(
    ["-----BEGIN ", "(?:(?:RSA|DSA|EC|OPENSSH) )?", "PRIVATE KEY-----"].join(
      "",
    ),
    "u",
  );
  const privateKeyHeaderCanaries = [
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
    ["-----BEGIN ", "EC PRIVATE KEY-----"].join(""),
    ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join(""),
  ];
  expect(
    privateKeyHeaderCanaries.every((value) =>
      privateKeyHeaderPattern.test(value),
    ),
  ).toBe(true);
  const sourceHostCredentialPattern = new RegExp(
    [
      "(?:",
      ["gh", "[pousr]"].join(""),
      "|",
      ["git", "hub", "_pat"].join(""),
      ")_[A-Za-z0-9_]{20,}",
    ].join(""),
    "u",
  );
  const sourceHostCredentialCanaries = [
    ["gh", "p_", "A".repeat(20)].join(""),
    ["git", "hub", "_pat_", "A".repeat(20)].join(""),
  ];
  expect(
    sourceHostCredentialCanaries.every((value) =>
      sourceHostCredentialPattern.test(value),
    ),
  ).toBe(true);
  const accessKeyPrefixes = [["A", "KIA"].join(""), ["A", "SIA"].join("")];
  const secretPatterns: readonly { readonly label: string; pattern: RegExp }[] =
    [
      {
        label: "personal home path",
        pattern: personalPathPattern,
      },
      {
        label: "private key material",
        pattern: privateKeyHeaderPattern,
      },
      {
        label: "registry credential",
        pattern: new RegExp(["npm", "_[A-Za-z0-9_-]{20,}"].join(""), "u"),
      },
      {
        label: "source-host credential",
        pattern: sourceHostCredentialPattern,
      },
      {
        label: "model-provider credential",
        pattern: new RegExp(["sk", "-[A-Za-z0-9_-]{20,}"].join(""), "u"),
      },
      {
        label: "cloud access credential",
        pattern: new RegExp(
          `(?:${accessKeyPrefixes.join("|")})[A-Z0-9]{16}`,
          "u",
        ),
      },
    ];
  const privateContextPatterns: readonly {
    readonly label: string;
    pattern: RegExp;
  }[] = [
    { label: "company identifier 1", pattern: literalPattern(["sho", "pee"]) },
    { label: "company identifier 2", pattern: literalPattern(["ga", "rena"]) },
    {
      label: "internal product identifier 1",
      pattern: literalPattern(["sea", "talk"]),
    },
    {
      label: "internal product identifier 2",
      pattern: literalPattern(["bee", "ai"]),
    },
    {
      label: "internal product identifier 3",
      pattern: literalPattern(["mi", "goo"]),
    },
    {
      label: "internal tool identifier",
      pattern: literalPattern(["bb", "cli"]),
    },
    {
      label: "private collaboration identifier",
      pattern: literalPattern(["not", "ion"]),
    },
    {
      label: "private workflow identifier",
      pattern: literalPattern(["work", "-", "stat"]),
    },
    {
      label: "private workflow environment",
      pattern: literalPattern(["awsl", "_work", "_stat"]),
    },
    {
      label: "private source host",
      pattern: literalPattern(["git", ".", "ga", "rena"]),
    },
    {
      label: "private business scope",
      pattern: new RegExp(
        [
          "(?:",
          ["te", "am"].join(""),
          "[^\\n]{0,160}\\b",
          ["B", "E"].join(""),
          "\\b|\\b",
          ["B", "E"].join(""),
          "\\b[^\\n]{0,160}",
          ["te", "am"].join(""),
          ")",
        ].join(""),
        "iu",
      ),
    },
  ];

  for (const path of files) {
    const content = await readFile(join(repositoryRoot, path));
    const text = content.toString("utf8");
    const candidate = `${path}\n${text}`;
    for (const { label, pattern } of [
      ...privateContextPatterns,
      ...secretPatterns,
    ])
      expect(pattern.test(candidate), `${path}: ${label}`).toBe(false);
  }
});
