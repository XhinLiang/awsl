import { isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";

import { type CompiledWorkflow, compileWorkflow } from "../compat/compile.js";
import { AwslError } from "../core/errors.js";
import {
  type ReadSnapshot,
  canonicalCwd,
  lexicalPath,
  readRegularUtf8,
} from "./paths.js";

export interface ResolvedWorkflowSource extends ReadSnapshot, CompiledWorkflow {
  readonly reference: string;
}

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function exactChildPath(value: unknown): string {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value))
    return configError("child workflow must be an exact data object");
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return configError("child workflow must be an exact data object");
    if (
      Reflect.ownKeys(value).length !== 1 ||
      !Object.hasOwn(value, "scriptPath")
    )
      return configError("child workflow must be an exact data object");
    const descriptor = Object.getOwnPropertyDescriptor(value, "scriptPath");
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    )
      return configError("child workflow must be an exact data object");
    return descriptor.value;
  } catch {
    return configError("child workflow must be an exact data object");
  }
}

function frozenResolved(
  reference: string,
  snapshot: ReadSnapshot,
): ResolvedWorkflowSource {
  const compiled = compileWorkflow(snapshot.source, snapshot.realpath);
  const bytes = new Uint8Array(snapshot.bytes);
  for (const phase of compiled.meta.phases ?? []) Object.freeze(phase);
  Object.freeze(compiled.meta.phases);
  Object.freeze(compiled.meta);
  Object.freeze(compiled);
  const result = {
    reference,
    realpath: snapshot.realpath,
    source: snapshot.source,
    sha256: snapshot.sha256,
    ...compiled,
  };
  Object.defineProperty(result, "bytes", {
    enumerable: true,
    get: () => new Uint8Array(bytes),
  });
  return Object.freeze(result) as ResolvedWorkflowSource;
}

async function resolve(
  reference: string,
  cwd: string,
): Promise<ResolvedWorkflowSource> {
  const canonical = await canonicalCwd(cwd);
  return frozenResolved(reference, await readRegularUtf8(reference, canonical));
}

function capturedCwd(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value))
    return configError("canonical session cwd must be an absolute path");
  try {
    lexicalPath(value, "/");
    return value;
  } catch {
    return configError("canonical session cwd must be an absolute path");
  }
}

export async function resolveRootWorkflow(
  reference: string,
  canonicalSessionCwd: string,
): Promise<ResolvedWorkflowSource> {
  if (typeof reference !== "string")
    configError("workflow reference must be a string");
  const cwd = capturedCwd(canonicalSessionCwd);
  return resolve(reference, cwd);
}

export async function resolveChildWorkflow(
  reference: { scriptPath: string },
  canonicalSessionCwd: string,
): Promise<ResolvedWorkflowSource> {
  const scriptPath = exactChildPath(reference);
  const cwd = capturedCwd(canonicalSessionCwd);
  return resolve(scriptPath, cwd);
}
