import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import {
  validateAgyPermissionMode,
  validateProviderArgs,
} from "../config/model-map.js";
import type { AgyPermissionMode } from "../config/types.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import { appendToolUse, summarizeToolPayload } from "../core/tool-use.js";
import type {
  AgentEffort,
  AgentToolUse,
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
} from "./schema.js";

export const AGY_PERMISSION_MODES = Object.freeze([
  "accept-edits",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "plan",
] as const);

const AGY_PERMISSION_MODE_SET = new Set<string>(AGY_PERMISSION_MODES);
const AGY_EFFORT_SET = new Set<AgentEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const AGY_CAPABILITIES: ProviderCapabilities = Object.freeze({
  systemPrompt: "prompt-prefix",
  tools: Object.freeze({
    allowlist: false,
    denylist: false,
    denyAll: false,
  }),
  mcp: Object.freeze({
    additive: false,
    strictReplacement: false,
    denyAll: false,
  }),
  permissionModes: AGY_PERMISSION_MODES,
  sandboxModes: Object.freeze([]),
  skills: false,
  structuredAttemptEvents: false,
  resolvedModelEvents: false,
});

export interface AgyArgvOptions {
  configuredArgs?: readonly string[];
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
  schemaPath?: string;
  additionalDirs?: readonly string[];
}

function compatibilityError(message: string, cause?: unknown): AwslError {
  return new AwslError("COMPATIBILITY_ERROR", message, {
    provider: "agy",
    recoverable: false,
    cause,
  });
}

function providerError(
  message: string,
  cause?: unknown,
  recoverable = false,
): AwslError {
  return new AwslError("PROVIDER_ERROR", message, {
    provider: "agy",
    recoverable,
    cause,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendPermissionFlags(
  argv: string[],
  permissionMode: string | undefined,
): void {
  if (permissionMode === undefined) return;
  if (!AGY_PERMISSION_MODE_SET.has(permissionMode)) {
    throw compatibilityError(
      "the agy provider protocol does not support the requested permission mode",
    );
  }
  if (permissionMode === "bypassPermissions") {
    argv.push("--dangerously-skip-permissions");
    return;
  }
  const normalizedMode =
    permissionMode === "acceptEdits" ? "accept-edits" : permissionMode;
  argv.push("--mode", normalizedMode);
}

export function buildAgyArgv(options: AgyArgvOptions): string[] {
  const configuredArgs = validateProviderArgs(
    "agy",
    options.configuredArgs ?? [],
  );
  const argv = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  argv.push(...configuredArgs);
  if (options.model !== undefined) {
    assertCliValue(options.model, "agy model");
    argv.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    if (!AGY_EFFORT_SET.has(options.effort)) {
      throw compatibilityError("agy does not support the requested effort");
    }
    argv.push("--effort", options.effort);
  }
  appendPermissionFlags(argv, options.permissionMode);
  if (options.schemaPath !== undefined) {
    assertCliValue(options.schemaPath, "agy schema path");
    argv.push("--json-schema", options.schemaPath);
  }
  for (const dir of options.additionalDirs ?? []) {
    assertCliValue(dir, "agy workspace directory");
    argv.push("--add-dir", dir);
  }
  return argv;
}

function snapshotAgentRecord(
  agent: NegotiatedAgentPolicy,
): Record<string, unknown> {
  try {
    const snapshot = strictJsonClone(agent, "agy agent policy");
    if (!isRecord(snapshot)) throw new TypeError();
    return snapshot;
  } catch {
    throw compatibilityError(
      "agy agent policy must contain only exact JSON data",
    );
  }
}

function validateAgentPolicy(
  request: ProviderRequest,
): NegotiatedAgentPolicy | undefined {
  if (request.model !== undefined) {
    assertCliValue(request.model, "agy model");
  }
  if (request.effort !== undefined && !AGY_EFFORT_SET.has(request.effort)) {
    throw compatibilityError("agy does not support the requested effort");
  }
  if (request.schema !== undefined && !isRecord(request.schema)) {
    throw new AwslError(
      "SCHEMA_ERROR",
      "agy structured output schema must be a JSON object",
      {
        provider: "agy",
        recoverable: false,
      },
    );
  }
  if (request.agent === undefined) return undefined;
  const agent = snapshotAgentRecord(request.agent);
  const name = agent.name;
  const instructions = agent.instructions;
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\0") ||
    typeof instructions !== "string" ||
    !instructions ||
    instructions.includes("\0")
  ) {
    throw compatibilityError("agy agent policy is invalid");
  }
  const skillsPresent = Object.hasOwn(agent, "skills");
  const skills = agent.skills;
  if (skillsPresent && (!Array.isArray(skills) || skills.length !== 0)) {
    throw compatibilityError("agy cannot preserve agent skills");
  }
  if (Object.hasOwn(agent, "tools")) {
    throw compatibilityError(
      "agy cannot preserve the named-agent tool allowlist",
    );
  }
  if (Object.hasOwn(agent, "disallowedTools")) {
    throw compatibilityError(
      "agy cannot preserve the named-agent tool denylist",
    );
  }
  if (Object.hasOwn(agent, "mcp")) {
    throw compatibilityError("agy cannot preserve the named-agent MCP policy");
  }
  if (Object.hasOwn(agent, "sandboxMode")) {
    throw compatibilityError("agy cannot preserve a Codex sandbox mode");
  }
  let permissionMode: string | undefined;
  if (Object.hasOwn(agent, "permissionMode")) {
    const rawMode = agent.permissionMode;
    if (typeof rawMode !== "string" || !AGY_PERMISSION_MODE_SET.has(rawMode)) {
      throw compatibilityError(
        "the agy provider protocol does not support the requested permission mode",
      );
    }
    permissionMode = rawMode;
  }
  return Object.freeze({
    instructions,
    name,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
}

function token(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

interface UsageFields {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

function readUsage(value: unknown): UsageFields {
  if (!isRecord(value)) return {};
  const inputTokens = token(value.input_tokens);
  const cachedInputTokens = token(value.cache_read_tokens);
  const outputTokens = token(value.output_tokens);
  const reasoningTokens = token(value.thinking_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function addUsage(target: UsageFields, increment: UsageFields): void {
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
  ] as const) {
    const value = increment[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function makeUsage(
  authoritative: UsageFields | undefined,
  observed: UsageFields,
  terminalSeen: boolean,
): ProviderUsage {
  const source = authoritative ?? {};
  const inputTokens = source.inputTokens ?? observed.inputTokens;
  const cachedInputTokens =
    source.cachedInputTokens ?? observed.cachedInputTokens;
  const outputTokens = source.outputTokens ?? observed.outputTokens;
  const reasoningTokens = source.reasoningTokens ?? observed.reasoningTokens;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    complete: terminalSeen && authoritative?.outputTokens !== undefined,
  };
}

function hasOnlyZeroUsage(usage: ProviderUsage): boolean {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
  ].every((value) => value === undefined || value === 0);
}

const RETRYABLE_ZERO_USAGE: ProviderUsage = Object.freeze({
  complete: true,
  outputTokens: 0,
});

const ESCAPE = String.fromCharCode(0x1b);
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|${ESCAPE}\\\\))`,
  "g",
);

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }).join("");
}

function sanitizeProviderDetail(value: string): string {
  const withoutAnsi = value.replace(ANSI_ESCAPE_SEQUENCE, "");
  return stripControlCharacters(withoutAnsi)
    .replace(
      /\b(aws(?:[_-]?secret[_-]?access[_-]?key|[_-]?access[_-]?key[_-]?id|[_-]?session[_-]?token))\s*[:=]\s*[^\s,;]+/gi,
      "$1: [REDACTED]",
    )
    .replace(
      /\b(x-amz-(?:credential|security-token|signature))\s*[:=]\s*[^\s,;&]+/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(cookie|set-cookie|x-api-key|api[ _-]?key|token|secret|password|awsaccesskeyid)\s*[:=]\s*[^\s,;]+/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b(x-amz-signature|signature)\s*=\s*[^\s,&]+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_048);
}

const TRANSIENT_AGY_FAILURE =
  /(?:\b(?:408|429|500|502|503|504)\b|bad gateway|gateway timeout|service unavailable|temporarily unavailable|resource_exhausted|rate limit|connection (?:closed|refused|reset)|connection reset by peer|econnreset|etimedout|network error|request timed out|upstream (?:connect|error|failure)|timeout)/i;

function isTransientAgyFailure(value: string): boolean {
  return TRANSIENT_AGY_FAILURE.test(value);
}

interface AgySuccessTerminal {
  kind: "success";
  text: string;
  hasStructuredOutput: boolean;
  structuredOutput?: unknown;
  usage: UsageFields;
}

interface AgyErrorTerminal {
  kind: "error";
  detail: string;
  usage: UsageFields;
}

type AgyTerminal = AgySuccessTerminal | AgyErrorTerminal;

class AgyProtocol {
  #initSeen = false;
  #sessionId?: string;
  #resolvedModel?: string;
  #hasSubstantiveStep = false;
  #observedUsage: UsageFields = {};
  #terminal?: AgyTerminal;
  #toolUses: AgentToolUse[] = [];
  #seenToolSteps = new Set<number>();

  get hasTerminalError(): boolean {
    return this.#terminal?.kind === "error";
  }

  get observation(): ProviderObservation | undefined {
    if (this.#sessionId === undefined && this.#resolvedModel === undefined) {
      return undefined;
    }
    return {
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#resolvedModel === undefined
        ? {}
        : { resolvedModel: this.#resolvedModel }),
    };
  }

  get usage(): ProviderUsage {
    return makeUsage(
      this.#terminal?.usage,
      this.#observedUsage,
      this.#terminal !== undefined,
    );
  }

  retryableTransportFailure(cause: unknown, failureStderr?: string): boolean {
    if (this.#hasSubstantiveStep || !hasOnlyZeroUsage(this.usage)) return false;
    const detail =
      (this.#terminal?.kind === "error" ? this.#terminal.detail : undefined) ??
      (failureStderr === undefined
        ? undefined
        : sanitizeProviderDetail(failureStderr)) ??
      (cause instanceof Error
        ? sanitizeProviderDetail(cause.message)
        : undefined);
    return detail !== undefined && isTransientAgyFailure(detail);
  }

  #observeConversationId(value: unknown, allowEmpty: boolean): void {
    if (value === undefined) return;
    if (typeof value !== "string") {
      throw providerError(
        "agy protocol error: conversation_id must be a string",
      );
    }
    if (value.length === 0) {
      if (allowEmpty) return;
      throw providerError(
        "agy protocol error: conversation_id must be nonempty",
      );
    }
    if (this.#sessionId !== undefined && this.#sessionId !== value) {
      throw providerError(
        "agy protocol error: conflicting conversation_id observations",
      );
    }
    this.#sessionId = value;
  }

  #observeModel(value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0) {
      throw providerError(
        "agy protocol error: resolved model must be a nonempty string",
      );
    }
    if (this.#resolvedModel !== undefined && this.#resolvedModel !== value) {
      throw providerError(
        "agy protocol error: conflicting resolved model observations",
      );
    }
    this.#resolvedModel = value;
  }

  #recordToolStep(step: Record<string, unknown>): void {
    const stepIndex = step.step_index;
    if (typeof stepIndex === "number" && Number.isSafeInteger(stepIndex)) {
      if (this.#seenToolSteps.has(stepIndex)) return;
      this.#seenToolSteps.add(stepIndex);
    }
    if (step.step_type === "tool") {
      const toolInfo = isRecord(step.tool_info) ? step.tool_info : undefined;
      const toolName =
        typeof step.tool_name === "string" && step.tool_name.length > 0
          ? step.tool_name
          : typeof toolInfo?.name === "string" && toolInfo.name.length > 0
            ? toolInfo.name
            : undefined;
      if (toolName === undefined) return;
      const use: AgentToolUse = { tool: toolName };
      if (toolInfo !== undefined && Object.hasOwn(toolInfo, "parameters")) {
        use.input = summarizeToolPayload(toolInfo.parameters);
      }
      if (toolInfo !== undefined && toolInfo.error !== undefined) {
        const rawError = toolInfo.error;
        use.error = summarizeToolPayload(
          isRecord(rawError) && typeof rawError.message === "string"
            ? rawError.message
            : rawError,
        );
      }
      appendToolUse(this.#toolUses, use);
      return;
    }
    if (isRecord(step.subagent_info)) {
      appendToolUse(this.#toolUses, {
        tool: "subagent",
        input: summarizeToolPayload(step.subagent_info),
      });
    }
  }

  consume(value: unknown): void {
    if (this.#terminal !== undefined) {
      throw providerError("agy emitted an event after the terminal result");
    }
    if (!isRecord(value) || typeof value.event !== "string") {
      throw providerError("agy emitted an invalid event envelope");
    }
    switch (value.event) {
      case "init": {
        if (this.#initSeen || !isRecord(value.init)) {
          throw providerError("agy emitted an invalid init event");
        }
        this.#initSeen = true;
        this.#observeConversationId(value.conversation_id, false);
        this.#observeModel(value.init.model);
        break;
      }
      case "step_update": {
        if (!this.#initSeen || !isRecord(value.step_update)) {
          throw providerError("agy emitted an invalid step_update event");
        }
        const step = value.step_update;
        if (
          typeof step.state !== "string" ||
          typeof step.step_type !== "string"
        ) {
          throw providerError("agy step_update is missing state or step_type");
        }
        this.#observeConversationId(step.conversation_id, false);
        if (step.step_type !== "user_input") {
          this.#hasSubstantiveStep = true;
        }
        if (step.state === "DONE") {
          addUsage(this.#observedUsage, readUsage(step.usage));
          this.#recordToolStep(step);
        }
        break;
      }
      case "result": {
        if (
          !isRecord(value.result) ||
          typeof value.result.status !== "string"
        ) {
          throw providerError("agy emitted an invalid result event");
        }
        const result = value.result;
        const status = result.status;
        if (typeof status !== "string") {
          throw providerError("agy emitted an invalid result event");
        }
        const usage = readUsage(result.usage);
        if (status === "SUCCESS") {
          this.#observeConversationId(result.conversation_id, false);
          if (typeof result.response !== "string") {
            throw providerError("agy successful result is missing response");
          }
          const hasStructuredOutput = Object.hasOwn(
            result,
            "structured_output",
          );
          this.#terminal = {
            kind: "success",
            text: result.response,
            hasStructuredOutput,
            ...(hasStructuredOutput
              ? { structuredOutput: structuredClone(result.structured_output) }
              : {}),
            usage,
          };
          break;
        }
        this.#observeConversationId(result.conversation_id, true);
        const detail =
          typeof result.error === "string" && result.error.trim().length > 0
            ? sanitizeProviderDetail(result.error)
            : `status ${sanitizeProviderDetail(status)}`;
        this.#terminal = {
          kind: "error",
          detail,
          usage,
        };
        break;
      }
      default:
        // Forward-compatibility: ignore unrecognized future informational event names.
        break;
    }
  }

  finish(
    request: ProviderRequest,
    schema: PreparedProviderJsonSchema | undefined,
    fileResult?: { packet: string; path: string },
  ): ProviderOutcome {
    const observation = this.observation;
    const usage = this.usage;

    if (this.#terminal === undefined) {
      return {
        kind: "error",
        error: providerError("agy exited without a terminal result"),
        usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }

    if (this.#terminal.kind === "error") {
      const recoverable =
        !this.#hasSubstantiveStep &&
        hasOnlyZeroUsage(usage) &&
        isTransientAgyFailure(this.#terminal.detail);
      return {
        kind: "error",
        error: providerError(
          `agy turn failed: ${this.#terminal.detail}`,
          undefined,
          recoverable,
        ),
        usage: recoverable ? RETRYABLE_ZERO_USAGE : usage,
        ...(observation === undefined ? {} : { observation }),
      };
    }

    let completedText = this.#terminal.text;
    let structuredCandidate = this.#terminal.hasStructuredOutput
      ? this.#terminal.structuredOutput
      : undefined;

    if (fileResult !== undefined) {
      try {
        const reference =
          structuredCandidate !== undefined
            ? structuredCandidate
            : (JSON.parse(completedText) as unknown);
        if (
          !isRecord(reference) ||
          Object.keys(reference).length !== 1 ||
          reference.result_path !== fileResult.path
        ) {
          throw new TypeError("invalid result file reference");
        }
        completedText = fileResult.packet;
        structuredCandidate = JSON.parse(fileResult.packet) as unknown;
      } catch (error) {
        return {
          kind: "error",
          error: new AwslError(
            "SCHEMA_ERROR",
            "agy returned an invalid structured result file reference",
            {
              provider: "agy",
              recoverable: false,
              cause: error,
            },
          ),
          usage,
          ...(observation === undefined ? {} : { observation }),
        };
      }
    }

    const resolvedModel = this.#resolvedModel ?? request.model;
    const baseResult = {
      text: completedText,
      ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(this.#toolUses.length === 0 ? {} : { toolUses: [...this.#toolUses] }),
    };

    if (request.schema !== undefined) {
      try {
        const data =
          structuredCandidate !== undefined
            ? structuredCandidate
            : (JSON.parse(completedText) as unknown);
        if (schema === undefined || !schema.matches(data)) {
          return {
            kind: "error",
            error: new AwslError(
              "SCHEMA_ERROR",
              "agy structured result does not match the requested schema",
              {
                provider: "agy",
                recoverable: false,
              },
            ),
            usage,
            ...(observation === undefined ? {} : { observation }),
          };
        }
        return {
          kind: "completed",
          result: {
            ...baseResult,
            data,
          },
          usage,
          ...(observation === undefined ? {} : { observation }),
        };
      } catch (error) {
        return {
          kind: "error",
          error: new AwslError(
            "SCHEMA_ERROR",
            "agy returned invalid structured JSON",
            {
              provider: "agy",
              recoverable: false,
              cause: error,
            },
          ),
          usage,
          ...(observation === undefined ? {} : { observation }),
        };
      }
    }

    return {
      kind: "completed",
      result: baseResult,
      usage,
      ...(observation === undefined ? {} : { observation }),
    };
  }
}

function escapedAgentName(name: string): string {
  return name
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const STRUCTURED_OUTPUT_CONTRACT = [
  "<awsl-structured-output>",
  "Complete the requested task before emitting the final JSON value.",
  "Populate every collection from the actual task result. Return an empty collection only after verifying that no matching items exist.",
  "Do not truncate, summarize, or replace a large result with an empty collection. Use the available tools to derive the exact values when the task requests them.",
  "</awsl-structured-output>",
].join("\n");

export const AGY_FILE_PROMPT_BYTES = 128 * 1024;
export const AGY_FILE_RESULT_PROMPT_BYTES = 128 * 1024;

function fileResultContract(path: string, schemaPacket: string): string {
  return [
    "<awsl-file-result>",
    "The complete structured result may be too large for a single inline response.",
    `Write the exact UTF-8 JSON result to this file, replacing its current contents: ${JSON.stringify(path)}`,
    `The file contents must match this JSON Schema: ${schemaPacket}`,
    `After the file is written and verified, emit only this final JSON reference: ${JSON.stringify({ result_path: path })}`,
    "Do not embed the full result itself in the final response.",
    "</awsl-file-result>",
  ].join("\n");
}

function filePromptEnvelope(
  promptPath: string,
  fileResult?: { path: string; schemaPacket: string },
): string {
  const sections = [
    "<awsl-file-prompt>",
    "The complete prompt and instructions are stored in a local UTF-8 file to avoid inline message truncation.",
    `Read the full prompt from ${JSON.stringify(promptPath)} before taking any other action, and follow every instruction in that file.`,
    "</awsl-file-prompt>",
  ];
  if (fileResult !== undefined) {
    sections.push(fileResultContract(fileResult.path, fileResult.schemaPacket));
  }
  return sections.join("\n\n");
}

function providerPrompt(
  request: ProviderRequest,
  agent: NegotiatedAgentPolicy | undefined,
  fileResult?: { path: string; schemaPacket: string },
): string {
  const sections: string[] = [];
  if (agent !== undefined) {
    sections.push(
      [
        `<awsl-agent name="${escapedAgentName(agent.name)}">`,
        agent.instructions,
        "</awsl-agent>",
      ].join("\n"),
    );
  }
  if (request.schema !== undefined) sections.push(STRUCTURED_OUTPUT_CONTRACT);
  if (fileResult !== undefined) {
    sections.push(fileResultContract(fileResult.path, fileResult.schemaPacket));
  }
  sections.push(request.prompt);
  return sections.join("\n\n");
}

function streamInputPacket(content: string): string {
  return `${JSON.stringify({
    event: "user",
    message: { content },
  })}\n`;
}

async function readStructuredResultFile(path: string): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > COMPATIBILITY_PROFILE.providerProcess.maxNdjsonLineBytes
    ) {
      throw new TypeError("structured result file has an invalid size");
    }
    const bytes = await handle.readFile();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function cancelled(reason?: unknown): AwslError {
  return reason instanceof AwslError && reason.code === "CANCELLED"
    ? reason
    : new AwslError("CANCELLED", "agy provider call cancelled", {
        provider: "agy",
        recoverable: false,
        cause: reason,
      });
}

export type AgyProcessRunner = (
  options: RunProviderProcessOptions,
) => Promise<ProviderProcessResult>;

export interface AgyAdapterOptions {
  identity: ProviderIdentity;
  configuredArgs?: readonly string[];
  permissionMode?: AgyPermissionMode;
  processRunner?: AgyProcessRunner;
}

export class AgyAdapter implements ProviderAdapter {
  readonly id = "agy" as const;
  readonly capabilities = AGY_CAPABILITIES;
  readonly identity: ProviderIdentity;
  readonly #configuredArgs: readonly string[];
  readonly #permissionMode?: AgyPermissionMode;
  readonly #processRunner: AgyProcessRunner;

  constructor(options: AgyAdapterOptions) {
    const snapshot = snapshotAdapterOptions(options, "agy", [
      "identity",
      "configuredArgs",
      "permissionMode",
      "processRunner",
    ]);
    this.identity = snapshotProviderIdentity(snapshot.identity, "agy");
    this.#configuredArgs = validateProviderArgs(
      "agy",
      (snapshot.configuredArgs ?? []) as readonly string[],
    );
    this.#permissionMode =
      snapshot.permissionMode === undefined
        ? undefined
        : validateAgyPermissionMode(snapshot.permissionMode);
    if (
      Object.hasOwn(snapshot, "processRunner") &&
      typeof snapshot.processRunner !== "function"
    ) {
      throw new AwslError(
        "CONFIG_ERROR",
        "agy process runner must be an own data function",
        { recoverable: false },
      );
    }
    this.#processRunner =
      (snapshot.processRunner as AgyProcessRunner | undefined) ??
      runProviderProcess;
  }

  async run(request: ProviderRequest): Promise<ProviderOutcome> {
    if (request.signal.aborted) throw cancelled(request.signal.reason);
    const agent = validateAgentPolicy(request);

    const protocol = new AgyProtocol();
    let protocolFailure: AwslError | undefined;
    let failureStderr: string | undefined;
    let schema: PreparedProviderJsonSchema | undefined;
    let schemaArtifact: PrivateJsonFile | undefined;
    let resultArtifact: PrivateJsonFile | undefined;
    let promptArtifact: PrivateJsonFile | undefined;
    const additionalDirs: string[] = [];

    const initialPrompt = providerPrompt(request, agent);
    const largePrompt =
      Buffer.byteLength(initialPrompt, "utf8") >= AGY_FILE_PROMPT_BYTES;

    try {
      if (request.schema !== undefined) {
        const preparedSchema = prepareProviderJsonSchema(request.schema, {
          label: "agy structured output schema",
          provider: "agy",
        });
        schema = preparedSchema;
        try {
          let processSchema = preparedSchema;
          if (
            Buffer.byteLength(initialPrompt, "utf8") >=
            AGY_FILE_RESULT_PROMPT_BYTES
          ) {
            resultArtifact = await createPrivateJsonFile("null", {
              basename: "result.json",
              prefix: "awsl-agy-result-",
            });
            additionalDirs.push(resultArtifact.directory);
            processSchema = prepareProviderJsonSchema(
              {
                additionalProperties: false,
                properties: {
                  result_path: {
                    const: resultArtifact.path,
                    type: "string",
                  },
                },
                required: ["result_path"],
                type: "object",
              },
              {
                label: "agy structured result reference schema",
                provider: "agy",
              },
            );
          }
          schemaArtifact = await createPrivateJsonFile(processSchema.packet, {
            basename: "schema.json",
            prefix: "awsl-agy-schema-",
          });
        } catch (error) {
          if (error instanceof AwslError) throw error;
          throw new AwslError(
            "SCHEMA_ERROR",
            "Could not create the agy schema artifact",
            {
              provider: "agy",
              recoverable: false,
              cause: error,
            },
          );
        }
      }

      const fileResultSpec =
        resultArtifact === undefined || schema === undefined
          ? undefined
          : { path: resultArtifact.path, schemaPacket: schema.packet };
      const fullPrompt = providerPrompt(request, agent, fileResultSpec);

      let stdinContent = fullPrompt;
      if (largePrompt) {
        promptArtifact = await createPrivateJsonFile(fullPrompt, {
          basename: "prompt.txt",
          prefix: "awsl-agy-prompt-",
        });
        additionalDirs.push(promptArtifact.directory);
        stdinContent = filePromptEnvelope(promptArtifact.path, fileResultSpec);
      }

      await this.#processRunner({
        executable: this.identity.executableRealpath,
        argv: buildAgyArgv({
          configuredArgs: this.#configuredArgs,
          model: request.model,
          effort: request.effort,
          permissionMode: this.#permissionMode ?? agent?.permissionMode,
          schemaPath: schemaArtifact?.path,
          additionalDirs,
        }),
        cwd: request.cwd,
        prompt: streamInputPacket(stdinContent),
        signal: request.signal,
        onFailureStderr: (stderrTail) => {
          failureStderr = stderrTail.toString("utf8");
        },
        onEvent: async (event) => {
          try {
            protocol.consume(event);
          } catch (error) {
            protocolFailure =
              error instanceof AwslError
                ? error
                : providerError("agy protocol validation failed", error);
            throw protocolFailure;
          }
          await request.onRawEvent?.(event);
        },
      });

      const fileResult =
        resultArtifact === undefined
          ? undefined
          : {
              packet: await readStructuredResultFile(resultArtifact.path),
              path: resultArtifact.path,
            };
      return protocol.finish(request, schema, fileResult);
    } catch (error) {
      if (error instanceof AwslError && error.code === "CANCELLED") throw error;
      if (
        protocolFailure === undefined &&
        !(error instanceof AwslError && error.code === "PERSISTENCE_ERROR") &&
        protocol.hasTerminalError
      ) {
        return protocol.finish(request, schema);
      }
      const recoverable =
        protocolFailure === undefined &&
        protocol.retryableTransportFailure(error, failureStderr);
      return {
        kind: "error",
        error:
          (error instanceof AwslError && error.code === "PERSISTENCE_ERROR"
            ? error
            : protocolFailure) ??
          providerError("agy process transport failed", error, recoverable),
        usage: recoverable ? RETRYABLE_ZERO_USAGE : protocol.usage,
        ...(protocol.observation === undefined
          ? {}
          : { observation: protocol.observation }),
      };
    } finally {
      await promptArtifact?.dispose();
      await schemaArtifact?.dispose();
      await resultArtifact?.dispose();
    }
  }
}
