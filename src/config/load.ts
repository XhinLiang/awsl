import { types as utilTypes } from "node:util";
import { parse } from "smol-toml";
import { AwslError } from "../core/errors.js";
import type { AgentEffort, ProviderId } from "../core/types.js";
import { DEFAULT_CONFIG, DEFAULT_PATHS } from "./defaults.js";
import { safeDiagnosticValue } from "./diagnostics.js";
import {
  isNativeModel,
  validateCodexProfile,
  validateProviderArgs,
} from "./model-map.js";
import {
  canonicalCwd,
  isMissingSourceError,
  lexicalPath,
  readRegularUtf8,
  resolveProjectRoot,
} from "./paths.js";
import type {
  ConfigInput,
  ConfigLayer,
  LoadConfigOptions,
  LoadedConfig,
  Provenance,
  ResolvedAwslConfig,
} from "./types.js";

const tiers = ["fast", "balanced", "strong"] as const;
const efforts = new Set<AgentEffort>(["low", "medium", "high", "xhigh", "max"]);
const executableName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isExecutable(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  if (executableName.test(value)) return true;
  const hasSeparator =
    value.includes("/") ||
    (process.platform === "win32" && value.includes("\\"));
  if (!hasSeparator) return false;
  try {
    lexicalPath(value, "/");
    return true;
  } catch {
    return false;
  }
}
const pointer = (parent: string, key: string) =>
  `${parent}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
function inputError(
  message = "configuration input must be immutable data",
): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}
/** Creates a JSON-like, null-prototype snapshot before any validation. */
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_NODES = 10_000;
interface SnapshotState {
  readonly seen: Set<object>;
  nodes: number;
}
function snapshot(
  value: unknown,
  state: SnapshotState = { seen: new Set(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (depth > MAX_SNAPSHOT_DEPTH || state.nodes > MAX_SNAPSHOT_NODES)
    inputError("configuration input exceeds structural limits");
  if (
    value === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof value)
  )
    return value;
  if (typeof value !== "object") inputError();
  let keys: string[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (utilTypes.isProxy(value)) inputError();
    if (state.seen.has(value))
      inputError(
        "configuration input must not contain shared references or cycles",
      );
    state.seen.add(value);
    if (Object.getOwnPropertySymbols(value).length) inputError();
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) inputError();
      keys = Object.getOwnPropertyNames(value);
      if (
        keys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))
      )
        inputError();
      if (value.length > MAX_SNAPSHOT_NODES || keys.length - 1 !== value.length)
        inputError("configuration array must not be sparse or oversized");
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) inputError();
      keys = Object.getOwnPropertyNames(value);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      if (key === "length" && Array.isArray(value)) continue;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) inputError();
    }
  } catch (error) {
    if (error instanceof AwslError) throw error;
    inputError();
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++)
      result.push(snapshot(descriptors[String(index)].value, state, depth + 1));
    return result;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys)
    result[key] = snapshot(descriptors[key].value, state, depth + 1);
  return result;
}
function snapshotInput(value: unknown): ConfigInput {
  const result = snapshot(value);
  if (!result || typeof result !== "object" || Array.isArray(result))
    inputError();
  return result as ConfigInput;
}
function snapshotOptions(value: unknown): LoadConfigOptions {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value))
    inputError();
  let keys: readonly (string | symbol)[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) inputError();
    keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) inputError();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof AwslError) throw error;
    inputError();
  }
  const allowed = new Set([
    "cwd",
    "cli",
    "env",
    "userConfig",
    "projectConfig",
    "userConfigPath",
    "projectConfigPath",
  ]);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) {
    const descriptor = descriptors[key];
    if (
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      inputError();
    result[key] = descriptor.value;
  }
  return result as unknown as LoadConfigOptions;
}
function record(
  layer: ConfigLayer,
  source: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failure(layer, source, path, "object", value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    failure(layer, source, path, "plain object", value);
  return value as Record<string, unknown>;
}
function failure(
  layer: ConfigLayer | "merged",
  _source: string,
  path: string,
  expected: string,
  actual: unknown,
): never {
  const sourceLabel =
    layer === "user"
      ? "user config"
      : layer === "project"
        ? "project config"
        : layer === "env"
          ? "environment"
          : layer === "cli"
            ? "CLI"
            : layer === "defaults"
              ? "built-in"
              : "merged configuration";
  throw new AwslError(
    "CONFIG_ERROR",
    `${layer} ${sourceLabel} ${path}: expected ${expected}; actual ${safeDiagnosticValue(actual)}`,
    { recoverable: false },
  );
}
function string(
  layer: ConfigLayer,
  source: string,
  path: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    failure(layer, source, path, "nonempty NUL-free string", value);
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>))
    result[key] = clone(child);
  return result;
}
function checkKeys(
  layer: ConfigLayer,
  source: string,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failure(
        layer,
        source,
        pointer(path, "<redacted-dynamic-key>"),
        "known key",
        key,
      );
}
function validateProvider(
  layer: ConfigLayer,
  source: string,
  path: string,
  value: unknown,
  provider: ProviderId,
): void {
  const input = record(layer, source, path, value);
  checkKeys(
    layer,
    source,
    path,
    input,
    provider === "codex"
      ? [
          "executable",
          "args",
          "default_model",
          "native_models",
          "tiers",
          "models",
          "profile",
        ]
      : [
          "executable",
          "args",
          "default_model",
          "native_models",
          "tiers",
          "models",
        ],
  );
  for (const key of ["executable", "default_model", "profile"] as const)
    if (key in input) string(layer, source, pointer(path, key), input[key]);
  if ("executable" in input && !isExecutable(input.executable as string))
    failure(
      layer,
      source,
      pointer(path, "executable"),
      "one executable name or path",
      input.executable,
    );
  if ("profile" in input) {
    try {
      validateCodexProfile(input.profile);
    } catch {
      failure(
        layer,
        source,
        pointer(path, "profile"),
        "filename-safe Codex profile",
        input.profile,
      );
    }
  }
  for (const key of ["args", "native_models"] as const)
    if (key in input) {
      if (
        !Array.isArray(input[key]) ||
        (key === "native_models" &&
          new Set(input[key] as unknown[]).size !==
            (input[key] as unknown[]).length)
      )
        failure(
          layer,
          source,
          pointer(path, key),
          "unique string array",
          input[key],
        );
      for (const item of input[key] as unknown[])
        string(layer, source, pointer(path, key), item);
      if (key === "args") {
        try {
          validateProviderArgs(provider, input.args as string[]);
        } catch {
          failure(
            layer,
            source,
            pointer(path, "args"),
            `${provider} safe ordered argument vector`,
            input.args,
          );
        }
      }
    }
  if ("tiers" in input) {
    const values = record(layer, source, pointer(path, "tiers"), input.tiers);
    checkKeys(layer, source, pointer(path, "tiers"), values, tiers);
    for (const [name, target] of Object.entries(values))
      validateTarget(
        layer,
        source,
        pointer(pointer(path, "tiers"), name),
        target,
      );
  }
  if ("models" in input) {
    const values = record(layer, source, pointer(path, "models"), input.models);
    for (const [name, target] of Object.entries(values)) {
      string(layer, source, pointer(path, "models"), name);
      validateTarget(
        layer,
        source,
        pointer(pointer(path, "models"), "<redacted-dynamic-key>"),
        target,
      );
    }
  }
}
function validateTarget(
  layer: ConfigLayer,
  source: string,
  path: string,
  value: unknown,
): void {
  const input = record(layer, source, path, value);
  checkKeys(layer, source, path, input, ["model", "effort"]);
  if ("model" in input)
    string(layer, source, pointer(path, "model"), input.model);
  if (
    "effort" in input &&
    (typeof input.effort !== "string" ||
      !efforts.has(input.effort as AgentEffort))
  )
    failure(
      layer,
      source,
      pointer(path, "effort"),
      "low, medium, high, xhigh, or max",
      input.effort,
    );
}
function validateLayer(
  layer: ConfigLayer,
  source: string,
  raw: ConfigInput,
): void {
  const input = record(layer, source, "", raw);
  checkKeys(layer, source, "", input, [
    "provider",
    "state_dir",
    "raw_provider_events",
    "providers",
    "registry",
  ]);
  if (
    "provider" in input &&
    input.provider !== "codex" &&
    input.provider !== "claude"
  )
    failure(layer, source, "/provider", "codex or claude", input.provider);
  if ("state_dir" in input)
    string(layer, source, "/state_dir", input.state_dir);
  if (
    "raw_provider_events" in input &&
    typeof input.raw_provider_events !== "boolean"
  )
    failure(
      layer,
      source,
      "/raw_provider_events",
      "boolean",
      input.raw_provider_events,
    );
  if ("providers" in input) {
    const providers = record(layer, source, "/providers", input.providers);
    checkKeys(layer, source, "/providers", providers, ["codex", "claude"]);
    for (const id of ["codex", "claude"] as const)
      if (id in providers)
        validateProvider(
          layer,
          source,
          pointer("/providers", id),
          providers[id],
          id,
        );
  }
  if ("registry" in input) {
    const registry = record(layer, source, "/registry", input.registry);
    checkKeys(layer, source, "/registry", registry, ["plugin_dirs"]);
    if ("plugin_dirs" in registry) {
      if (
        !Array.isArray(registry.plugin_dirs) ||
        new Set(registry.plugin_dirs).size !== registry.plugin_dirs.length
      )
        failure(
          layer,
          source,
          "/registry/plugin_dirs",
          "unique string array",
          registry.plugin_dirs,
        );
      for (const value of registry.plugin_dirs)
        string(layer, source, "/registry/plugin_dirs", value);
    }
  }
}
function merge(lower: unknown, higher: unknown): unknown {
  if (Array.isArray(higher)) return clone(higher);
  if (
    higher &&
    typeof higher === "object" &&
    !Array.isArray(higher) &&
    lower &&
    typeof lower === "object" &&
    !Array.isArray(lower)
  ) {
    const result = Object.assign(Object.create(null), clone(lower)) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(
      higher as Record<string, unknown>,
    ))
      result[key] = Object.hasOwn(result, key)
        ? merge(result[key], value)
        : clone(value);
    return result;
  }
  return clone(higher);
}
function normalize(
  raw: Record<string, unknown>,
  preserveKeys = false,
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    const normalized = preserveKeys
      ? key
      : key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
    result[normalized] =
      value && typeof value === "object" && !Array.isArray(value)
        ? normalize(value as Record<string, unknown>, key === "models")
        : value;
  }
  return result;
}
function collectProvenance(
  value: unknown,
  layer: ConfigLayer,
  source: string,
  path = "",
  into: Record<string, Provenance> = Object.create(null),
): Record<string, Provenance> {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    into[path] = { layer, source };
    return into;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>))
    collectProvenance(child, layer, source, pointer(path, key), into);
  return into;
}
function snapshotEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!env || typeof env !== "object" || utilTypes.isProxy(env)) inputError();
  const result = Object.create(null) as Record<string, string | undefined>;
  for (const key of [
    "AWSL_PROVIDER",
    "AWSL_STATE_DIR",
    "AWSL_RAW_PROVIDER_EVENTS",
    "AWSL_CODEX_COMMAND",
    "AWSL_CLAUDE_COMMAND",
  ]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(env, key);
    } catch {
      inputError();
    }
    if (!descriptor) continue;
    if (!("value" in descriptor) || descriptor.value === undefined) {
      if (!("value" in descriptor)) inputError();
      continue;
    }
    if (typeof descriptor.value !== "string") inputError();
    result[key] = descriptor.value;
  }
  return result;
}
function envLayer(env: Record<string, string | undefined>): ConfigInput {
  const out = Object.create(null) as Record<string, unknown>;
  const has = (key: string) =>
    Object.hasOwn(env, key) && env[key] !== undefined;
  if (has("AWSL_PROVIDER")) out.provider = env.AWSL_PROVIDER;
  if (has("AWSL_STATE_DIR")) out.state_dir = env.AWSL_STATE_DIR;
  if (has("AWSL_RAW_PROVIDER_EVENTS")) {
    const rawValue = env.AWSL_RAW_PROVIDER_EVENTS as string;
    const value = rawValue.toLowerCase();
    if (value !== "true" && value !== "false")
      failure(
        "env",
        "AWSL_RAW_PROVIDER_EVENTS",
        "/raw_provider_events",
        "true or false",
        rawValue,
      );
    out.raw_provider_events = value === "true";
  }
  const providers = Object.create(null) as Record<string, unknown>;
  if (has("AWSL_CODEX_COMMAND"))
    providers.codex = { executable: env.AWSL_CODEX_COMMAND };
  if (has("AWSL_CLAUDE_COMMAND"))
    providers.claude = { executable: env.AWSL_CLAUDE_COMMAND };
  if (Object.keys(providers).length) out.providers = providers;
  return out;
}
async function optionalToml(
  path: string | undefined,
  cwd: string,
  sourceLabel: "user config" | "project config",
): Promise<{
  raw: ConfigInput;
  source?: {
    requestedPath: string;
    realpath: string;
    sha256: `sha256:${string}`;
  };
}> {
  if (path === undefined) return { raw: {} };
  try {
    const snapshot = await readRegularUtf8(path, cwd);
    let raw: ConfigInput;
    try {
      raw = snapshotInput(parse(snapshot.source));
    } catch {
      throw new AwslError("CONFIG_ERROR", `invalid TOML in ${sourceLabel}`, {
        recoverable: false,
      });
    }
    return {
      raw,
      source: {
        requestedPath: path,
        realpath: snapshot.realpath,
        sha256: snapshot.sha256,
      },
    };
  } catch (error) {
    if (isMissingSourceError(error)) return { raw: {} };
    throw error;
  }
}
export async function loadConfig(
  options: LoadConfigOptions,
): Promise<LoadedConfig> {
  const safeOptions = snapshotOptions(options);
  if (safeOptions.userConfigPath === "" || safeOptions.projectConfigPath === "")
    inputError("explicit config path must be nonempty");
  const cli = snapshotInput(safeOptions.cli ?? {});
  const env = snapshotEnvironment(safeOptions.env ?? process.env);
  const inlineUser =
    safeOptions.userConfig === undefined
      ? undefined
      : snapshotInput(safeOptions.userConfig);
  const inlineProject =
    safeOptions.projectConfig === undefined
      ? undefined
      : snapshotInput(safeOptions.projectConfig);
  const cwd = await canonicalCwd(safeOptions.cwd);
  const project = await resolveProjectRoot(cwd);
  const userPath = safeOptions.userConfigPath ?? DEFAULT_PATHS.userConfigPath;
  const projectPath =
    safeOptions.projectConfigPath ?? `${project}/.awsl/config.toml`;
  const userRead =
    inlineUser === undefined
      ? await optionalToml(userPath, cwd, "user config")
      : { raw: inlineUser };
  const projectRead =
    inlineProject === undefined
      ? await optionalToml(projectPath, cwd, "project config")
      : { raw: inlineProject };
  const user = userRead.raw;
  const projectConfig = projectRead.raw;
  const defaults: ConfigInput = {
    provider: DEFAULT_CONFIG.provider,
    state_dir: DEFAULT_CONFIG.stateDir,
    raw_provider_events: DEFAULT_CONFIG.rawProviderEvents,
    providers: Object.fromEntries(
      (["codex", "claude"] as const).map((id) => {
        const item = DEFAULT_CONFIG.providers[id];
        return [
          id,
          {
            executable: item.executable,
            args: item.args,
            native_models: item.nativeModels,
            tiers: item.tiers,
            models: item.models,
          },
        ];
      }),
    ),
    registry: { plugin_dirs: DEFAULT_CONFIG.registry.pluginDirs },
  };
  const layers: readonly [ConfigLayer, string, ConfigInput][] = [
    ["defaults", "built-in", defaults],
    ["user", userPath, user],
    ["project", projectPath, projectConfig],
    ["env", "environment", envLayer(env)],
    ["cli", "CLI", cli],
  ];
  let merged: unknown = {};
  const provenance = Object.create(null) as Record<string, Provenance>;
  for (const [layer, source, input] of layers) {
    validateLayer(layer, source, input);
    merged = merge(merged, input);
    Object.assign(
      provenance,
      collectProvenance(
        normalize(input as Record<string, unknown>),
        layer,
        source,
      ),
    );
  }
  const normal = normalize(
    merged as Record<string, unknown>,
  ) as unknown as ResolvedAwslConfig;
  if (!normal.providers?.codex || !normal.providers?.claude)
    failure(
      "defaults",
      "built-in",
      "/providers",
      "both providers",
      normal.providers,
    );
  for (const id of ["codex", "claude"] as const) {
    const provider = normal.providers[id];
    if (provider.id !== id) (provider as { id: ProviderId }).id = id;
    provenance[`/providers/${id}/id`] = {
      layer: "defaults",
      source: "built-in",
    };
    for (const tier of tiers)
      if (!provider.tiers?.[tier]?.model || !provider.tiers[tier].effort)
        failure(
          "merged",
          "configuration",
          `/providers/${id}/tiers/${tier}`,
          "model and effort",
          provider.tiers?.[tier],
        );
    for (const target of Object.values(provider.models ?? {}))
      if (!target.model || !target.effort)
        failure(
          "merged",
          "configuration",
          `/providers/${id}/models`,
          "model and effort",
          target,
        );
    validateProviderArgs(id, provider.args);
    for (const target of [
      ...Object.values(provider.tiers),
      ...Object.values(provider.models),
      ...(provider.defaultModel ? [{ model: provider.defaultModel }] : []),
    ])
      if (!isNativeModel(id, target.model, provider.nativeModels))
        failure(
          "merged",
          "configuration",
          `/providers/${id}`,
          `${id} native model target`,
          target.model,
        );
  }
  normal.stateDir = lexicalPath(normal.stateDir, cwd);
  return deepFreeze({
    value: deepFreeze(normal),
    provenance: deepFreeze(provenance),
    configSources: deepFreeze(
      [userRead.source, projectRead.source].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
    ),
  });
}
