import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";
import { isProxy, isUint8Array } from "node:util/types";

import { AwslError } from "../core/errors.js";
import type { ProviderId, ProviderIdentity } from "../core/types.js";
import { canonicalCwd, lexicalPath } from "./paths.js";
import { defaultProviderVersionProbe } from "./provider-version-process.js";

export {
  defaultProviderVersionProbe,
  type ProviderVersionProbeRuntime,
} from "./provider-version-process.js";

export const PROVIDER_VERSION_STREAM_LIMIT_BYTES = 64 * 1024;
const SEMVER_CORE =
  "(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})";
const NORMALIZED_PROVIDER_VERSION = new RegExp(`^${SEMVER_CORE}$`, "u");
const CODEX_VERSION_BANNER = new RegExp(`^codex-cli (${SEMVER_CORE})$`, "u");
const CLAUDE_VERSION_BANNER = new RegExp(
  `^(${SEMVER_CORE}) \\(Claude Code\\)$`,
  "u",
);
const VERIFIED_PROVIDER_VERSIONS: Readonly<
  Record<ProviderId, ReadonlySet<string>>
> = Object.freeze({
  codex: new Set(["0.145.0", "0.146.0"]),
  claude: new Set(["2.1.218"]),
});

export type ProviderVersionSupport = "verified" | "unverified";

export interface ProviderVersionProbeInput {
  readonly executableRealpath: string;
  readonly cwd: string;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProviderVersionProbeResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
}

export type ProviderVersionProbe = (
  input: ProviderVersionProbeInput,
) => Promise<ProviderVersionProbeResult>;

export interface ResolveProviderIdentityOptions {
  readonly provider: ProviderId;
  readonly executable: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: ProviderVersionProbe;
}

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function compatibilityError(provider: ProviderId, message: string): never {
  throw new AwslError("COMPATIBILITY_ERROR", message, {
    provider,
    recoverable: false,
  });
}

function snapshotOptions(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value))
      throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set(["provider", "executable", "cwd", "env", "probe"]);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowed.has(key) ||
          !descriptors[key].enumerable ||
          !("value" in descriptors[key]),
      )
    )
      throw new TypeError();
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) snapshot[key] = descriptors[key].value;
    return Object.freeze(snapshot);
  } catch {
    configError("provider identity options must be exact data");
  }
}

function snapshotPath(environment: unknown): string {
  try {
    if (
      environment === null ||
      typeof environment !== "object" ||
      isProxy(environment)
    )
      throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(environment, "PATH");
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      descriptor.value.includes("\0")
    )
      throw new TypeError();
    return descriptor.value;
  } catch {
    configError("provider PATH must be an own nonempty data string");
  }
}

function executableKind(value: unknown): "bare" | "path" {
  if (typeof value !== "string" || !value || value.includes("\0"))
    configError("provider executable is invalid");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return "bare";
  const hasSeparator =
    value.includes("/") ||
    (process.platform === "win32" && value.includes("\\"));
  if (!hasSeparator) configError("provider executable is invalid");
  return "path";
}

async function canonicalExecutable(candidate: string): Promise<string> {
  let physical: string;
  try {
    physical = await realpath(candidate);
    const information = await stat(physical);
    if (!information.isFile()) configError("provider executable is not a file");
    await access(physical, constants.X_OK);
  } catch (error) {
    if (error instanceof AwslError) throw error;
    configError("provider executable is unavailable");
  }
  return physical;
}

function isMissingOrNotDirectoryError(error: unknown): boolean {
  try {
    if (error === null || typeof error !== "object" || isProxy(error))
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      (descriptor.value === "ENOENT" || descriptor.value === "ENOTDIR")
    );
  } catch {
    return false;
  }
}

async function resolveBareExecutable(
  name: string,
  pathValue: string,
): Promise<string> {
  const directories = pathValue.split(delimiter);
  if (directories.length === 0) configError("provider PATH has no directories");

  for (const directory of directories) {
    if (!directory || directory.includes("\0") || !isAbsolute(directory))
      configError("provider PATH contains an invalid directory");
    lexicalPath(directory, "/");
  }

  const searchableDirectories: string[] = [];
  for (const directory of directories) {
    try {
      const information = await stat(directory);
      if (information.isDirectory()) searchableDirectories.push(directory);
    } catch (error) {
      if (isMissingOrNotDirectoryError(error)) continue;
      configError("provider PATH entry is unavailable");
    }
  }

  for (const directory of searchableDirectories) {
    const candidate = join(directory, name);
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissingOrNotDirectoryError(error)) continue;
      configError("provider executable candidate is unavailable");
    }
    return canonicalExecutable(candidate);
  }
  return configError("provider executable was not found");
}

function snapshotProbeResult(value: unknown): ProviderVersionProbeResult {
  try {
    if (value === null || typeof value !== "object" || isProxy(value))
      throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 3 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !["stdout", "stderr", "exitCode"].includes(key) ||
          !descriptors[key].enumerable ||
          !("value" in descriptors[key]),
      )
    )
      throw new TypeError();
    const stdout = descriptors.stdout.value;
    const stderr = descriptors.stderr.value;
    const exitCode = descriptors.exitCode.value;
    if (
      exitCode !== null &&
      (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)
    )
      throw new TypeError();
    return {
      stdout: snapshotProbeBytes(stdout),
      stderr: snapshotProbeBytes(stderr),
      exitCode: exitCode as number | null,
    };
  } catch {
    configError("provider version probe returned invalid data");
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;

function snapshotProbeBytes(value: unknown): Uint8Array {
  if (typedArrayByteLength === undefined) throw new TypeError();
  if (isProxy(value) || !isUint8Array(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (
    isProxy(prototype) ||
    (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
  )
    throw new TypeError();
  const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > PROVIDER_VERSION_STREAM_LIMIT_BYTES
  )
    throw new TypeError();
  const cloned = structuredClone(value);
  if (!isUint8Array(cloned)) throw new TypeError();
  return cloned;
}

function decodeProbeStream(value: Uint8Array): string {
  if (value.byteLength > PROVIDER_VERSION_STREAM_LIMIT_BYTES)
    configError("provider version output exceeds byte limit");
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch {
    configError("provider version output is not valid UTF-8");
  }
}

function asciiEdgeTrim(value: string): string {
  const isEdgeWhitespace = (code: number) =>
    code === 0x20 || (code >= 0x09 && code <= 0x0d);
  let start = 0;
  while (start < value.length && isEdgeWhitespace(value.charCodeAt(start)))
    start += 1;
  let end = value.length;
  while (end > start && isEdgeWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function firstVersionLine(stdout: string): string {
  let versionLine: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = asciiEdgeTrim(line);
    if (trimmed) {
      versionLine = trimmed;
      break;
    }
  }
  if (versionLine === undefined || Buffer.byteLength(versionLine, "utf8") > 256)
    configError("provider version line is malformed");
  if (containsControlCharacter(versionLine))
    configError("provider version line contains control characters");
  return versionLine;
}

export function validateNormalizedProviderVersion(
  provider: ProviderId,
  value: unknown,
): string {
  if (
    (provider === "codex" || provider === "claude") &&
    typeof value === "string" &&
    NORMALIZED_PROVIDER_VERSION.test(value)
  )
    return value;
  return compatibilityError(provider, "provider version is incompatible");
}

export function providerVersionSupport(
  provider: ProviderId,
  version: string,
): ProviderVersionSupport {
  const normalized = validateNormalizedProviderVersion(provider, version);
  return VERIFIED_PROVIDER_VERSIONS[provider].has(normalized)
    ? "verified"
    : "unverified";
}

export function normalizeProviderVersionBanner(
  provider: ProviderId,
  value: string,
): string {
  const match =
    provider === "codex"
      ? CODEX_VERSION_BANNER.exec(value)
      : CLAUDE_VERSION_BANNER.exec(value);
  if (match?.[1] !== undefined)
    return validateNormalizedProviderVersion(provider, match[1]);
  return compatibilityError(provider, "provider version is incompatible");
}

export async function resolveProviderIdentity(
  options: ResolveProviderIdentityOptions,
): Promise<ProviderIdentity> {
  const captured = snapshotOptions(options);
  const provider = captured.provider;
  if (provider !== "codex" && provider !== "claude")
    configError("provider identity provider is invalid");
  const executable = captured.executable;
  const kind = executableKind(executable);
  if (typeof captured.cwd !== "string")
    configError("provider identity cwd is invalid");
  const cwdInput = captured.cwd;
  const configuredProbe = captured.probe;
  if (
    configuredProbe !== undefined &&
    (typeof configuredProbe !== "function" || isProxy(configuredProbe))
  )
    configError("provider version probe is unavailable");
  const pathValue =
    kind === "bare" ? snapshotPath(captured.env ?? process.env) : undefined;

  const cwd = await canonicalCwd(cwdInput);
  const executableRealpath =
    kind === "bare"
      ? await resolveBareExecutable(executable as string, pathValue as string)
      : await canonicalExecutable(lexicalPath(executable as string, cwd));
  let rawResult: unknown;
  try {
    const input = Object.freeze({
      executableRealpath,
      cwd,
      maxStdoutBytes: PROVIDER_VERSION_STREAM_LIMIT_BYTES,
      maxStderrBytes: PROVIDER_VERSION_STREAM_LIMIT_BYTES,
    });
    rawResult =
      configuredProbe === undefined
        ? await defaultProviderVersionProbe({
            ...input,
            env: (captured.env ?? process.env) as NodeJS.ProcessEnv,
          })
        : await (configuredProbe as ProviderVersionProbe)(input);
  } catch {
    configError("provider version probe failed");
  }
  const result = snapshotProbeResult(rawResult);
  const stdout = decodeProbeStream(result.stdout);
  decodeProbeStream(result.stderr);
  if (result.exitCode !== 0)
    configError("provider version probe exited unsuccessfully");
  const version = normalizeProviderVersionBanner(
    provider,
    firstVersionLine(stdout),
  );
  return Object.freeze({ id: provider, executableRealpath, version });
}
