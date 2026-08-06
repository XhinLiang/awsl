import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import { validateProviderArgs } from "../config/model-map.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import type {
  AgentEffort,
  NegotiatedAgentPolicy,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderIdentity,
  ProviderObservation,
  ProviderOutcome,
  ProviderRequest,
  ProviderUsage,
} from "../core/types.js";
import { snapshotAdapterOptions, snapshotProviderIdentity } from "./options.js";
import {
  type ProviderProcessResult,
  type RunProviderProcessOptions,
  runProviderProcess,
} from "./process.js";
import {
  type PreparedProviderJsonSchema,
  type PrivateJsonFile,
  createPrivateJsonFile,
  prepareProviderJsonSchema,
  serializeProviderJson,
} from "./schema.js";

const CLAUDE_PERMISSION_MODES = Object.freeze([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);

const CLAUDE_PERMISSION_MODE_SET = new Set(CLAUDE_PERMISSION_MODES);
const CLAUDE_EFFORT_SET = new Set(["low", "medium", "high", "xhigh", "max"]);

export const CLAUDE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  systemPrompt: "replace",
  tools: Object.freeze({
    allowlist: true,
    denylist: true,
    denyAll: true,
  }),
  mcp: Object.freeze({
    additive: true,
    strictReplacement: true,
    denyAll: true,
  }),
  permissionModes: CLAUDE_PERMISSION_MODES,
  sandboxModes: Object.freeze([]),
  skills: false,
  structuredAttemptEvents: true,
  resolvedModelEvents: true,
});

export interface ClaudeArgvOptions {
  configuredArgs?: readonly string[];
  model?: string;
  effort?: AgentEffort;
  schemaPacket?: string;
  agent?: NegotiatedAgentPolicy;
  mcpConfigPath?: string;
}

function compatibilityError(message: string, cause?: unknown): AwslError {
  return new AwslError("COMPATIBILITY_ERROR", message, {
    provider: "claude",
    recoverable: false,
    cause,
  });
}

function appendListOption(
  argv: string[],
  flag: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return;
  argv.push(flag);
  if (values.length === 0) argv.push("");
  else argv.push(...values);
}

export function buildClaudeArgv(options: ClaudeArgvOptions): string[] {
  const configuredArgs = validateProviderArgs(
    "claude",
    options.configuredArgs ?? [],
  );
  const agent =
    options.agent === undefined
      ? undefined
      : snapshotAgentPolicy(options.agent);
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  argv.push(...configuredArgs);
  if (options.model !== undefined) {
    argv.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    argv.push("--effort", options.effort);
  }
  if (options.schemaPacket !== undefined) {
    argv.push("--json-schema", options.schemaPacket);
  }
  if (agent !== undefined) {
    argv.push("--system-prompt", agent.instructions);
    appendListOption(argv, "--tools", agent.tools);
    appendListOption(argv, "--disallowedTools", agent.disallowedTools);
  }
  if (options.mcpConfigPath !== undefined) {
    argv.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  }
  if (agent?.permissionMode !== undefined) {
    if (agent.permissionMode === "bypassPermissions") {
      argv.push("--allow-dangerously-skip-permissions");
    }
    argv.push("--permission-mode", agent.permissionMode);
  }
  argv.push(
    "--no-chrome",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
  );
  return argv;
}

function providerError(message: string, cause?: unknown): AwslError {
  return new AwslError("PROVIDER_ERROR", message, {
    provider: "claude",
    recoverable: false,
    cause,
  });
}

function schemaError(message: string): AwslError {
  return new AwslError("SCHEMA_ERROR", message, {
    provider: "claude",
    recoverable: false,
  });
}

function assertCliValue(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw compatibilityError(`${label} must be a nonempty CLI-safe string`);
  }
}

function validateStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw compatibilityError(`${label} must be an array of strings`);
  }
  const result: string[] = [];
  for (const entry of value) {
    assertCliValue(entry, `${label} entry`);
    if (entry !== entry.trim() || entry.startsWith("-"))
      throw compatibilityError(
        `${label} entries must be normalized tool names`,
      );
    if (result.includes(entry))
      throw compatibilityError(`${label} entries must be unique`);
    result.push(entry);
  }
  return Object.freeze(result);
}

function snapshotAgentRecord(
  agent: NegotiatedAgentPolicy,
): Record<string, unknown> {
  try {
    const snapshot = strictJsonClone(agent, "Claude agent policy");
    if (!isRecord(snapshot)) throw new TypeError();
    return snapshot;
  } catch {
    throw compatibilityError(
      "Claude agent policy must contain only exact JSON data",
    );
  }
}

function snapshotAgentPolicy(
  value: NegotiatedAgentPolicy,
): NegotiatedAgentPolicy {
  const agent = snapshotAgentRecord(value);
  const name = agent.name;
  const instructions = agent.instructions;
  assertCliValue(name, "agent name");
  assertCliValue(instructions, "agent instructions");
  const skillsPresent = Object.hasOwn(agent, "skills");
  const skills = agent.skills;
  if (skillsPresent && (!Array.isArray(skills) || skills.length !== 0))
    throw compatibilityError("Claude cannot preserve agent skills");
  if (Object.hasOwn(agent, "sandboxMode"))
    throw compatibilityError("Claude cannot preserve a Codex sandbox mode");

  const policy: {
    name: string;
    instructions: string;
    tools?: readonly string[];
    disallowedTools?: readonly string[];
    mcp?: NegotiatedAgentPolicy["mcp"];
    permissionMode?: string;
  } = { instructions, name };
  if (Object.hasOwn(agent, "tools")) {
    policy.tools = validateStringList(agent.tools, "Claude agent tools");
  }
  if (Object.hasOwn(agent, "disallowedTools")) {
    policy.disallowedTools = validateStringList(
      agent.disallowedTools,
      "Claude agent disallowed tools",
    );
  }
  if (Object.hasOwn(agent, "mcp") && !isRecord(agent.mcp)) {
    throw compatibilityError(
      "Claude agent MCP configuration must be an object",
    );
  }
  if (Object.hasOwn(agent, "mcp"))
    policy.mcp = agent.mcp as NegotiatedAgentPolicy["mcp"];
  const permissionModePresent = Object.hasOwn(agent, "permissionMode");
  const permissionMode = agent.permissionMode;
  if (
    permissionModePresent &&
    (typeof permissionMode !== "string" ||
      !CLAUDE_PERMISSION_MODE_SET.has(permissionMode) ||
      permissionMode.includes("\0"))
  ) {
    throw compatibilityError(
      "the Claude provider protocol does not support the requested permission mode",
    );
  }
  if (permissionModePresent) policy.permissionMode = permissionMode as string;
  return Object.freeze(policy);
}

function validateAgentPolicy(
  request: ProviderRequest,
): NegotiatedAgentPolicy | undefined {
  if (request.model !== undefined) assertCliValue(request.model, "model");
  if (request.effort !== undefined && !CLAUDE_EFFORT_SET.has(request.effort)) {
    throw compatibilityError(
      `the Claude provider protocol does not support effort "${request.effort}"`,
    );
  }
  if (request.schema !== undefined && !isRecord(request.schema)) {
    throw new AwslError(
      "SCHEMA_ERROR",
      "Claude structured output schema must be a JSON object",
      {
        provider: "claude",
        recoverable: false,
      },
    );
  }

  return request.agent === undefined
    ? undefined
    : snapshotAgentPolicy(request.agent);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

interface UsageFields {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

function readUsage(value: unknown): UsageFields {
  if (!isRecord(value)) return {};

  const usage: UsageFields = {};
  if (isNonNegativeInteger(value.input_tokens)) {
    usage.inputTokens = value.input_tokens;
  }
  if (isNonNegativeInteger(value.output_tokens)) {
    usage.outputTokens = value.output_tokens;
  }

  const cachedParts = [
    value.cache_creation_input_tokens,
    value.cache_read_input_tokens,
  ].filter(isNonNegativeInteger);
  if (cachedParts.length > 0) {
    usage.cachedInputTokens = cachedParts.reduce(
      (total, count) => total + count,
      0,
    );
  }
  return usage;
}

function addUsage(target: UsageFields, increment: UsageFields): void {
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
  ] as const) {
    const value = increment[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function makeUsage(
  authoritative: UsageFields | undefined,
  observed: UsageFields,
  terminalUsageIsComplete: boolean,
): ProviderUsage {
  const source = authoritative ?? {};
  const inputTokens = source.inputTokens ?? observed.inputTokens;
  const cachedInputTokens =
    source.cachedInputTokens ?? observed.cachedInputTokens;
  const outputTokens = source.outputTokens ?? observed.outputTokens;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    complete:
      terminalUsageIsComplete && authoritative?.outputTokens !== undefined,
  };
}

interface ClaudeSuccessTerminal {
  kind: "success";
  isError: boolean;
  text: string;
  hasStructuredOutput: boolean;
  structuredOutput?: unknown;
  usage: UsageFields;
}

interface ClaudeErrorTerminal {
  kind: "error";
  usage: UsageFields;
}

type ClaudeTerminal = ClaudeSuccessTerminal | ClaudeErrorTerminal;

class ClaudeStreamState {
  private initializationSeen = false;
  private failure?: AwslError;
  private terminal?: ClaudeTerminal;
  private sessionId?: string;
  private resolvedModel?: string;
  private structuredOutputAttempts = 0;
  private readonly observedUsage: UsageFields = {};

  constructor(private readonly expectsStructuredOutput: boolean) {}

  private fail(message: string): void {
    this.failure ??= providerError(`Claude protocol error: ${message}`);
  }

  private observeSession(event: Record<string, unknown>): void {
    const value = event.session_id;
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0) {
      this.fail("session_id must be a nonempty string");
      return;
    }
    if (this.sessionId !== undefined && this.sessionId !== value) {
      this.fail("conflicting session_id observations");
      return;
    }
    this.sessionId = value;
  }

  private observeModel(value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0) {
      this.fail("resolved model must be a nonempty string");
      return;
    }
    if (this.resolvedModel !== undefined && this.resolvedModel !== value) {
      this.fail("conflicting resolved model observations");
      return;
    }
    this.resolvedModel = value;
  }

  private parseSystem(event: Record<string, unknown>): void {
    if (event.subtype !== "init") {
      this.fail("unsupported system subtype");
      return;
    }
    if (this.initializationSeen) {
      this.fail("duplicate system init event");
      return;
    }
    this.initializationSeen = true;
    this.observeModel(event.model);
  }

  private parseAssistant(event: Record<string, unknown>): void {
    const message = event.message;
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      this.fail("invalid assistant event");
      return;
    }
    this.observeModel(message.model);
    addUsage(this.observedUsage, readUsage(message.usage));
    if (!this.expectsStructuredOutput) return;
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        block.name === "StructuredOutput"
      ) {
        this.structuredOutputAttempts += 1;
        if (
          this.structuredOutputAttempts >
          COMPATIBILITY_PROFILE.structuredOutputAttempts
        ) {
          this.fail(
            `StructuredOutput was observed more than ${COMPATIBILITY_PROFILE.structuredOutputAttempts} times`,
          );
        }
      }
    }
  }

  private parseStreamEvent(event: Record<string, unknown>): void {
    const streamEvent = event.event;
    if (!isRecord(streamEvent) || typeof streamEvent.type !== "string") {
      this.fail("invalid stream_event event");
      return;
    }
    if (streamEvent.type === "message_start" && isRecord(streamEvent.message)) {
      this.observeModel(streamEvent.message.model);
    }
  }

  private parseUser(event: Record<string, unknown>): void {
    const message = event.message;
    if (
      !isRecord(message) ||
      message.role !== "user" ||
      !Array.isArray(message.content) ||
      message.content.length === 0 ||
      message.content.some(
        (block) => !isRecord(block) || block.type !== "tool_result",
      )
    ) {
      this.fail("only user tool-result events are supported");
    }
  }

  private parseToolProgress(event: Record<string, unknown>): void {
    if (
      typeof event.tool_use_id !== "string" ||
      typeof event.tool_name !== "string" ||
      typeof event.elapsed_time_seconds !== "number" ||
      !Number.isFinite(event.elapsed_time_seconds) ||
      event.elapsed_time_seconds < 0
    ) {
      this.fail("invalid tool_progress event");
    }
  }

  private parseToolUseSummary(event: Record<string, unknown>): void {
    if (
      typeof event.summary !== "string" ||
      !Array.isArray(event.preceding_tool_use_ids) ||
      event.preceding_tool_use_ids.some((value) => typeof value !== "string")
    ) {
      this.fail("invalid tool_use_summary event");
    }
  }

  private parseRateLimit(event: Record<string, unknown>): void {
    if (!isRecord(event.rate_limit_info)) {
      this.fail("invalid rate_limit_event event");
    }
  }

  private parseAuthStatus(event: Record<string, unknown>): void {
    if (
      typeof event.isAuthenticating !== "boolean" ||
      !Array.isArray(event.output) ||
      event.output.some((value) => typeof value !== "string") ||
      (event.error !== undefined && typeof event.error !== "string")
    ) {
      this.fail("invalid auth_status event");
    }
  }

  private parsePromptSuggestion(event: Record<string, unknown>): void {
    if (typeof event.suggestion !== "string") {
      this.fail("invalid prompt_suggestion event");
    }
  }

  private parseResult(event: Record<string, unknown>): void {
    const subtype = event.subtype;
    const usage = readUsage(event.usage);
    if (subtype === "success") {
      if (
        typeof event.is_error !== "boolean" ||
        typeof event.result !== "string"
      ) {
        this.fail("invalid successful result event");
        return;
      }
      const hasStructuredOutput = Object.hasOwn(event, "structured_output");
      if (
        this.expectsStructuredOutput &&
        !event.is_error &&
        !hasStructuredOutput
      ) {
        this.fail("structured result is missing structured_output");
      }
      this.terminal = {
        kind: "success",
        isError: event.is_error,
        text: event.result,
        hasStructuredOutput,
        ...(hasStructuredOutput
          ? { structuredOutput: structuredClone(event.structured_output) }
          : {}),
        usage,
      };
      return;
    }
    if (typeof subtype === "string" && subtype.startsWith("error_")) {
      this.terminal = { kind: "error", usage };
      return;
    }
    this.fail("unsupported result subtype");
  }

  ingest(value: unknown): void {
    if (this.terminal !== undefined) {
      this.fail("event received after terminal result");
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.fail("event must be an object with a type");
      return;
    }

    this.observeSession(value);
    switch (value.type) {
      case "system":
        this.parseSystem(value);
        break;
      case "assistant":
        this.parseAssistant(value);
        break;
      case "stream_event":
        this.parseStreamEvent(value);
        break;
      case "user":
        this.parseUser(value);
        break;
      case "tool_progress":
        this.parseToolProgress(value);
        break;
      case "tool_use_summary":
        this.parseToolUseSummary(value);
        break;
      case "rate_limit_event":
        this.parseRateLimit(value);
        break;
      case "auth_status":
        this.parseAuthStatus(value);
        break;
      case "prompt_suggestion":
        this.parsePromptSuggestion(value);
        break;
      case "result":
        this.parseResult(value);
        break;
      default:
        this.fail("unsupported event type");
    }
  }

  private observation(): ProviderObservation | undefined {
    if (
      this.sessionId === undefined &&
      this.resolvedModel === undefined &&
      !this.expectsStructuredOutput
    ) {
      return undefined;
    }
    return {
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.resolvedModel === undefined
        ? {}
        : { resolvedModel: this.resolvedModel }),
      ...(this.expectsStructuredOutput
        ? { structuredOutputAttempts: this.structuredOutputAttempts }
        : {}),
    };
  }

  outcome(request: ProviderRequest): ProviderOutcome {
    const terminal = this.terminal;
    const usage = makeUsage(
      terminal?.usage,
      this.observedUsage,
      terminal !== undefined,
    );
    const observation = this.observation();

    if (this.failure !== undefined) {
      return {
        kind: "error",
        error: this.failure,
        usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }
    if (terminal === undefined) {
      return {
        kind: "error",
        error: providerError(
          "Claude protocol error: provider exited without a terminal result",
        ),
        usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }
    if (terminal.kind === "error") {
      return {
        kind: "error",
        error: providerError("Claude provider ended with an error result"),
        usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }
    if (terminal.isError) {
      return {
        kind: "compatibility-null",
        reason: "claude-terminal-api-error",
        usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }
    return {
      kind: "completed",
      result: {
        text: terminal.text,
        ...(terminal.hasStructuredOutput
          ? { data: terminal.structuredOutput }
          : {}),
        ...(this.resolvedModel === undefined
          ? {}
          : { model: this.resolvedModel }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      },
      usage,
      ...(observation === undefined ? {} : { observation }),
    };
  }

  transportError(error: unknown): ProviderOutcome {
    const usage = makeUsage(
      this.terminal?.usage,
      this.observedUsage,
      this.terminal !== undefined,
    );
    const observation = this.observation();
    return {
      kind: "error",
      error:
        error instanceof AwslError && error.code === "PERSISTENCE_ERROR"
          ? error
          : providerError("Claude provider transport failed", error),
      usage,
      ...(observation === undefined ? {} : { observation }),
    };
  }
}

export type ClaudeProcessRunner = (
  options: RunProviderProcessOptions,
) => Promise<ProviderProcessResult>;

export interface ClaudeAdapterOptions {
  identity: ProviderIdentity;
  configuredArgs?: readonly string[];
  processRunner?: ClaudeProcessRunner;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly identity: ProviderIdentity;
  readonly #configuredArgs: readonly string[];
  readonly #processRunner: ClaudeProcessRunner;

  constructor(options: ClaudeAdapterOptions) {
    const snapshot = snapshotAdapterOptions(options, "claude", [
      "identity",
      "configuredArgs",
      "processRunner",
    ]);
    this.identity = snapshotProviderIdentity(snapshot.identity, "claude");
    this.#configuredArgs = validateProviderArgs(
      "claude",
      (snapshot.configuredArgs ?? []) as readonly string[],
    );
    if (
      Object.hasOwn(snapshot, "processRunner") &&
      typeof snapshot.processRunner !== "function"
    )
      throw new AwslError(
        "CONFIG_ERROR",
        "claude process runner must be an own data function",
        { recoverable: false },
      );
    this.#processRunner =
      (snapshot.processRunner as ClaudeProcessRunner | undefined) ??
      runProviderProcess;
  }

  async run(request: ProviderRequest): Promise<ProviderOutcome> {
    const agent = validateAgentPolicy(request);

    const structuredSchema: PreparedProviderJsonSchema | undefined =
      request.schema === undefined
        ? undefined
        : prepareProviderJsonSchema(request.schema, {
            label: "Claude structured output schema",
            provider: "claude",
          });
    const mcpPacket =
      agent?.mcp === undefined
        ? undefined
        : serializeProviderJson(
            { mcpServers: agent.mcp },
            {
              label: `agent "${agent.name}" MCP configuration`,
              maxBytes: Number.MAX_SAFE_INTEGER,
              provider: "claude",
            },
          );
    const state = new ClaudeStreamState(structuredSchema !== undefined);
    let mcpArtifact: PrivateJsonFile | undefined;

    try {
      if (request.signal.aborted) {
        throw new AwslError("CANCELLED", "provider process cancelled", {
          provider: "claude",
          recoverable: false,
        });
      }
      if (mcpPacket !== undefined) {
        mcpArtifact = await createPrivateJsonFile(mcpPacket, {
          basename: "mcp.json",
          prefix: "awsl-claude-mcp-",
        });
      }

      await this.#processRunner({
        executable: this.identity.executableRealpath,
        argv: buildClaudeArgv({
          configuredArgs: this.#configuredArgs,
          agent,
          effort: request.effort,
          mcpConfigPath: mcpArtifact?.path,
          model: request.model,
          schemaPacket: structuredSchema?.packet,
        }),
        cwd: request.cwd,
        prompt: request.prompt,
        signal: request.signal,
        onEvent: async (event) => {
          state.ingest(event);
          await request.onRawEvent?.(event);
        },
      });
      const outcome = state.outcome(request);
      if (
        structuredSchema !== undefined &&
        outcome.kind === "completed" &&
        !structuredSchema.matches(outcome.result.data)
      ) {
        return {
          kind: "error",
          error: schemaError(
            "Claude structured result does not match the requested schema",
          ),
          usage: outcome.usage,
          ...(outcome.observation === undefined
            ? {}
            : { observation: outcome.observation }),
        };
      }
      return outcome;
    } catch (error) {
      if (
        error instanceof AwslError &&
        error.code === "CANCELLED" &&
        request.signal.aborted
      ) {
        throw error;
      }
      return state.transportError(error);
    } finally {
      await mcpArtifact?.dispose();
    }
  }
}
