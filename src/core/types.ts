import type { AwslError } from "./errors.js";

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: AgentEffort;
  isolation?: "worktree";
  agentType?: string;
}

export interface AgentResult {
  text: string;
  data?: unknown;
  model?: string;
  effort?: AgentEffort;
}

export type ProviderId = "codex" | "claude";

export interface ProviderCapabilities {
  systemPrompt: "replace" | "append" | "prompt-prefix" | false;
  tools: {
    allowlist: boolean;
    denylist: boolean;
    denyAll: boolean;
  };
  mcp: {
    additive: boolean;
    strictReplacement: boolean;
    denyAll: boolean;
  };
  permissionModes: readonly string[];
  sandboxModes: readonly (
    | "read-only"
    | "workspace-write"
    | "danger-full-access"
  )[];
  skills: false;
  structuredAttemptEvents: boolean;
  resolvedModelEvents: boolean;
}

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  complete: boolean;
}

export interface ProviderIdentity {
  id: ProviderId;
  executableRealpath: string;
  version: string;
}

export interface ProviderObservation {
  sessionId?: string;
  threadId?: string;
  resolvedModel?: string;
  structuredOutputAttempts?: number;
}

export interface NegotiatedAgentPolicy {
  readonly name: string;
  readonly instructions: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcp?: Readonly<Record<string, JsonValue>>;
  readonly permissionMode?: string;
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface ResolvedAgentSelection {
  readonly policy: NegotiatedAgentPolicy;
  readonly agentModel?: string;
  readonly agentEffort?: AgentEffort;
}

export interface ProviderRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: AgentEffort;
  schema?: Record<string, unknown>;
  agent?: NegotiatedAgentPolicy;
  signal: AbortSignal;
  onRawEvent?: (event: unknown) => void | Promise<void>;
}

export type ProviderOutcome =
  | {
      kind: "completed";
      result: AgentResult;
      usage: ProviderUsage;
      observation?: ProviderObservation;
    }
  | {
      kind: "compatibility-null";
      reason: "claude-terminal-api-error";
      usage: ProviderUsage;
      observation?: ProviderObservation;
    }
  | {
      kind: "error";
      error: AwslError;
      usage: ProviderUsage;
      observation?: ProviderObservation;
    };

export type AgentCallOutcome =
  | ProviderOutcome
  | {
      kind: "compatibility-null";
      reason: "user-skip";
      usage: {
        outputTokens: 0;
        complete: true;
      };
    };

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly identity: ProviderIdentity;
  readonly capabilities: ProviderCapabilities;
  run(request: ProviderRequest): Promise<ProviderOutcome>;
}

export interface WorkflowPhase {
  title: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowPhase[];
}

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "killed";
