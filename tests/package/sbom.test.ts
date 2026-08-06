import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

interface SbomComponent {
  readonly "bom-ref": string;
  readonly name: string;
  readonly version: string;
  readonly hashes?: readonly {
    readonly alg: string;
    readonly content: string;
  }[];
}

interface SbomDependency {
  readonly ref: string;
  readonly dependsOn: readonly string[];
}

test("generates a deterministic production-only CycloneDX SBOM", async () => {
  const root = await mkdtemp(join(tmpdir(), "awsl-sbom-"));
  const firstPath = join(root, "first.cdx.json");
  const secondPath = join(root, "second.cdx.json");
  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { readonly version: string };
  const rootPurl = `pkg:npm/%40xhinliang/awsl@${packageManifest.version}`;

  try {
    for (const output of [firstPath, secondPath])
      await run(
        process.execPath,
        ["scripts/generate-sbom.mjs", "--output", output],
        { cwd: repositoryRoot, timeout: 20_000 },
      );

    const first = await readFile(firstPath);
    expect(await readFile(secondPath)).toEqual(first);
    expect(await readFile(join(repositoryRoot, "sbom.cdx.json"))).toEqual(
      first,
    );

    const parsed = JSON.parse(first.toString("utf8")) as {
      readonly bomFormat: string;
      readonly specVersion: string;
      readonly version: number;
      readonly metadata: {
        readonly component: SbomComponent & {
          readonly type: string;
          readonly purl: string;
          readonly licenses: readonly [
            { readonly license: { readonly id: string } },
          ];
        };
        readonly properties: readonly {
          readonly name: string;
          readonly value: string;
        }[];
      };
      readonly components: readonly SbomComponent[];
      readonly dependencies: readonly SbomDependency[];
    };

    expect(parsed).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          "bom-ref": rootPurl,
          type: "application",
          name: "@xhinliang/awsl",
          version: packageManifest.version,
          purl: rootPurl,
          licenses: [{ license: { id: "Apache-2.0" } }],
        },
        properties: [
          {
            name: "awsl:lockfile:sha256",
            value: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ],
      },
    });

    expect(
      parsed.components.map(({ name, version }) => `${name}@${version}`),
    ).toEqual([
      "acorn-walk@8.3.5",
      "acorn@8.17.0",
      "ajv-formats@3.0.1",
      "ajv@8.20.0",
      "commander@13.1.0",
      "fast-deep-equal@3.1.3",
      "fast-uri@3.1.5",
      "json-schema-traverse@1.0.0",
      "require-from-string@2.0.2",
      "smol-toml@1.7.1",
      "yaml@2.9.0",
    ]);
    expect(parsed.components.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["typescript", "vitest"]),
    );
    for (const component of parsed.components)
      expect(component.hashes).toEqual([
        {
          alg: "SHA-512",
          content: expect.stringMatching(/^[a-f0-9]{128}$/u),
        },
      ]);

    const allReferences = new Set([
      parsed.metadata.component["bom-ref"],
      ...parsed.components.map((component) => component["bom-ref"]),
    ]);
    expect(parsed.dependencies.map(({ ref }) => ref).sort()).toEqual(
      [...allReferences].sort(),
    );
    for (const dependency of parsed.dependencies) {
      expect(allReferences.has(dependency.ref)).toBe(true);
      expect(dependency.dependsOn).toEqual([...dependency.dependsOn].sort());
      for (const reference of dependency.dependsOn)
        expect(allReferences.has(reference)).toBe(true);
    }
    expect(
      parsed.dependencies.find(
        ({ ref }) => ref === parsed.metadata.component["bom-ref"],
      )?.dependsOn,
    ).toEqual([
      "pkg:npm/acorn-walk@8.3.5",
      "pkg:npm/acorn@8.17.0",
      "pkg:npm/ajv-formats@3.0.1",
      "pkg:npm/ajv@8.20.0",
      "pkg:npm/commander@13.1.0",
      "pkg:npm/smol-toml@1.7.1",
      "pkg:npm/yaml@2.9.0",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
