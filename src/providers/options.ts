import { isAbsolute } from "node:path";
import { isProxy } from "node:util/types";

import { lexicalPath } from "../config/paths.js";
import { validateNormalizedProviderVersion } from "../config/provider-identity.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type { ProviderId, ProviderIdentity } from "../core/types.js";

function configurationError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

export function snapshotAdapterOptions(
  value: unknown,
  provider: ProviderId,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value))
      throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError();

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !allowedKeys.includes(key) ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        throw new TypeError();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    configurationError(`${provider} adapter options must be exact data`);
  }
}

export function snapshotProviderIdentity(
  value: unknown,
  provider: ProviderId,
): ProviderIdentity {
  let snapshot: Record<string, unknown>;
  try {
    const cloned = strictJsonClone(value, `${provider} provider identity`);
    if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned))
      throw new TypeError();
    snapshot = cloned as Record<string, unknown>;
    const keys = Object.keys(snapshot);
    if (
      keys.length !== 3 ||
      !["id", "executableRealpath", "version"].every((key) =>
        Object.hasOwn(snapshot, key),
      ) ||
      typeof snapshot.id !== "string" ||
      typeof snapshot.executableRealpath !== "string" ||
      !snapshot.executableRealpath ||
      snapshot.executableRealpath.includes("\0") ||
      snapshot.executableRealpath.startsWith("//") ||
      snapshot.executableRealpath.startsWith("\\\\") ||
      /^[A-Za-z]:(?:$|[^\\/])/.test(snapshot.executableRealpath) ||
      !isAbsolute(snapshot.executableRealpath) ||
      lexicalPath(snapshot.executableRealpath, "/") !==
        snapshot.executableRealpath ||
      typeof snapshot.version !== "string" ||
      !snapshot.version ||
      snapshot.version.includes("\0")
    )
      throw new TypeError();
  } catch {
    configurationError(`${provider} provider identity must be exact data`);
  }

  if (snapshot.id !== provider) {
    const adapter = provider === "codex" ? "CodexAdapter" : "ClaudeAdapter";
    throw new TypeError(`${adapter} requires a ${provider} provider identity`);
  }
  const version = validateNormalizedProviderVersion(provider, snapshot.version);
  return Object.freeze({
    id: provider,
    executableRealpath: snapshot.executableRealpath as string,
    version,
  });
}
