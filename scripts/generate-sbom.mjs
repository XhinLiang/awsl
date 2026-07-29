import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = resolve(repositoryRoot, "package.json");
const lockfilePath = resolve(repositoryRoot, "pnpm-lock.yaml");

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} is invalid`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    fail(`${label} is invalid`);
  return value;
}

function outputPath(argv) {
  if (argv.length === 0) return resolve(repositoryRoot, "sbom.cdx.json");
  if (argv.length !== 2 || argv[0] !== "--output")
    fail("usage: generate-sbom.mjs [--output <path>]");
  return resolve(process.cwd(), text(argv[1], "output path"));
}

function purlName(name) {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (
      separator <= 1 ||
      separator === name.length - 1 ||
      name.indexOf("/", separator + 1) !== -1
    )
      fail(`package name ${name} is invalid`);
    return `${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(
      name.slice(separator + 1),
    )}`;
  }
  if (name.includes("/")) fail(`package name ${name} is invalid`);
  return encodeURIComponent(name);
}

function packagePurl(name, version) {
  return `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`;
}

function baseVersion(name, snapshotKey) {
  const prefix = `${name}@`;
  if (!snapshotKey.startsWith(prefix))
    fail(`snapshot ${snapshotKey} does not match ${name}`);
  const versionWithPeers = snapshotKey.slice(prefix.length);
  const peerStart = versionWithPeers.indexOf("(");
  const version =
    peerStart === -1 ? versionWithPeers : versionWithPeers.slice(0, peerStart);
  return text(version, `snapshot ${snapshotKey} version`);
}

function sha512Hex(integrity, packageKey) {
  const matched = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(
    text(integrity, `${packageKey} integrity`),
  );
  if (matched === null) fail(`${packageKey} integrity is not SHA-512`);
  const encoded = matched[1];
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== encoded)
    fail(`${packageKey} integrity is malformed`);
  return decoded.toString("hex");
}

function dependencyEntries(snapshot, snapshotKey) {
  const combined = new Map();
  for (const field of ["dependencies", "optionalDependencies"]) {
    const value = snapshot[field];
    if (value === undefined) continue;
    for (const [name, version] of Object.entries(
      record(value, `${snapshotKey} ${field}`),
    )) {
      const selected = text(version, `${snapshotKey} dependency ${name}`);
      const previous = combined.get(name);
      if (previous !== undefined && previous !== selected)
        fail(`${snapshotKey} has conflicting dependency ${name}`);
      combined.set(name, selected);
    }
  }
  return [...combined].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function sortedStrings(values) {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function buildSbom(manifest, lockfile, lockfileBytes) {
  const rootName = text(manifest.name, "package name");
  const rootVersion = text(manifest.version, "package version");
  const license = text(manifest.license, "package license");
  if (lockfile.lockfileVersion !== "9.0")
    fail("pnpm lockfile version is unsupported");

  const importers = record(lockfile.importers, "lockfile importers");
  const importer = record(importers["."], "root lockfile importer");
  const direct = record(importer.dependencies, "root production dependencies");
  const snapshots = record(lockfile.snapshots, "lockfile snapshots");
  const packages = record(lockfile.packages, "lockfile packages");
  const rootRef = packagePurl(rootName, rootVersion);
  const components = new Map();
  const graph = new Map();
  const instances = new Map();

  const resolveSnapshot = (name, versionReference) => {
    const key = `${name}@${versionReference}`;
    if (!Object.hasOwn(snapshots, key))
      fail(`lockfile snapshot ${key} is missing`);
    return key;
  };

  const visit = (name, snapshotKey) => {
    const version = baseVersion(name, snapshotKey);
    const ref = packagePurl(name, version);
    const previousInstance = instances.get(ref);
    if (previousInstance !== undefined && previousInstance !== snapshotKey)
      fail(`multiple lockfile instances collapse to ${ref}`);
    instances.set(ref, snapshotKey);
    if (components.has(ref)) return ref;

    const packageKey = `${name}@${version}`;
    const packageRecord = record(packages[packageKey], `package ${packageKey}`);
    components.set(ref, {
      "bom-ref": ref,
      type: "library",
      name,
      version,
      purl: ref,
      hashes: [
        {
          alg: "SHA-512",
          content: sha512Hex(
            record(packageRecord.resolution, `${packageKey} resolution`)
              .integrity,
            packageKey,
          ),
        },
      ],
    });

    const snapshot = record(snapshots[snapshotKey], `snapshot ${snapshotKey}`);
    const dependencies = dependencyEntries(snapshot, snapshotKey).map(
      ([dependencyName, versionReference]) =>
        visit(
          dependencyName,
          resolveSnapshot(dependencyName, versionReference),
        ),
    );
    graph.set(ref, sortedStrings(new Set(dependencies)));
    return ref;
  };

  const rootDependencies = [];
  for (const [name, descriptorValue] of Object.entries(direct)) {
    const descriptor = record(descriptorValue, `root dependency ${name}`);
    const versionReference = text(
      descriptor.version,
      `root dependency ${name} version`,
    );
    rootDependencies.push(visit(name, resolveSnapshot(name, versionReference)));
  }
  graph.set(rootRef, sortedStrings(new Set(rootDependencies)));

  const sortedComponents = [...components.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left["bom-ref"]), Buffer.from(right["bom-ref"])),
  );
  const dependencies = [...graph.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)),
    );

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        "bom-ref": rootRef,
        type: "application",
        name: rootName,
        version: rootVersion,
        purl: rootRef,
        licenses: [{ license: { id: license } }],
      },
      properties: [
        {
          name: "awsl:lockfile:sha256",
          value: createHash("sha256").update(lockfileBytes).digest("hex"),
        },
      ],
    },
    components: sortedComponents,
    dependencies,
  };
}

async function main() {
  const destination = outputPath(process.argv.slice(2));
  const [manifestBytes, lockfileBytes] = await Promise.all([
    readFile(packagePath),
    readFile(lockfilePath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const lockfile = parse(lockfileBytes.toString("utf8"));
  const sbom = buildSbom(
    record(manifest, "package manifest"),
    record(lockfile, "pnpm lockfile"),
    lockfileBytes,
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(sbom, null, 2)}\n`, {
    mode: 0o644,
  });
}

main().catch((error) => {
  process.stderr.write(
    `SBOM generation failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
