import type { AgentEffort, ProviderId } from "../core/types.js";

export type ConfigLayer = "defaults" | "user" | "project" | "env" | "cli";
export type TierName = "fast" | "balanced" | "strong";

export interface ModelTarget {
  model: string;
  effort: AgentEffort;
}
interface BaseProviderConfig {
  id: ProviderId;
  executable: string;
  args: readonly string[];
  defaultModel?: string;
  nativeModels: readonly string[];
  tiers: Readonly<Record<TierName, ModelTarget>>;
  models: Readonly<Record<string, ModelTarget>>;
}
export interface CodexProviderConfig extends BaseProviderConfig {
  id: "codex";
  profile?: string;
}
export interface ClaudeProviderConfig extends BaseProviderConfig {
  id: "claude";
  profile?: never;
}
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig;
export interface ResolvedAwslConfig {
  provider: ProviderId;
  stateDir: string;
  rawProviderEvents: boolean;
  providers: {
    readonly codex: CodexProviderConfig;
    readonly claude: ClaudeProviderConfig;
  };
  registry: { pluginDirs: readonly string[] };
}
export interface Provenance {
  layer: ConfigLayer;
  source: string;
}
export interface LoadedConfig {
  value: ResolvedAwslConfig;
  provenance: Readonly<Record<string, Provenance>>;
  configSources: readonly {
    requestedPath: string;
    realpath: string;
    sha256: `sha256:${string}`;
  }[];
}
export type ConfigInput = Record<string, unknown>;
export interface LoadConfigOptions {
  cwd: string;
  cli?: ConfigInput;
  env?: Record<string, string | undefined>;
  userConfig?: ConfigInput;
  projectConfig?: ConfigInput;
  userConfigPath?: string;
  projectConfigPath?: string;
}
export interface ModelResolutionInput {
  provider: ProviderId;
  callOptionsModel?: string;
  callOptionsEffort?: AgentEffort;
  agentModel?: string;
  agentEffort?: AgentEffort;
  config: ProviderConfig;
}
export interface ResolvedModel {
  model?: string;
  effort?: AgentEffort;
  requestSource: "workflow" | "agent" | "none";
  modelSource:
    | `exact:${string}`
    | "tier:fast"
    | "tier:balanced"
    | "tier:strong"
    | "native"
    | "configured-default"
    | "implicit";
  effortSource:
    | "workflow"
    | "agent"
    | `exact:${string}`
    | "tier:fast"
    | "tier:balanced"
    | "tier:strong"
    | "none";
  effectiveRequestedModel?: string;
  effectiveRequestedEffort?: AgentEffort;
}
