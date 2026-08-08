import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { AwslError } from "../core/errors.js";
import type { ProviderId } from "../core/types.js";
import { strictJsonPacket } from "../worker/json.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

export const MAX_INLINE_SCHEMA_BYTES = 64 * 1024;

export interface SerializeProviderJsonOptions {
  label: string;
  provider: ProviderId;
  maxBytes?: number;
}

export interface PreparedProviderJsonSchema {
  packet: string;
  matches(value: unknown): boolean;
}

export type PrepareCodexJsonSchemaOptions = Omit<
  SerializeProviderJsonOptions,
  "provider"
>;

const DRAFT_07_SCHEMA = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

function schemaDialect(schema: object): "draft-07" | "draft-2020-12" {
  const declared = Object.getOwnPropertyDescriptor(schema, "$schema")?.value;
  if (declared === undefined || declared === DRAFT_07_SCHEMA) {
    return "draft-07";
  }
  if (declared === DRAFT_2020_12_SCHEMA) return "draft-2020-12";
  throw new TypeError("unsupported JSON Schema dialect");
}

function rejectWorkflowRegularExpressions(schema: object): void {
  const schemaMaps = new Set([
    "$defs",
    "definitions",
    "dependentSchemas",
    "properties",
  ]);
  const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const schemaValues = new Set([
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]);
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || Array.isArray(value))
      continue;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef")
        throw new TypeError(
          "workflow-controlled schema references are not supported",
        );
      if (
        key === "pattern" ||
        key === "patternProperties" ||
        (key === "format" && entry === "regex")
      )
        throw new TypeError(
          "workflow-controlled regular expressions are not supported",
        );
      if (key === "items") {
        if (Array.isArray(entry)) pending.push(...entry);
        else pending.push(entry);
      } else if (schemaArrays.has(key) && Array.isArray(entry)) {
        pending.push(...entry);
      } else if (
        schemaMaps.has(key) &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry)
      ) {
        pending.push(...Object.values(entry));
      } else if (key === "dependencies") {
        if (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        )
          for (const dependency of Object.values(entry))
            if (!Array.isArray(dependency)) pending.push(dependency);
      } else if (schemaValues.has(key)) {
        pending.push(entry);
      }
    }
  }
}

function createSchemaValidator(schema: object) {
  if (Object.getOwnPropertyDescriptor(schema, "$async")?.value === true) {
    throw new TypeError("async JSON Schema validators are not supported");
  }
  rejectWorkflowRegularExpressions(schema);
  const ajv =
    schemaDialect(schema) === "draft-2020-12"
      ? new Ajv2020({ allErrors: true, strict: true })
      : new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (Object.getOwnPropertyDescriptor(validate, "$async")?.value === true) {
    throw new TypeError("async JSON Schema validators are not supported");
  }
  return validate;
}

export function serializeProviderJson(
  value: unknown,
  options: SerializeProviderJsonOptions,
): string {
  const maxBytes = options.maxBytes ?? MAX_INLINE_SCHEMA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  let packet: string;
  try {
    packet = strictJsonPacket(value, options.label);
  } catch (error) {
    throw new AwslError(
      "SCHEMA_ERROR",
      `${options.label} must be strict JSON data`,
      {
        provider: options.provider,
        recoverable: false,
        cause: error,
      },
    );
  }
  const bytes = Buffer.byteLength(packet);
  if (bytes > maxBytes) {
    throw new AwslError(
      "SCHEMA_ERROR",
      `${options.label} exceeds the ${maxBytes} bytes limit`,
      {
        provider: options.provider,
        recoverable: false,
      },
    );
  }
  return packet;
}

export function prepareProviderJsonSchema(
  value: unknown,
  options: SerializeProviderJsonOptions,
): PreparedProviderJsonSchema {
  const packet = serializeProviderJson(value, options);
  try {
    const schema = JSON.parse(packet) as object;
    const validate = createSchemaValidator(schema);
    return {
      packet,
      matches(candidate: unknown): boolean {
        return validate(candidate);
      },
    };
  } catch (error) {
    throw new AwslError(
      "SCHEMA_ERROR",
      `${options.label} is not a valid JSON Schema`,
      {
        provider: options.provider,
        recoverable: false,
        cause: error,
      },
    );
  }
}

const CODEX_SCHEMA_MAPS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "properties",
] as const;
const CODEX_SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const CODEX_SCHEMA_VALUES = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactRequiredKeys(
  required: unknown,
  propertyKeys: readonly string[],
): boolean {
  if (!Array.isArray(required) || required.length !== propertyKeys.length)
    return false;
  const requiredKeys = new Set(required);
  return (
    requiredKeys.size === propertyKeys.length &&
    propertyKeys.every((key) => requiredKeys.has(key))
  );
}

function includesObjectType(type: unknown): boolean {
  return (
    type === "object" ||
    (Array.isArray(type) && type.some((entry) => entry === "object"))
  );
}

function inferConstType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function projectCodexSchema(schema: unknown): boolean {
  if (!isSchemaRecord(schema)) return false;
  let changed = false;
  if (Object.hasOwn(schema, "const")) {
    const constant = schema.const;
    Reflect.deleteProperty(schema, "const");
    schema.enum = [constant];
    if (schema.type === undefined) schema.type = inferConstType(constant);
    changed = true;
  }
  if (
    includesObjectType(schema.type) &&
    schema.additionalProperties !== false
  ) {
    schema.additionalProperties = false;
    changed = true;
  }
  const properties = schema.properties;
  if (isSchemaRecord(properties)) {
    const propertyKeys = Object.keys(properties);
    if (!hasExactRequiredKeys(schema.required, propertyKeys)) {
      schema.required = propertyKeys;
      changed = true;
    }
  }

  for (const keyword of CODEX_SCHEMA_MAPS) {
    const map = schema[keyword];
    if (!isSchemaRecord(map)) continue;
    for (const nested of Object.values(map)) {
      if (projectCodexSchema(nested)) changed = true;
    }
  }
  for (const keyword of CODEX_SCHEMA_ARRAYS) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    for (const nested of alternatives) {
      if (projectCodexSchema(nested)) changed = true;
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const nested of items) {
      if (projectCodexSchema(nested)) changed = true;
    }
  } else if (projectCodexSchema(items)) {
    changed = true;
  }

  const dependencies = schema.dependencies;
  if (isSchemaRecord(dependencies)) {
    for (const nested of Object.values(dependencies)) {
      if (!Array.isArray(nested) && projectCodexSchema(nested)) changed = true;
    }
  }
  for (const keyword of CODEX_SCHEMA_VALUES) {
    if (projectCodexSchema(schema[keyword])) changed = true;
  }
  return changed;
}

export function prepareCodexJsonSchema(
  value: unknown,
  options: PrepareCodexJsonSchemaOptions,
): PreparedProviderJsonSchema {
  const providerOptions = { ...options, provider: "codex" as const };
  const prepared = prepareProviderJsonSchema(value, providerOptions);
  const schema = JSON.parse(prepared.packet) as object;
  if (!projectCodexSchema(schema)) return prepared;
  return {
    packet: serializeProviderJson(schema, providerOptions),
    matches: prepared.matches,
  };
}

export interface PrivateJsonFile {
  directory: string;
  path: string;
  dispose(): Promise<void>;
}

export interface PrivateJsonFileOptions {
  basename: string;
  prefix: string;
}

async function ignoreMissing(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

export async function createPrivateJsonFile(
  packet: string,
  options: PrivateJsonFileOptions,
): Promise<PrivateJsonFile> {
  if (
    options.basename.length === 0 ||
    basename(options.basename) !== options.basename
  ) {
    throw new TypeError("basename must be a single nonempty path component");
  }
  if (
    options.prefix.length === 0 ||
    basename(options.prefix) !== options.prefix
  ) {
    throw new TypeError("prefix must be a single nonempty path component");
  }

  await mkdir(tmpdir(), { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), options.prefix));
  const path = join(directory, options.basename);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await ignoreMissing(() => unlink(path));
    await ignoreMissing(() => rmdir(directory));
  };

  try {
    await chmod(directory, 0o700);
    await writeFile(path, packet, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new TypeError("private JSON artifact is not a file");
    return { directory, dispose, path };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
