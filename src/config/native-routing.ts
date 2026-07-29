import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isProxy } from "node:util/types";

import { parse } from "smol-toml";

import {
  canonicalJson,
  isUnicodeScalarString,
} from "../core/canonical-json.js";
import { AwslError } from "../core/errors.js";
import type { ProviderId } from "../core/types.js";
import { parseUniqueJson } from "../core/unique-json.js";
import { validateCodexProfile, validateProviderArgs } from "./model-map.js";
import {
  isMissingSourceError,
  lexicalPath,
  readRegularUtf8Text,
  resolveProjectRoot,
} from "./paths.js";
import { validateNormalizedProviderVersion } from "./provider-identity.js";
import type { Sha256Digest } from "./provider-pin.js";

export interface NativeRoutingFingerprintInput {
  readonly provider: ProviderId;
  readonly providerVersion: string;
  readonly canonicalCwd: string;
  readonly homeDir: string;
  readonly env: unknown;
  readonly safeArgs: readonly string[];
  readonly profile?: string;
}

type FieldMarker =
  | readonly [name: string, state: "missing", value: null]
  | readonly [name: string, state: "present", value: string | boolean];

type LayerProjection =
  | readonly [
      kind: "layer",
      tag: string,
      requestedPath: string,
      state: "missing",
      realpath: null,
      projection: null,
    ]
  | readonly [
      kind: "layer",
      tag: string,
      requestedPath: string,
      state: "present",
      realpath: string,
      projection: unknown,
    ];

const INPUT_KEYS = Object.freeze([
  "provider",
  "providerVersion",
  "canonicalCwd",
  "homeDir",
  "env",
  "safeArgs",
]);

const CODEX_ENVIRONMENT = Object.freeze([
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
] as const);

const CLAUDE_ENVIRONMENT = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
] as const);

const CODEX_FIELDS = Object.freeze([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "service_tier",
] as const);

const CODEX_PROVIDER_FIELDS = Object.freeze([
  "name",
  "base_url",
  "wire_api",
  "requires_openai_auth",
] as const);

const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function invalidData(): never {
  throw new TypeError("invalid routing projection data");
}

function captureInput(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value))
      throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...INPUT_KEYS, "profile"]);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowed.has(key) ||
          descriptors[key].enumerable !== true ||
          !("value" in descriptors[key]),
      ) ||
      INPUT_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    )
      throw new TypeError();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) result[key] = descriptors[key].value;
    return Object.freeze(result);
  } catch {
    configError("native routing fingerprint input must be exact data");
  }
}

function routingText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isUnicodeScalarString(value)
  )
    invalidData();
  return value;
}

function routingUrl(value: unknown): string {
  const source = routingText(value);
  if (/[\s\\?#]/u.test(source)) invalidData();
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) invalidData();
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return invalidData();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  )
    invalidData();
  return source;
}

function projectionRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    Array.isArray(value)
  )
    invalidData();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidData();
  return value as Record<string, unknown>;
}

function ownData(
  value: Record<string, unknown>,
  key: string,
):
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalidData();
  }
  if (descriptor === undefined) return { present: false };
  if (
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  )
    invalidData();
  return { present: true, value: descriptor.value };
}

function stringMarker(
  object: Record<string, unknown>,
  name: string,
): FieldMarker {
  const field = ownData(object, name);
  return field.present
    ? [name, "present", routingText(field.value)]
    : [name, "missing", null];
}

function urlMarker(object: Record<string, unknown>, name: string): FieldMarker {
  const field = ownData(object, name);
  return field.present
    ? [name, "present", routingUrl(field.value)]
    : [name, "missing", null];
}

function booleanMarker(
  object: Record<string, unknown>,
  name: string,
): FieldMarker {
  const field = ownData(object, name);
  if (!field.present) return [name, "missing", null];
  if (typeof field.value !== "boolean") invalidData();
  return [name, "present", field.value];
}

function environmentObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || isProxy(value))
    configError("native routing environment must be an object");
  return value as Record<string, unknown>;
}

function environmentValue(
  environment: Record<string, unknown>,
  name: string,
): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(environment, name);
  } catch {
    configError(`native routing environment field ${name} is invalid`);
  }
  if (descriptor === undefined) return undefined;
  if (
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  )
    configError(`native routing environment field ${name} is invalid`);
  if (descriptor.value === undefined) return undefined;
  if (typeof descriptor.value !== "string")
    configError(`native routing environment field ${name} is invalid`);
  return descriptor.value;
}

function lexicalAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    !isUnicodeScalarString(value)
  )
    configError(`${label} is invalid`);
  try {
    if (lexicalPath(value, "/") !== value) throw new TypeError();
  } catch {
    configError(`${label} is invalid`);
  }
  return value;
}

async function canonicalDirectory(
  value: unknown,
  label: string,
): Promise<string> {
  const requested = lexicalAbsolute(value, label);
  try {
    const physical = await realpath(requested);
    const information = await stat(physical);
    if (!information.isDirectory() || physical !== requested)
      throw new TypeError();
  } catch {
    configError(`${label} must be a canonical directory`);
  }
  return requested;
}

function locatorRoot(
  environment: Record<string, unknown>,
  name: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  fallback: string,
  cwd: string,
): string {
  const value = environmentValue(environment, name);
  if (value === undefined || value.length === 0)
    return lexicalPath(fallback, cwd);
  if (!isUnicodeScalarString(value)) configError(`${name} is invalid`);
  try {
    return lexicalPath(value, cwd);
  } catch {
    configError(`${name} is invalid`);
  }
}

function projectedEnvironment(
  environment: Record<string, unknown>,
  provider: ProviderId,
): readonly FieldMarker[] {
  const names = provider === "codex" ? CODEX_ENVIRONMENT : CLAUDE_ENVIRONMENT;
  return names.map((name) => {
    const value = environmentValue(environment, name);
    if (value === undefined) return [name, "missing", null] as const;
    try {
      if (name === "OPENAI_BASE_URL" || name === "ANTHROPIC_BASE_URL")
        return [name, "present", routingUrl(value)] as const;
      return [name, "present", routingText(value)] as const;
    } catch {
      configError(`native routing environment field ${name} is invalid`);
    }
  });
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function codexProjection(value: unknown): readonly unknown[] {
  const input = projectionRecord(value);
  const fields: unknown[] = CODEX_FIELDS.map((name) =>
    stringMarker(input, name),
  );
  const providers = ownData(input, "model_providers");
  if (!providers.present) {
    fields.push(["model_providers", "missing", null]);
    return fields;
  }

  const table = projectionRecord(providers.value);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(table);
  } catch {
    return invalidData();
  }
  if (keys.some((key) => typeof key === "symbol")) invalidData();
  const names = (keys as string[]).sort(utf8Compare);
  const entries = names.map((name) => {
    routingText(name);
    const provider = ownData(table, name);
    if (!provider.present) invalidData();
    const providerTable = projectionRecord(provider.value);
    const projection = CODEX_PROVIDER_FIELDS.map((field) => {
      if (field === "base_url") return urlMarker(providerTable, field);
      if (field === "requires_openai_auth")
        return booleanMarker(providerTable, field);
      return stringMarker(providerTable, field);
    });
    return [name, projection] as const;
  });
  fields.push(["model_providers", "present", entries]);
  return fields;
}

function claudeProjection(value: unknown): readonly FieldMarker[] {
  const input = projectionRecord(value);
  const model = stringMarker(input, "model");
  const effort = ownData(input, "effortLevel");
  if (!effort.present) return [model, ["effortLevel", "missing", null]];
  if (typeof effort.value !== "string" || !CLAUDE_EFFORTS.has(effort.value))
    invalidData();
  return [model, ["effortLevel", "present", effort.value]];
}

async function codexLayer(
  tag: string,
  requestedPath: string,
  cwd: string,
): Promise<LayerProjection> {
  let snapshot: Awaited<ReturnType<typeof readRegularUtf8Text>>;
  try {
    snapshot = await readRegularUtf8Text(requestedPath, cwd);
  } catch (error) {
    if (isMissingSourceError(error))
      return ["layer", tag, requestedPath, "missing", null, null];
    configError(
      `cannot read Codex native config at ${JSON.stringify(requestedPath)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(snapshot.source);
  } catch {
    configError(
      `invalid Codex native config syntax at ${JSON.stringify(requestedPath)}`,
    );
  }
  let projection: readonly unknown[];
  try {
    projection = codexProjection(parsed);
  } catch {
    configError(
      `invalid Codex native config schema at ${JSON.stringify(requestedPath)}`,
    );
  }
  return [
    "layer",
    tag,
    requestedPath,
    "present",
    snapshot.realpath,
    projection,
  ];
}

async function claudeLayer(
  tag: string,
  requestedPath: string,
  cwd: string,
): Promise<LayerProjection> {
  let snapshot: Awaited<ReturnType<typeof readRegularUtf8Text>>;
  try {
    snapshot = await readRegularUtf8Text(requestedPath, cwd);
  } catch (error) {
    if (isMissingSourceError(error))
      return ["layer", tag, requestedPath, "missing", null, null];
    configError(
      `cannot read Claude native settings at ${JSON.stringify(requestedPath)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseUniqueJson(snapshot.source);
  } catch {
    configError(
      `invalid Claude native settings syntax at ${JSON.stringify(requestedPath)}`,
    );
  }
  let projection: readonly FieldMarker[];
  try {
    projection = claudeProjection(parsed);
  } catch {
    configError(
      `invalid Claude native settings schema at ${JSON.stringify(requestedPath)}`,
    );
  }
  return [
    "layer",
    tag,
    requestedPath,
    "present",
    snapshot.realpath,
    projection,
  ];
}

function digest(preimage: unknown): Sha256Digest {
  try {
    return `sha256:${createHash("sha256")
      .update(canonicalJson(preimage), "utf8")
      .digest("hex")}`;
  } catch {
    configError("native routing projection is not canonical data");
  }
}

export async function nativeRoutingFingerprint(
  value: NativeRoutingFingerprintInput,
): Promise<Sha256Digest> {
  const input = captureInput(value);
  const provider = input.provider;
  if (provider !== "codex" && provider !== "claude")
    configError("native routing provider is invalid");
  const providerVersion = validateNormalizedProviderVersion(
    provider,
    input.providerVersion,
  );
  const safeArgs = validateProviderArgs(
    provider,
    input.safeArgs as readonly string[],
  );
  let profile: string | undefined;
  if (provider === "codex") {
    if (Object.hasOwn(input, "profile"))
      profile = validateCodexProfile(input.profile);
  } else if (Object.hasOwn(input, "profile")) {
    configError("Claude native routing does not accept a profile");
  }

  const environment = environmentObject(input.env);
  const cwd = await canonicalDirectory(
    input.canonicalCwd,
    "native routing canonicalCwd",
  );
  const projectRoot = await resolveProjectRoot(cwd);
  const homeDir = lexicalAbsolute(input.homeDir, "native routing homeDir");
  const environmentProjection = projectedEnvironment(environment, provider);

  if (provider === "codex") {
    const namespace = `codex-cli@${providerVersion}`;
    const codexHome = locatorRoot(
      environment,
      "CODEX_HOME",
      join(homeDir, ".codex"),
      cwd,
    );
    const layers: LayerProjection[] = [
      await codexLayer(
        `${namespace}/config:base/v1`,
        lexicalPath(join(codexHome, "config.toml"), cwd),
        cwd,
      ),
    ];
    if (profile !== undefined)
      layers.push(
        await codexLayer(
          `${namespace}/config:profile/v1`,
          lexicalPath(join(codexHome, `${profile}.config.toml`), cwd),
          cwd,
        ),
      );
    layers.push(
      await codexLayer(
        `${namespace}/config:project/v1`,
        lexicalPath(join(projectRoot, ".codex", "config.toml"), cwd),
        cwd,
      ),
    );
    return digest([
      "awsl-native-routing:v1",
      ["provider", provider, providerVersion],
      ...layers,
      ["environment", `${namespace}/env/v1`, environmentProjection],
      ["safe-args", `${namespace}/args/v1`, safeArgs],
      ["profile", `${namespace}/profile/v1`, profile ?? null],
    ]);
  }

  const claudeHome = locatorRoot(
    environment,
    "CLAUDE_CONFIG_DIR",
    join(homeDir, ".claude"),
    cwd,
  );
  const layers: LayerProjection[] = [
    await claudeLayer(
      "claude-code@2.1.218/settings:user/v1",
      lexicalPath(join(claudeHome, "settings.json"), cwd),
      cwd,
    ),
    await claudeLayer(
      "claude-code@2.1.218/settings:project/v1",
      lexicalPath(join(projectRoot, ".claude", "settings.json"), cwd),
      cwd,
    ),
    await claudeLayer(
      "claude-code@2.1.218/settings:project-local/v1",
      lexicalPath(join(projectRoot, ".claude", "settings.local.json"), cwd),
      cwd,
    ),
  ];
  return digest([
    "awsl-native-routing:v1",
    ["provider", provider, providerVersion],
    ...layers,
    ["environment", "claude-code@2.1.218/env/v1", environmentProjection],
    ["safe-args", "claude-code@2.1.218/args/v1", safeArgs],
  ]);
}
