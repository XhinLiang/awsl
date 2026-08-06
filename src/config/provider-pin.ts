import { isAbsolute } from "node:path";
import { isProxy } from "node:util/types";

import {
  LEGACY_COMPATIBILITY_PROFILE,
  WORKFLOW_ABI,
} from "../compat/profile.js";
import { AwslError } from "../core/errors.js";
import type { ProviderId, ProviderIdentity } from "../core/types.js";
import {
  awslBehaviorFingerprint,
  modelMapFingerprint,
} from "./fingerprints.js";
import { isNativeModel, validateCodexProfile } from "./model-map.js";
import { nativeRoutingFingerprint } from "./native-routing.js";
import { lexicalPath } from "./paths.js";
import { validateNormalizedProviderVersion } from "./provider-identity.js";
import type { ResolvedAwslConfig, ResolvedModel } from "./types.js";

export type Sha256Digest = `sha256:${string}`;

export type RunSourceIdentityV1 =
  | {
      readonly kind: "config-path" | "workflow-path" | "workflow-registry";
      readonly reference: string;
      readonly realpath: string;
    }
  | {
      readonly kind: "agent-registry";
      readonly reference: string;
      readonly realpath: string;
      readonly sha256: Sha256Digest;
    }
  | {
      readonly kind: "plugin-manifest";
      readonly reference: string;
      readonly pluginRootRealpath: string;
      readonly realpath: string;
      readonly sha256: Sha256Digest;
    }
  | {
      readonly kind: "builtin-agent";
      readonly reference: "workflow-subagent";
      readonly realpath: null;
      readonly sha256: Sha256Digest;
    };

interface ProviderPinCommon {
  readonly provider: ProviderId;
  readonly compatibilityProfile:
    | typeof WORKFLOW_ABI.id
    | typeof LEGACY_COMPATIBILITY_PROFILE.id;
  readonly executableRealpath: string;
  readonly executableVersion: string;
  readonly explicitDefaultModel: string | null;
  readonly resolvedDefaultModel: string | null;
  readonly providerProfile: string | null;
  readonly canonicalCwd: string;
  readonly sources: readonly RunSourceIdentityV1[];
  readonly awslBehaviorFingerprint: Sha256Digest;
  readonly modelMapFingerprint: Sha256Digest;
  readonly nativeRoutingFingerprint: Sha256Digest;
}

export interface ProviderPinV1 extends ProviderPinCommon {
  readonly version: 1;
}

export interface ProviderPinV2 extends ProviderPinCommon {
  readonly version: 2;
  readonly configuredNativeModels: readonly string[];
}

export type ProviderPin = ProviderPinV1 | ProviderPinV2;

export interface CreateProviderPinInput {
  readonly identity: ProviderIdentity;
  readonly config: ResolvedAwslConfig;
  readonly canonicalCwd: string;
  readonly sources: readonly RunSourceIdentityV1[];
  readonly enabledPluginRoots: readonly string[];
  readonly homeDir: string;
  readonly env: unknown;
}

export interface DefaultModelObservation {
  readonly modelSource: ResolvedModel["modelSource"];
  readonly resolvedModel?: string;
}

export interface ProviderPinTransition {
  readonly pin: ProviderPin;
  readonly changed: boolean;
}

const PIN_V1_KEYS = Object.freeze([
  "version",
  "provider",
  "compatibilityProfile",
  "executableRealpath",
  "executableVersion",
  "explicitDefaultModel",
  "resolvedDefaultModel",
  "providerProfile",
  "canonicalCwd",
  "sources",
  "awslBehaviorFingerprint",
  "modelMapFingerprint",
  "nativeRoutingFingerprint",
]);
const PIN_V2_KEYS = Object.freeze([...PIN_V1_KEYS, "configuredNativeModels"]);

const CREATE_PIN_KEYS = Object.freeze([
  "identity",
  "config",
  "canonicalCwd",
  "sources",
  "enabledPluginRoots",
  "homeDir",
  "env",
]);

const IDENTITY_KEYS = Object.freeze(["id", "executableRealpath", "version"]);

const PATH_SOURCE_KEYS = Object.freeze(["kind", "reference", "realpath"]);
const AGENT_SOURCE_KEYS = Object.freeze([
  "kind",
  "reference",
  "realpath",
  "sha256",
]);
const PLUGIN_SOURCE_KEYS = Object.freeze([
  "kind",
  "reference",
  "pluginRootRealpath",
  "realpath",
  "sha256",
]);
const BUILTIN_SOURCE_KEYS = Object.freeze([
  "kind",
  "reference",
  "realpath",
  "sha256",
]);

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function compatibilityError(provider: ProviderId, message: string): never {
  throw new AwslError("COMPATIBILITY_ERROR", message, {
    provider,
    recoverable: false,
  });
}

function isNativeConstructor(
  value: unknown,
  name: "Array" | "Object",
): value is (...args: never[]) => unknown {
  if (typeof value !== "function" || isProxy(value)) return false;
  try {
    return (
      Reflect.apply(Function.prototype.toString, value, []) ===
      `function ${name}() { [native code] }`
    );
  } catch {
    return false;
  }
}

function isIntrinsicPrototype(
  value: object,
  name: "Array" | "Object",
): boolean {
  if (isProxy(value)) return false;
  try {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "constructor",
    );
    if (
      constructorDescriptor === undefined ||
      !("value" in constructorDescriptor) ||
      !isNativeConstructor(constructorDescriptor.value, name)
    )
      return false;
    const constructorPrototype = Object.getOwnPropertyDescriptor(
      constructorDescriptor.value,
      "prototype",
    );
    if (
      constructorPrototype === undefined ||
      !("value" in constructorPrototype) ||
      constructorPrototype.value !== value
    )
      return false;
    const parent = Object.getPrototypeOf(value);
    return name === "Object"
      ? parent === null
      : parent !== null && isIntrinsicPrototype(parent, "Object");
  } catch {
    return false;
  }
}

function exactDataClone(
  value: unknown,
  seen: WeakSet<object>,
  rejectAliases: boolean,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError();
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) throw new TypeError();
  if (seen.has(value)) throw new TypeError();
  seen.add(value);

  try {
    const prototype = Object.getPrototypeOf(value);
    if (isProxy(prototype)) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError();

    if (Array.isArray(value)) {
      if (prototype === null || !isIntrinsicPrototype(prototype, "Array"))
        throw new TypeError();
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      )
        throw new TypeError();
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1) throw new TypeError();
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        )
          throw new TypeError();
        result.push(exactDataClone(descriptor.value, seen, rejectAliases));
      }
      return result;
    }

    if (prototype !== null && !isIntrinsicPrototype(prototype, "Object"))
      throw new TypeError();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        throw new TypeError();
      result[key] = exactDataClone(descriptor.value, seen, rejectAliases);
    }
    return result;
  } finally {
    if (!rejectAliases) seen.delete(value);
  }
}

function snapshotExactData(value: unknown): unknown {
  try {
    return exactDataClone(value, new WeakSet(), true);
  } catch {
    configError("provider pin must be exact data");
  }
}

function snapshotBuilderData(value: unknown): unknown {
  try {
    return exactDataClone(value, new WeakSet(), false);
  } catch {
    configError("provider pin input must be exact data");
  }
}

function snapshotShallowRecord(
  value: unknown,
  expected: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value))
      throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && !isIntrinsicPrototype(prototype, "Object"))
      throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !expected.includes(key) ||
          descriptors[key].enumerable !== true ||
          !("value" in descriptors[key]),
      )
    )
      throw new TypeError();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) result[key] = descriptors[key].value;
    return Object.freeze(result);
  } catch {
    configError(`${label} must be exact data`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    configError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    configError(`${label} has invalid keys`);
}

function validScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !validScalarString(value)
  )
    configError(`${label} is invalid`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function sha256(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
    configError(`${label} is invalid`);
  return value as Sha256Digest;
}

function absoluteLexicalPath(value: unknown, label: string): string {
  const path = text(value, label);
  try {
    if (!isAbsolute(path) || lexicalPath(path, "/") !== path)
      throw new TypeError();
  } catch {
    configError(`${label} is invalid`);
  }
  return path;
}

function parseSource(value: unknown): RunSourceIdentityV1 {
  const source = record(value, "provider pin source");
  const kind = source.kind;
  if (
    kind === "config-path" ||
    kind === "workflow-path" ||
    kind === "workflow-registry"
  ) {
    exactKeys(source, PATH_SOURCE_KEYS, "provider pin source");
    return Object.freeze({
      kind,
      reference: text(source.reference, "provider pin source reference"),
      realpath: absoluteLexicalPath(
        source.realpath,
        "provider pin source realpath",
      ),
    });
  }
  if (kind === "agent-registry") {
    exactKeys(source, AGENT_SOURCE_KEYS, "provider pin source");
    return Object.freeze({
      kind,
      reference: text(source.reference, "provider pin source reference"),
      realpath: absoluteLexicalPath(
        source.realpath,
        "provider pin source realpath",
      ),
      sha256: sha256(source.sha256, "provider pin source hash"),
    });
  }
  if (kind === "plugin-manifest") {
    exactKeys(source, PLUGIN_SOURCE_KEYS, "provider pin source");
    return Object.freeze({
      kind,
      reference: text(source.reference, "provider pin source reference"),
      pluginRootRealpath: absoluteLexicalPath(
        source.pluginRootRealpath,
        "provider pin plugin root",
      ),
      realpath: absoluteLexicalPath(
        source.realpath,
        "provider pin source realpath",
      ),
      sha256: sha256(source.sha256, "provider pin source hash"),
    });
  }
  if (kind === "builtin-agent") {
    exactKeys(source, BUILTIN_SOURCE_KEYS, "provider pin source");
    if (source.reference !== "workflow-subagent" || source.realpath !== null)
      configError("provider pin builtin source is invalid");
    return Object.freeze({
      kind,
      reference: "workflow-subagent",
      realpath: null,
      sha256: sha256(source.sha256, "provider pin source hash"),
    });
  }
  return configError("provider pin source kind is invalid");
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sourceCompare(
  left: RunSourceIdentityV1,
  right: RunSourceIdentityV1,
): number {
  const kind = utf8Compare(left.kind, right.kind);
  if (kind !== 0) return kind;
  const reference = utf8Compare(left.reference, right.reference);
  if (reference !== 0) return reference;
  return utf8Compare(left.realpath ?? "", right.realpath ?? "");
}

function parseSources(value: unknown): readonly RunSourceIdentityV1[] {
  if (!Array.isArray(value)) configError("provider pin sources are invalid");
  const parsed = value.map(parseSource);
  const seen = new Map<string, Set<string>>();
  for (let index = 0; index < parsed.length; index += 1) {
    const source = parsed[index] as RunSourceIdentityV1;
    const references = seen.get(source.kind) ?? new Set<string>();
    if (references.has(source.reference))
      configError("provider pin sources contain a duplicate");
    references.add(source.reference);
    seen.set(source.kind, references);
    if (
      index > 0 &&
      sourceCompare(parsed[index - 1] as RunSourceIdentityV1, source) > 0
    )
      configError("provider pin sources are not sorted");
  }
  return Object.freeze(parsed);
}

function providerVersion(provider: ProviderId, value: unknown): string {
  try {
    return validateNormalizedProviderVersion(provider, value);
  } catch {
    configError("provider pin executableVersion is invalid");
  }
}

function compatibilityProfile(
  value: unknown,
): ProviderPinCommon["compatibilityProfile"] {
  if (value !== WORKFLOW_ABI.id && value !== LEGACY_COMPATIBILITY_PROFILE.id)
    configError("provider pin compatibilityProfile is invalid");
  return value;
}

function providerProfile(provider: ProviderId, value: unknown): string | null {
  if (value === null) return null;
  if (provider !== "codex")
    configError("provider pin providerProfile is invalid");
  try {
    return validateCodexProfile(value);
  } catch {
    configError("provider pin providerProfile is invalid");
  }
}

function cloneSource(source: RunSourceIdentityV1): RunSourceIdentityV1 {
  switch (source.kind) {
    case "config-path":
    case "workflow-path":
    case "workflow-registry":
      return Object.freeze({
        kind: source.kind,
        reference: source.reference,
        realpath: source.realpath,
      });
    case "agent-registry":
      return Object.freeze({
        kind: source.kind,
        reference: source.reference,
        realpath: source.realpath,
        sha256: source.sha256,
      });
    case "plugin-manifest":
      return Object.freeze({
        kind: source.kind,
        reference: source.reference,
        pluginRootRealpath: source.pluginRootRealpath,
        realpath: source.realpath,
        sha256: source.sha256,
      });
    case "builtin-agent":
      return Object.freeze({
        kind: source.kind,
        reference: source.reference,
        realpath: null,
        sha256: source.sha256,
      });
  }
}

function configuredNativeModels(value: unknown): readonly string[] {
  if (!Array.isArray(value))
    configError("provider pin configuredNativeModels are invalid");
  const models = value.map((entry) =>
    text(entry, "provider pin configured native model"),
  );
  for (let index = 0; index < models.length; index += 1) {
    if (
      index > 0 &&
      utf8Compare(models[index - 1] as string, models[index] as string) >= 0
    )
      configError(
        models[index - 1] === models[index]
          ? "provider pin configuredNativeModels contain a duplicate"
          : "provider pin configuredNativeModels are not sorted",
      );
  }
  return Object.freeze(models);
}

function freezePin<T extends ProviderPin>(value: T): T {
  const sources = Object.freeze(value.sources.map(cloneSource));
  return Object.freeze(
    value.version === 2
      ? {
          ...value,
          sources,
          configuredNativeModels: Object.freeze([
            ...value.configuredNativeModels,
          ]),
        }
      : { ...value, sources },
  ) as unknown as T;
}

function parsePinCommon(
  input: Record<string, unknown>,
  configured: readonly string[],
): ProviderPinCommon {
  const provider = input.provider;
  if (provider !== "codex" && provider !== "claude")
    configError("provider pin provider is invalid");
  const parsedCompatibilityProfile = compatibilityProfile(
    input.compatibilityProfile,
  );

  const explicitDefaultModel = nullableText(
    input.explicitDefaultModel,
    "provider pin explicitDefaultModel",
  );
  const resolvedDefaultModel = nullableText(
    input.resolvedDefaultModel,
    "provider pin resolvedDefaultModel",
  );
  if (
    explicitDefaultModel !== null &&
    resolvedDefaultModel !== explicitDefaultModel
  )
    configError("provider pin default model relationship is invalid");
  if (
    explicitDefaultModel === null &&
    resolvedDefaultModel !== null &&
    !isNativeModel(provider, resolvedDefaultModel, configured)
  )
    configError("provider pin discovered default model is invalid");

  return {
    provider,
    compatibilityProfile: parsedCompatibilityProfile,
    executableRealpath: absoluteLexicalPath(
      input.executableRealpath,
      "provider pin executableRealpath",
    ),
    executableVersion: providerVersion(provider, input.executableVersion),
    explicitDefaultModel,
    resolvedDefaultModel,
    providerProfile: providerProfile(provider, input.providerProfile),
    canonicalCwd: absoluteLexicalPath(
      input.canonicalCwd,
      "provider pin canonicalCwd",
    ),
    sources: parseSources(input.sources),
    awslBehaviorFingerprint: sha256(
      input.awslBehaviorFingerprint,
      "provider pin awslBehaviorFingerprint",
    ),
    modelMapFingerprint: sha256(
      input.modelMapFingerprint,
      "provider pin modelMapFingerprint",
    ),
    nativeRoutingFingerprint: sha256(
      input.nativeRoutingFingerprint,
      "provider pin nativeRoutingFingerprint",
    ),
  };
}

export function parseProviderPinV1(value: unknown): ProviderPinV1 {
  const input = record(snapshotExactData(value), "provider pin");
  exactKeys(input, PIN_V1_KEYS, "provider pin");
  if (input.version !== 1) configError("provider pin version is invalid");
  return freezePin({
    version: 1,
    ...parsePinCommon(input, []),
  });
}

export function parseProviderPinV2(value: unknown): ProviderPinV2 {
  const input = record(snapshotExactData(value), "provider pin");
  exactKeys(input, PIN_V2_KEYS, "provider pin");
  if (input.version !== 2) configError("provider pin version is invalid");
  const configured = configuredNativeModels(input.configuredNativeModels);
  return freezePin({
    version: 2,
    ...parsePinCommon(input, configured),
    configuredNativeModels: configured,
  });
}

export function parseProviderPin(value: unknown): ProviderPin {
  const input = record(snapshotExactData(value), "provider pin");
  if (input.version === 1) return parseProviderPinV1(input);
  if (input.version === 2) return parseProviderPinV2(input);
  return configError("provider pin version is invalid");
}

function sourceEquals(
  left: RunSourceIdentityV1,
  right: RunSourceIdentityV1,
): boolean {
  if (
    left.kind !== right.kind ||
    left.reference !== right.reference ||
    left.realpath !== right.realpath
  )
    return false;
  switch (left.kind) {
    case "config-path":
    case "workflow-path":
    case "workflow-registry":
      return true;
    case "agent-registry":
    case "builtin-agent":
      return left.sha256 === (right as typeof left).sha256;
    case "plugin-manifest":
      return (
        left.pluginRootRealpath === (right as typeof left).pluginRootRealpath &&
        left.sha256 === (right as typeof left).sha256
      );
  }
}

function sourcesEqual(
  left: readonly RunSourceIdentityV1[],
  right: readonly RunSourceIdentityV1[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        right[index] !== undefined &&
        sourceEquals(source, right[index] as RunSourceIdentityV1),
    )
  );
}

function normalizedSources(value: unknown): readonly RunSourceIdentityV1[] {
  if (!Array.isArray(value)) configError("provider pin sources are invalid");
  const sorted = value.map(parseSource).sort(sourceCompare);
  const result: RunSourceIdentityV1[] = [];
  for (const source of sorted) {
    const previous = result.at(-1);
    if (
      previous?.kind === source.kind &&
      previous.reference === source.reference
    ) {
      if (!sourceEquals(previous, source))
        configError("provider pin source identity drift");
      continue;
    }
    result.push(source);
  }
  return Object.freeze(result);
}

export async function createProviderPin(
  value: CreateProviderPinInput,
): Promise<ProviderPinV2> {
  const input = snapshotShallowRecord(
    value,
    CREATE_PIN_KEYS,
    "provider pin input",
  );
  const identity = record(
    snapshotExactData(input.identity),
    "provider pin identity",
  );
  exactKeys(identity, IDENTITY_KEYS, "provider pin identity");

  const behaviorFingerprint = awslBehaviorFingerprint({
    config: input.config as ResolvedAwslConfig,
    enabledPluginRoots: input.enabledPluginRoots as readonly string[],
  });
  const config = snapshotBuilderData(input.config) as ResolvedAwslConfig;
  const selectedModelMapFingerprint = modelMapFingerprint(config);
  const sources = normalizedSources(snapshotBuilderData(input.sources));
  if (identity.id !== config.provider)
    configError("provider pin identity does not match selected provider");

  const selected = config.providers[config.provider];
  const routingFingerprint = await nativeRoutingFingerprint({
    provider: config.provider,
    providerVersion: identity.version as string,
    canonicalCwd: input.canonicalCwd as string,
    homeDir: input.homeDir as string,
    env: input.env,
    safeArgs: selected.args,
    ...(config.provider === "codex" &&
    config.providers.codex.profile !== undefined
      ? { profile: config.providers.codex.profile }
      : {}),
  });

  const explicitDefaultModel = selected.defaultModel ?? null;
  const providerProfile =
    config.provider === "codex"
      ? (config.providers.codex.profile ?? null)
      : null;
  return parseProviderPinV2({
    version: 2,
    provider: config.provider,
    compatibilityProfile: WORKFLOW_ABI.id,
    executableRealpath: identity.executableRealpath,
    executableVersion: identity.version,
    explicitDefaultModel,
    resolvedDefaultModel: explicitDefaultModel,
    providerProfile,
    canonicalCwd: input.canonicalCwd,
    sources,
    awslBehaviorFingerprint: behaviorFingerprint,
    modelMapFingerprint: selectedModelMapFingerprint,
    nativeRoutingFingerprint: routingFingerprint,
    configuredNativeModels: [...selected.nativeModels].sort(utf8Compare),
  });
}

function observationSource(value: unknown, provider: ProviderId): string {
  if (typeof value !== "string")
    compatibilityError(provider, "default model observation is invalid");
  if (
    value === "implicit" ||
    value === "native" ||
    value === "configured-default" ||
    value === "tier:fast" ||
    value === "tier:balanced" ||
    value === "tier:strong"
  )
    return value;
  if (
    value.startsWith("exact:") &&
    value.length > "exact:".length &&
    !value.includes("\0") &&
    validScalarString(value)
  )
    return value;
  return compatibilityError(provider, "default model observation is invalid");
}

function observationField(
  value: unknown,
  key: "modelSource" | "resolvedModel",
  provider: ProviderId,
):
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown } {
  if (value === null || typeof value !== "object" || isProxy(value))
    compatibilityError(provider, "default model observation is invalid");
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return compatibilityError(provider, "default model observation is invalid");
  }
  if (descriptor === undefined) return { present: false };
  if (
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  )
    compatibilityError(provider, "default model observation is invalid");
  return { present: true, value: descriptor.value };
}

/**
 * Computes one immutable default-model transition. The runtime must call this
 * inside its serialized run-snapshot update and publish `pin` only after the
 * updated snapshot is durable.
 */
export function transitionImplicitDefaultModel(
  current: unknown,
  observation: DefaultModelObservation,
): ProviderPinTransition {
  const pin = parseProviderPin(current);
  const source = observationField(observation, "modelSource", pin.provider);
  if (!source.present)
    compatibilityError(pin.provider, "default model observation is invalid");
  if (observationSource(source.value, pin.provider) !== "implicit")
    return Object.freeze({ pin, changed: false });
  if (pin.explicitDefaultModel !== null)
    return Object.freeze({ pin, changed: false });

  const model = observationField(observation, "resolvedModel", pin.provider);
  if (!model.present || model.value === undefined)
    return Object.freeze({ pin, changed: false });
  if (
    typeof model.value !== "string" ||
    model.value.length === 0 ||
    model.value.includes("\0") ||
    !validScalarString(model.value) ||
    !isNativeModel(
      pin.provider,
      model.value,
      pin.version === 2 ? pin.configuredNativeModels : [],
    )
  )
    compatibilityError(pin.provider, "observed provider default is invalid");

  if (pin.resolvedDefaultModel === model.value)
    return Object.freeze({ pin, changed: false });
  if (pin.resolvedDefaultModel !== null)
    compatibilityError(pin.provider, "provider default observation conflict");
  return Object.freeze({
    pin: freezePin({
      ...pin,
      resolvedDefaultModel: model.value,
    }),
    changed: true,
  });
}

/**
 * Computes one immutable source-registry transition. The runtime must invoke
 * this from the same serialized run-snapshot update used for default-model
 * transitions and publish the returned pin only after the snapshot is durable.
 */
export function transitionProviderPinSources(
  current: unknown,
  additions: readonly RunSourceIdentityV1[],
): ProviderPinTransition {
  const pin = parseProviderPin(current);
  const captured = snapshotBuilderData(additions);
  if (!Array.isArray(captured))
    configError("provider pin source additions are invalid");
  const sources = normalizedSources([...pin.sources, ...captured]);
  if (sourcesEqual(pin.sources, sources))
    return Object.freeze({ pin, changed: false });
  return Object.freeze({
    pin: freezePin({ ...pin, sources }),
    changed: true,
  });
}

/** Returns a discovered model only for a call that remains centrally implicit. */
export function resolvedDefaultForImplicitCall(
  current: unknown,
  modelSource: ResolvedModel["modelSource"],
): string | undefined {
  const pin = parseProviderPin(current);
  return modelSource === "implicit"
    ? (pin.resolvedDefaultModel ?? undefined)
    : undefined;
}

export function verifyAndHydrateResumePin(
  stored: unknown,
  currentStatic: unknown,
): ProviderPin {
  const storedPin = parseProviderPin(stored);
  const currentPin = parseProviderPin(currentStatic);
  if (storedPin.version === 2 && currentPin.version === 1)
    configError("provider pin mismatch: version");
  const comparisons: readonly (readonly [field: string, equal: boolean])[] = [
    ["provider", storedPin.provider === currentPin.provider],
    [
      "compatibilityProfile",
      storedPin.compatibilityProfile === currentPin.compatibilityProfile ||
        (storedPin.compatibilityProfile === LEGACY_COMPATIBILITY_PROFILE.id &&
          currentPin.compatibilityProfile === WORKFLOW_ABI.id),
    ],
    [
      "executableRealpath",
      storedPin.executableRealpath === currentPin.executableRealpath,
    ],
    [
      "executableVersion",
      storedPin.executableVersion === currentPin.executableVersion,
    ],
    [
      "explicitDefaultModel",
      storedPin.explicitDefaultModel === currentPin.explicitDefaultModel,
    ],
    [
      "providerProfile",
      storedPin.providerProfile === currentPin.providerProfile,
    ],
    ["canonicalCwd", storedPin.canonicalCwd === currentPin.canonicalCwd],
    ["sources", sourcesEqual(storedPin.sources, currentPin.sources)],
    [
      "awslBehaviorFingerprint",
      storedPin.awslBehaviorFingerprint === currentPin.awslBehaviorFingerprint,
    ],
    [
      "modelMapFingerprint",
      storedPin.modelMapFingerprint === currentPin.modelMapFingerprint,
    ],
    [
      "nativeRoutingFingerprint",
      storedPin.nativeRoutingFingerprint ===
        currentPin.nativeRoutingFingerprint,
    ],
    [
      "configuredNativeModels",
      storedPin.version === 1 ||
        (currentPin.version === 2 &&
          storedPin.configuredNativeModels.length ===
            currentPin.configuredNativeModels.length &&
          storedPin.configuredNativeModels.every(
            (model, index) =>
              model === currentPin.configuredNativeModels[index],
          )),
    ],
  ];
  for (const [field, equal] of comparisons)
    if (!equal) configError(`provider pin mismatch: ${field}`);

  return freezePin({
    ...currentPin,
    resolvedDefaultModel: storedPin.resolvedDefaultModel,
  });
}
