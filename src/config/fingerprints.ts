import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { WORKFLOW_SUBAGENT_SOURCE } from "../compat/builtins/workflow-subagent.js";
import { LEGACY_COMPATIBILITY_PROFILE } from "../compat/profile.js";
import {
  canonicalJson,
  isUnicodeScalarString,
} from "../core/canonical-json.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type { AgentEffort, ProviderId } from "../core/types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  BUILTIN_MODEL_ALIASES,
  isNativeModel,
  validateCodexProfile,
  validateProviderArgs,
} from "./model-map.js";
import { lexicalPath } from "./paths.js";
import type {
  ClaudeProviderConfig,
  CodexProviderConfig,
  ModelTarget,
  ProviderConfig,
  ResolvedAwslConfig,
  TierName,
} from "./types.js";

export interface AwslBehaviorFingerprintInput {
  readonly config: ResolvedAwslConfig;
  readonly enabledPluginRoots?: readonly string[];
}

const REGISTRY_FINGERPRINT_RULES = Object.freeze({
  version: 1,
  unqualifiedPrecedence: Object.freeze(["project", "user", "builtin"]),
  workflowExtension: ".js",
  agentExtension: ".md",
  pluginWorkflowDirectory: "workflows",
  pluginAgentDirectory: "agents",
  pluginNamespaceSeparator: ":",
  configuredRootsBeforeEnabledRoots: true,
  deduplicateByCanonicalRoot: true,
});

const EFFORTS = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const TIERS = Object.freeze<TierName[]>(["fast", "balanced", "strong"]);
const TOP_KEYS = Object.freeze([
  "provider",
  "stateDir",
  "rawProviderEvents",
  "providers",
  "registry",
]);
const BASE_PROVIDER_KEYS = Object.freeze([
  "id",
  "executable",
  "args",
  "nativeModels",
  "tiers",
  "models",
]);

function configError(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}

function snapshot(value: unknown, label: string): unknown {
  try {
    return strictJsonClone(value, label);
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
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  )
    configError(`${label} has invalid keys`);
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isUnicodeScalarString(value)
  )
    configError(`${label} is invalid`);
  return value;
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

function stringArray(
  value: unknown,
  label: string,
  unique: boolean,
): readonly string[] {
  if (!Array.isArray(value)) configError(`${label} is invalid`);
  const result = value.map((entry) => text(entry, `${label} entry`));
  if (unique && new Set(result).size !== result.length)
    configError(`${label} contains a duplicate`);
  return Object.freeze(result);
}

function target(value: unknown, label: string): ModelTarget {
  const input = record(value, label);
  exactKeys(input, ["model", "effort"], [], label);
  const model = text(input.model, `${label} model`);
  if (!EFFORTS.has(input.effort as AgentEffort))
    configError(`${label} effort is invalid`);
  return Object.freeze({
    model,
    effort: input.effort as AgentEffort,
  });
}

function tiers(
  value: unknown,
  label: string,
): Readonly<Record<TierName, ModelTarget>> {
  const input = record(value, label);
  exactKeys(input, TIERS, [], label);
  return Object.freeze(
    Object.fromEntries(
      TIERS.map((tier) => [tier, target(input[tier], `${label} ${tier}`)]),
    ) as Record<TierName, ModelTarget>,
  );
}

function modelTargets(
  value: unknown,
  label: string,
): Readonly<Record<string, ModelTarget>> {
  const input = record(value, label);
  const result = Object.create(null) as Record<string, ModelTarget>;
  for (const key of Object.keys(input)) {
    text(key, `${label} key`);
    result[key] = target(input[key], `${label} target`);
  }
  return Object.freeze(result);
}

function providerConfig(value: unknown, id: "codex"): CodexProviderConfig;
function providerConfig(value: unknown, id: "claude"): ClaudeProviderConfig;
function providerConfig(value: unknown, id: ProviderId): ProviderConfig {
  const label = `${id} resolved provider config`;
  const input = record(value, label);
  exactKeys(
    input,
    BASE_PROVIDER_KEYS,
    id === "codex" ? ["defaultModel", "profile"] : ["defaultModel"],
    label,
  );
  if (input.id !== id) configError(`${label} id is invalid`);
  const executable = text(input.executable, `${label} executable`);
  const args = stringArray(input.args, `${label} args`, false);
  try {
    validateProviderArgs(id, args);
  } catch {
    configError(`${label} args are invalid`);
  }
  const nativeModels = stringArray(
    input.nativeModels,
    `${label} nativeModels`,
    true,
  );
  const resolvedTiers = tiers(input.tiers, `${label} tiers`);
  const models = modelTargets(input.models, `${label} models`);
  const defaultModel = Object.hasOwn(input, "defaultModel")
    ? text(input.defaultModel, `${label} defaultModel`)
    : undefined;

  for (const modelTarget of [
    ...Object.values(resolvedTiers),
    ...Object.values(models),
    ...(defaultModel === undefined ? [] : [{ model: defaultModel }]),
  ])
    if (!isNativeModel(id, modelTarget.model, nativeModels))
      configError(`${label} has a non-native target`);

  if (id === "codex") {
    let profile: string | undefined;
    if (Object.hasOwn(input, "profile")) {
      try {
        profile = validateCodexProfile(input.profile);
      } catch {
        configError(`${label} profile is invalid`);
      }
    }
    return Object.freeze({
      id,
      executable,
      args,
      nativeModels,
      tiers: resolvedTiers,
      models,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      ...(profile === undefined ? {} : { profile }),
    });
  }
  return Object.freeze({
    id,
    executable,
    args,
    nativeModels,
    tiers: resolvedTiers,
    models,
    ...(defaultModel === undefined ? {} : { defaultModel }),
  });
}

function resolvedConfig(value: unknown): ResolvedAwslConfig {
  const input = record(
    snapshot(value, "resolved awsl config"),
    "resolved awsl config",
  );
  exactKeys(input, TOP_KEYS, [], "resolved awsl config");
  if (input.provider !== "codex" && input.provider !== "claude")
    configError("resolved awsl provider is invalid");
  if (typeof input.rawProviderEvents !== "boolean")
    configError("resolved awsl rawProviderEvents is invalid");
  const providers = record(input.providers, "resolved awsl providers");
  exactKeys(providers, ["codex", "claude"], [], "resolved awsl providers");
  const registry = record(input.registry, "resolved awsl registry");
  exactKeys(registry, ["pluginDirs"], [], "resolved awsl registry");
  return Object.freeze({
    provider: input.provider,
    stateDir: absoluteLexicalPath(input.stateDir, "resolved awsl stateDir"),
    rawProviderEvents: input.rawProviderEvents,
    providers: Object.freeze({
      codex: providerConfig(providers.codex, "codex"),
      claude: providerConfig(providers.claude, "claude"),
    }),
    registry: Object.freeze({
      pluginDirs: stringArray(
        registry.pluginDirs,
        "resolved awsl registry pluginDirs",
        true,
      ),
    }),
  });
}

function digest(value: unknown): `sha256:${string}` {
  try {
    return `sha256:${createHash("sha256")
      .update(canonicalJson(value), "utf8")
      .digest("hex")}`;
  } catch {
    configError("fingerprint input is not canonical data");
  }
}

function enabledRoots(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const cloned = snapshot(value, "enabled plugin roots");
  if (!Array.isArray(cloned)) configError("enabled plugin roots are invalid");
  const result = cloned.map((root) =>
    absoluteLexicalPath(root, "enabled plugin root"),
  );
  if (new Set(result).size !== result.length)
    configError("enabled plugin roots contain a duplicate");
  return Object.freeze(result);
}

function cloneTiers(
  value: Readonly<Record<TierName, ModelTarget>>,
): Readonly<Record<TierName, ModelTarget>> {
  return Object.freeze(
    Object.fromEntries(
      TIERS.map((tier) => [
        tier,
        Object.freeze({
          model: value[tier].model,
          effort: value[tier].effort,
        }),
      ]),
    ) as Record<TierName, ModelTarget>,
  );
}

export function awslBehaviorFingerprint(
  value: AwslBehaviorFingerprintInput,
): `sha256:${string}` {
  const captured = record(
    snapshot(value, "awsl behavior fingerprint input"),
    "awsl behavior fingerprint input",
  );
  exactKeys(
    captured,
    ["config"],
    ["enabledPluginRoots"],
    "awsl behavior fingerprint input",
  );
  const config = resolvedConfig(captured.config);
  const roots = enabledRoots(captured.enabledPluginRoots);
  const builtinHash = `sha256:${createHash("sha256")
    .update(WORKFLOW_SUBAGENT_SOURCE, "utf8")
    .digest("hex")}`;
  return digest({
    version: 1,
    config,
    enabledPluginRoots: roots,
    registryRules: REGISTRY_FINGERPRINT_RULES,
    // Fingerprint V1 shipped with this field and value. Preserve its exact
    // encoding so a workflow-ABI rename does not strand durable 0.1.x runs.
    compatibilityProfile: LEGACY_COMPATIBILITY_PROFILE,
    builtinAssets: {
      "workflow-subagent": builtinHash,
    },
  });
}

export function modelMapFingerprint(
  value: ResolvedAwslConfig,
): `sha256:${string}` {
  const config = resolvedConfig(value);
  const selected = config.providers[config.provider];
  return digest({
    version: 1,
    provider: config.provider,
    defaultModel: selected.defaultModel ?? null,
    nativeModels: selected.nativeModels,
    exactModels: selected.models,
    tiers: selected.tiers,
    builtinAliases: BUILTIN_MODEL_ALIASES,
    builtinDefaultTiers: {
      codex: cloneTiers(DEFAULT_CONFIG.providers.codex.tiers),
      claude: cloneTiers(DEFAULT_CONFIG.providers.claude.tiers),
    },
  });
}
