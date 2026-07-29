import { isProxy } from "node:util/types";

import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type { AgentEffort, ProviderId } from "../core/types.js";
import type { ModelResolutionInput, ResolvedModel, TierName } from "./types.js";

export const BUILTIN_MODEL_ALIASES: Readonly<Record<string, TierName>> =
  Object.freeze({
    haiku: "fast",
    sonnet: "balanced",
    opus: "strong",
    terra: "balanced",
    sol: "strong",
  });

function aliasTier(model: string): TierName | undefined {
  return Object.hasOwn(BUILTIN_MODEL_ALIASES, model)
    ? BUILTIN_MODEL_ALIASES[model]
    : undefined;
}
export function isNativeModel(
  provider: ProviderId,
  model: string,
  configured: readonly string[] = [],
): boolean {
  if (configured.includes(model)) return true;
  return provider === "claude"
    ? model === "haiku" ||
        model === "sonnet" ||
        model === "opus" ||
        model.startsWith("claude-")
    : model === "gpt-5.6-terra" ||
        model === "gpt-5.6-sol" ||
        model.startsWith("gpt-") ||
        model.startsWith("codex-") ||
        /^o[1-9](?:-|$)/.test(model);
}
function fail(message: string): never {
  throw new AwslError("CONFIG_ERROR", message, { recoverable: false });
}
export function resolveModel(input: ModelResolutionInput): ResolvedModel {
  const requested = input.callOptionsModel ?? input.agentModel;
  const requestSource =
    input.callOptionsModel !== undefined
      ? "workflow"
      : input.agentModel !== undefined
        ? "agent"
        : "none";
  const requestedEffort = input.callOptionsEffort ?? input.agentEffort;
  const explicitEffortSource =
    input.callOptionsEffort !== undefined
      ? "workflow"
      : input.agentEffort !== undefined
        ? "agent"
        : undefined;
  let model: string | undefined;
  let effort: AgentEffort | undefined;
  let modelSource: ResolvedModel["modelSource"];
  let effortSource: ResolvedModel["effortSource"] = "none";
  if (requested !== undefined) {
    const exact = Object.hasOwn(input.config.models, requested)
      ? input.config.models[requested]
      : undefined;
    if (exact) {
      model = exact.model;
      effort = exact.effort;
      modelSource = `exact:${requested}`;
      effortSource = `exact:${requested}`;
    } else if (
      isNativeModel(input.provider, requested, input.config.nativeModels)
    ) {
      model = requested;
      modelSource = "native";
      const tier = aliasTier(requested);
      if (tier) {
        effort = input.config.tiers[tier].effort;
        effortSource = `tier:${tier}`;
      }
    } else {
      const tier = aliasTier(requested);
      if (!tier) return fail("unknown foreign or opaque model <redacted>");
      model = input.config.tiers[tier].model;
      effort = input.config.tiers[tier].effort;
      modelSource = `tier:${tier}`;
      effortSource = `tier:${tier}`;
    }
  } else if (input.config.defaultModel !== undefined) {
    model = input.config.defaultModel;
    modelSource = "configured-default";
  } else {
    modelSource = "implicit";
  }
  if (requestedEffort !== undefined) {
    effort = requestedEffort;
    effortSource = explicitEffortSource as "workflow" | "agent";
  }
  return {
    model,
    effort,
    requestSource,
    modelSource,
    effortSource,
    ...(requested === undefined ? {} : { effectiveRequestedModel: requested }),
    ...(requestedEffort === undefined
      ? {}
      : { effectiveRequestedEffort: requestedEffort }),
  };
}
export function validateProviderArgs(
  provider: ProviderId,
  args: readonly string[],
): readonly string[] {
  if (provider !== "codex" && provider !== "claude")
    fail("unknown provider argument grammar");
  let copy: string[];
  try {
    if (
      args === null ||
      typeof args !== "object" ||
      isProxy(args) ||
      !Array.isArray(args) ||
      Object.getPrototypeOf(args) !== Array.prototype
    )
      throw new TypeError();
    const snapshot = strictJsonClone(args, "provider arguments");
    if (
      !Array.isArray(snapshot) ||
      snapshot.some((arg) => typeof arg !== "string")
    )
      throw new TypeError();
    copy = snapshot as string[];
  } catch {
    fail("provider arguments must be an exact string array");
  }
  const byteLength = copy.reduce(
    (total, arg) => total + Buffer.byteLength(arg, "utf8"),
    0,
  );
  if (copy.length > 32 || byteLength > 4096) fail("provider args exceed limit");
  const allowed =
    provider === "codex"
      ? new Set(["--search", "--strict-config", "--no-alt-screen"])
      : new Set([
          "--disable-slash-commands",
          "--exclude-dynamic-system-prompt-sections",
          "--safe-mode",
        ]);
  const seen = new Set<string>();
  for (const arg of copy) {
    const setting =
      arg.startsWith("--setting-sources=") && provider === "claude";
    if (!arg || arg.includes("\0") || (!allowed.has(arg) && !setting))
      fail("unsafe provider argument");
    const key = setting ? "--setting-sources" : arg;
    if (seen.has(key)) fail(`duplicate provider argument ${key}`);
    seen.add(key);
    if (setting) {
      const values = arg.slice("--setting-sources=".length).split(",");
      if (
        !values[0] ||
        new Set(values).size !== values.length ||
        values.some((value) => !["user", "project", "local"].includes(value))
      )
        fail("invalid --setting-sources");
    }
  }
  return Object.freeze(copy);
}

export function validateCodexProfile(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    fail("invalid Codex profile");
  return value;
}
