import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import {
  validateCodexProfile,
  validateProviderArgs,
} from "../config/model-map.js";
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
  createPrivateJsonFile,
  prepareCodexJsonSchema,
} from "./schema.js";

export const CODEX_CAPABILITIES: ProviderCapabilities = Object.freeze({
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
  permissionModes: Object.freeze([]),
  sandboxModes: Object.freeze([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const),
  skills: false,
  structuredAttemptEvents: false,
  resolvedModelEvents: false,
});

export interface CodexArgvOptions {
  configuredArgs?: readonly string[];
  profile?: string;
  model?: string;
  effort?: AgentEffort;
  sandboxMode?: NegotiatedAgentPolicy["sandboxMode"];
}

const CODEX_SANDBOX_MODES = new Set<
  NonNullable<NegotiatedAgentPolicy["sandboxMode"]>
>(["read-only", "workspace-write", "danger-full-access"]);

export function buildCodexArgv(
  options: CodexArgvOptions,
  schemaPath?: string,
): string[] {
  const configuredArgs = validateProviderArgs(
    "codex",
    options.configuredArgs ?? [],
  );
  const profile =
    options.profile === undefined
      ? undefined
      : validateCodexProfile(options.profile);
  const argv: string[] = [];
  if (profile !== undefined) argv.push("--profile", profile);
  argv.push(...configuredArgs);
  if (options.model !== undefined) {
    argv.push("-m", options.model);
  }
  if (options.effort !== undefined) {
    argv.push("-c", `model_reasoning_effort="${options.effort}"`);
  }
  if (options.sandboxMode !== undefined) {
    if (!CODEX_SANDBOX_MODES.has(options.sandboxMode))
      throw compatibilityError(
        "Codex does not support the requested sandbox mode",
      );
    argv.push("--sandbox", options.sandboxMode);
  }
  argv.push("exec", "--json", "--skip-git-repo-check");
  if (schemaPath !== undefined) {
    argv.push("--output-schema", schemaPath);
  }
  argv.push("-");
  return argv;
}

export type CodexProcessRunner = (
  options: RunProviderProcessOptions,
) => Promise<ProviderProcessResult>;

function compatibilityError(message: string): AwslError {
  return new AwslError("COMPATIBILITY_ERROR", message, {
    provider: "codex",
    recoverable: false,
  });
}

function providerError(
  message: string,
  cause?: unknown,
  recoverable = false,
): AwslError {
  return new AwslError("PROVIDER_ERROR", message, {
    provider: "codex",
    recoverable,
    cause,
  });
}

function snapshotAgentRecord(
  agent: NegotiatedAgentPolicy,
): Record<string, unknown> {
  try {
    const snapshot = strictJsonClone(agent, "Codex agent policy");
    if (!isRecord(snapshot)) throw new TypeError();
    return snapshot;
  } catch {
    throw compatibilityError(
      "Codex agent policy must contain only exact JSON data",
    );
  }
}

function validateAgentPolicy(
  request: ProviderRequest,
): NegotiatedAgentPolicy | undefined {
  if (request.model !== undefined) {
    if (
      typeof request.model !== "string" ||
      request.model.trim().length === 0 ||
      request.model.includes("\0")
    )
      throw compatibilityError(
        "Codex model must be a nonempty CLI-safe string",
      );
  }
  if (
    request.effort !== undefined &&
    !new Set(["low", "medium", "high", "xhigh", "max"]).has(request.effort)
  )
    throw compatibilityError("Codex does not support the requested effort");
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
  )
    throw compatibilityError("Codex agent policy is invalid");

  const skillsPresent = Object.hasOwn(agent, "skills");
  const skills = agent.skills;
  if (skillsPresent && (!Array.isArray(skills) || skills.length !== 0))
    throw compatibilityError("Codex cannot preserve agent skills");

  if (Object.hasOwn(agent, "tools")) {
    throw compatibilityError(
      "Codex cannot preserve the named-agent tool allowlist",
    );
  }
  if (Object.hasOwn(agent, "disallowedTools")) {
    throw compatibilityError(
      "Codex cannot preserve the named-agent tool denylist",
    );
  }
  if (Object.hasOwn(agent, "mcp")) {
    throw compatibilityError(
      "Codex cannot preserve the named-agent MCP policy",
    );
  }
  if (Object.hasOwn(agent, "permissionMode")) {
    throw compatibilityError(
      "Codex cannot preserve the named-agent permission mode",
    );
  }
  let sandboxMode: NegotiatedAgentPolicy["sandboxMode"];
  if (Object.hasOwn(agent, "sandboxMode")) {
    const rawSandboxMode = agent.sandboxMode;
    if (
      typeof rawSandboxMode !== "string" ||
      !CODEX_SANDBOX_MODES.has(
        rawSandboxMode as NonNullable<NegotiatedAgentPolicy["sandboxMode"]>,
      )
    )
      throw compatibilityError("Codex agent sandbox mode is invalid");
    sandboxMode = rawSandboxMode as NonNullable<
      NegotiatedAgentPolicy["sandboxMode"]
    >;
  }
  return Object.freeze({
    instructions,
    name,
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventType(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") {
    throw providerError("Codex emitted an invalid event envelope");
  }
  return event.type;
}

function token(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function parseUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) return { complete: false };
  const inputTokens = token(value.input_tokens);
  const cachedInputTokens = token(value.cached_input_tokens);
  const outputTokens = token(value.output_tokens);
  const reasoningTokens = token(value.reasoning_output_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    complete: outputTokens !== undefined,
  };
}

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

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return sanitizeProviderDetail(value);
  if (isRecord(value) && typeof value.message === "string") {
    return sanitizeProviderDetail(value.message);
  }
  return undefined;
}

const TRANSIENT_CODEX_FAILURE =
  /(?:\b(?:408|429|500|502|503|504)\b|bad gateway|gateway timeout|service unavailable|temporarily unavailable|connection (?:closed|refused|reset)|connection reset by peer|econnreset|etimedout|network error|request timed out|upstream (?:connect|error|failure)|timeout)/i;

function isTransientCodexFailure(value: string): boolean {
  return TRANSIENT_CODEX_FAILURE.test(value);
}

function isCodexInitializationWarning(
  eventType: string,
  item: Record<string, unknown>,
  beforeTurn: boolean,
): boolean {
  return (
    eventType === "item.completed" &&
    item.type === "error" &&
    (beforeTurn ||
      (typeof item.message === "string" &&
        item.message.startsWith("Skill descriptions were shortened to fit")))
  );
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

const ITEM_TYPES = new Set([
  "agent_message",
  "command_execution",
  "error",
  "file_change",
  "mcp_tool_call",
  "reasoning",
  "todo_list",
  "web_search",
]);

class CodexProtocol {
  #completedText?: string;
  #lastCriticalError?: string;
  #observation: ProviderObservation = {};
  #terminal?: "completed" | "failed";
  #terminalError?: AwslError;
  #threadStarted = false;
  #turnStarted = false;
  #hasSubstantiveItem = false;
  #usage: ProviderUsage = { complete: false };

  get observation(): ProviderObservation | undefined {
    return Object.keys(this.#observation).length === 0
      ? undefined
      : { ...this.#observation };
  }

  get usage(): ProviderUsage {
    return { ...this.#usage };
  }

  retryableTransportFailure(cause: unknown, failureStderr?: string): boolean {
    if (this.#hasSubstantiveItem || !hasOnlyZeroUsage(this.#usage))
      return false;
    const detail =
      this.#lastCriticalError ??
      (failureStderr === undefined
        ? undefined
        : sanitizeProviderDetail(failureStderr)) ??
      (cause instanceof Error
        ? sanitizeProviderDetail(cause.message)
        : undefined);
    return detail !== undefined && isTransientCodexFailure(detail);
  }

  consume(event: unknown): void {
    if (this.#terminal !== undefined) {
      throw providerError("Codex emitted an event after the terminal event");
    }

    const type = eventType(event);
    const object = event as Record<string, unknown>;
    switch (type) {
      case "thread.started": {
        if (
          this.#threadStarted ||
          typeof object.thread_id !== "string" ||
          object.thread_id.length === 0
        ) {
          throw providerError("Codex emitted an invalid thread.started event");
        }
        this.#threadStarted = true;
        this.#observation.threadId = object.thread_id;
        break;
      }
      case "turn.started": {
        if (!this.#threadStarted || this.#turnStarted) {
          throw providerError("Codex emitted an invalid turn.started event");
        }
        this.#turnStarted = true;
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!this.#threadStarted || !isRecord(object.item)) {
          throw providerError(`Codex emitted an invalid ${type} event`);
        }
        const item = object.item;
        if (
          typeof item.type !== "string" ||
          !ITEM_TYPES.has(item.type) ||
          typeof item.id !== "string" ||
          item.id.length === 0
        ) {
          throw providerError(`Codex emitted an unsupported ${type} item`);
        }
        const isInitializationWarning = isCodexInitializationWarning(
          type,
          item,
          !this.#turnStarted,
        );
        if (!this.#turnStarted && !isInitializationWarning) {
          throw providerError(`Codex emitted ${type} before turn.started`);
        }
        if (!isInitializationWarning) this.#hasSubstantiveItem = true;
        if (type === "item.completed" && item.type === "agent_message") {
          if (typeof item.text !== "string") {
            throw providerError(
              "Codex completed an agent message without text",
            );
          }
          this.#completedText = item.text;
        }
        break;
      }
      case "error": {
        this.#lastCriticalError =
          errorMessage(object.message) ??
          errorMessage(object.error) ??
          "Codex reported an unspecified top-level error";
        break;
      }
      case "turn.completed": {
        if (!this.#turnStarted || this.#completedText === undefined) {
          throw providerError(
            "Codex completed a turn without a completed agent message",
          );
        }
        this.#usage = parseUsage(object.usage);
        this.#terminal = "completed";
        break;
      }
      case "turn.failed": {
        if (!this.#turnStarted) {
          throw providerError("Codex failed a turn before turn.started");
        }
        this.#usage = parseUsage(object.usage);
        this.#terminal = "failed";
        const detail =
          errorMessage(object.error) ??
          errorMessage(object.message) ??
          this.#lastCriticalError ??
          "unspecified turn failure";
        const recoverable =
          !this.#hasSubstantiveItem &&
          hasOnlyZeroUsage(this.#usage) &&
          isTransientCodexFailure(detail);
        if (recoverable) this.#usage = RETRYABLE_ZERO_USAGE;
        this.#terminalError = providerError(
          `Codex turn failed: ${detail}`,
          undefined,
          recoverable,
        );
        break;
      }
      default:
        throw providerError(`Codex emitted unsupported event type "${type}"`);
    }
  }

  finish(
    request: ProviderRequest,
    schema: PreparedProviderJsonSchema | undefined,
    fileResult?: { packet: string; path: string },
  ): ProviderOutcome {
    if (this.#terminal === "failed") {
      return {
        kind: "error",
        error:
          this.#terminalError ??
          providerError("Codex turn failed without an error"),
        usage: this.usage,
        ...(this.observation === undefined
          ? {}
          : { observation: this.observation }),
      };
    }
    if (this.#terminal !== "completed" || this.#completedText === undefined) {
      const suffix =
        this.#lastCriticalError === undefined
          ? "without a terminal event"
          : `after reporting: ${this.#lastCriticalError}`;
      const recoverable =
        this.#lastCriticalError !== undefined &&
        this.retryableTransportFailure(this.#lastCriticalError);
      return {
        kind: "error",
        error: providerError(
          `Codex stream ended ${suffix}`,
          undefined,
          recoverable,
        ),
        usage: recoverable ? RETRYABLE_ZERO_USAGE : this.usage,
        ...(this.observation === undefined
          ? {}
          : { observation: this.observation }),
      };
    }

    let completedText = this.#completedText;
    if (fileResult !== undefined) {
      try {
        const reference = JSON.parse(completedText) as unknown;
        if (
          !isRecord(reference) ||
          Object.keys(reference).length !== 1 ||
          reference.result_path !== fileResult.path
        ) {
          throw new TypeError("invalid result file reference");
        }
        completedText = fileResult.packet;
      } catch (error) {
        return {
          kind: "error",
          error: new AwslError(
            "SCHEMA_ERROR",
            "Codex returned an invalid structured result file reference",
            {
              provider: "codex",
              recoverable: false,
              cause: error,
            },
          ),
          usage: this.usage,
          ...(this.observation === undefined
            ? {}
            : { observation: this.observation }),
        };
      }
    }
    const result = {
      text: completedText,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    };
    if (request.schema !== undefined) {
      try {
        const data = JSON.parse(completedText) as unknown;
        if (schema === undefined || !schema.matches(data)) {
          return {
            kind: "error",
            error: new AwslError(
              "SCHEMA_ERROR",
              "Codex structured result does not match the requested schema",
              {
                provider: "codex",
                recoverable: false,
              },
            ),
            usage: this.usage,
            ...(this.observation === undefined
              ? {}
              : { observation: this.observation }),
          };
        }
        return {
          kind: "completed",
          result: {
            ...result,
            data,
          },
          usage: this.usage,
          ...(this.observation === undefined
            ? {}
            : { observation: this.observation }),
        };
      } catch (error) {
        return {
          kind: "error",
          error: new AwslError(
            "SCHEMA_ERROR",
            "Codex returned invalid structured JSON",
            {
              provider: "codex",
              recoverable: false,
              cause: error,
            },
          ),
          usage: this.usage,
          ...(this.observation === undefined
            ? {}
            : { observation: this.observation }),
        };
      }
    }
    return {
      kind: "completed",
      result,
      usage: this.usage,
      ...(this.observation === undefined
        ? {}
        : { observation: this.observation }),
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

export const CODEX_FILE_RESULT_PROMPT_BYTES = 256 * 1024;

function fileResultContract(path: string, schemaPacket: string): string {
  return [
    "<awsl-file-result>",
    "The complete structured result may be too large for the final response.",
    `Write the exact JSON result to this file, replacing its current contents: ${JSON.stringify(path)}`,
    `The file contents must match this JSON Schema: ${schemaPacket}`,
    `After the file is complete, emit only this final JSON reference: ${JSON.stringify({ result_path: path })}`,
    "Do not embed the result itself in the final response.",
    "</awsl-file-result>",
  ].join("\n");
}

function providerPrompt(
  request: ProviderRequest,
  agent: NegotiatedAgentPolicy | undefined,
  fileResult?: { path: string; schemaPacket: string },
): string {
  const sections: string[] = [];
  if (agent) {
    sections.push(
      [
        `<awsl-agent name="${escapedAgentName(agent.name)}">`,
        agent.instructions,
        "</awsl-agent>",
      ].join("\n"),
    );
  }
  if (request.schema !== undefined) sections.push(STRUCTURED_OUTPUT_CONTRACT);
  if (fileResult !== undefined)
    sections.push(fileResultContract(fileResult.path, fileResult.schemaPacket));
  sections.push(request.prompt);
  return sections.join("\n\n");
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
    : new AwslError("CANCELLED", "Codex provider call cancelled", {
        provider: "codex",
        recoverable: false,
        cause: reason,
      });
}

export interface CodexAdapterOptions {
  identity: ProviderIdentity;
  configuredArgs?: readonly string[];
  profile?: string;
  processRunner?: CodexProcessRunner;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly identity: ProviderIdentity;
  readonly #processRunner: CodexProcessRunner;
  readonly #configuredArgs: readonly string[];
  readonly #profile?: string;

  constructor(options: CodexAdapterOptions) {
    const snapshot = snapshotAdapterOptions(options, "codex", [
      "identity",
      "configuredArgs",
      "profile",
      "processRunner",
    ]);
    this.identity = snapshotProviderIdentity(snapshot.identity, "codex");
    this.#configuredArgs = validateProviderArgs(
      "codex",
      (snapshot.configuredArgs ?? []) as readonly string[],
    );
    this.#profile =
      snapshot.profile === undefined
        ? undefined
        : validateCodexProfile(snapshot.profile);
    if (
      Object.hasOwn(snapshot, "processRunner") &&
      typeof snapshot.processRunner !== "function"
    )
      throw new AwslError(
        "CONFIG_ERROR",
        "codex process runner must be an own data function",
        { recoverable: false },
      );
    this.#processRunner =
      (snapshot.processRunner as CodexProcessRunner | undefined) ??
      runProviderProcess;
  }

  async run(request: ProviderRequest): Promise<ProviderOutcome> {
    if (request.signal.aborted) throw cancelled(request.signal.reason);
    const agent = validateAgentPolicy(request);

    const protocol = new CodexProtocol();
    let protocolFailure: AwslError | undefined;
    let failureStderr: string | undefined;
    let schema: PreparedProviderJsonSchema | undefined;
    let schemaArtifact:
      | Awaited<ReturnType<typeof createPrivateJsonFile>>
      | undefined;
    let resultArtifact:
      | Awaited<ReturnType<typeof createPrivateJsonFile>>
      | undefined;
    let processSchema: PreparedProviderJsonSchema | undefined;

    if (request.schema !== undefined) {
      const preparedSchema = prepareCodexJsonSchema(request.schema, {
        label: "structured output schema",
      });
      schema = preparedSchema;
      const basePrompt = providerPrompt(request, agent);
      try {
        if (
          Buffer.byteLength(basePrompt, "utf8") >=
          CODEX_FILE_RESULT_PROMPT_BYTES
        ) {
          resultArtifact = await createPrivateJsonFile("null", {
            basename: "result.json",
            prefix: "awsl-codex-result-",
          });
          processSchema = prepareCodexJsonSchema(
            {
              additionalProperties: false,
              properties: {
                result_path: {
                  enum: [resultArtifact.path],
                  type: "string",
                },
              },
              required: ["result_path"],
              type: "object",
            },
            { label: "structured result reference schema" },
          );
        } else {
          processSchema = preparedSchema;
        }
        schemaArtifact = await createPrivateJsonFile(processSchema.packet, {
          basename: "schema.json",
          prefix: "awsl-codex-schema-",
        });
      } catch (error) {
        if (error instanceof AwslError) throw error;
        throw new AwslError(
          "SCHEMA_ERROR",
          "Could not create the Codex schema artifact",
          {
            provider: "codex",
            recoverable: false,
            cause: error,
          },
        );
      }
    }

    try {
      await this.#processRunner({
        argv: buildCodexArgv(
          {
            configuredArgs: this.#configuredArgs,
            profile: this.#profile,
            effort: request.effort,
            model: request.model,
            sandboxMode: agent?.sandboxMode,
          },
          schemaArtifact?.path,
        ),
        cwd: request.cwd,
        executable: this.identity.executableRealpath,
        prompt: providerPrompt(
          request,
          agent,
          resultArtifact === undefined || schema === undefined
            ? undefined
            : { path: resultArtifact.path, schemaPacket: schema.packet },
        ),
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
                : providerError("Codex protocol validation failed", error);
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
      const recoverable =
        protocolFailure === undefined &&
        protocol.retryableTransportFailure(error, failureStderr);
      return {
        kind: "error",
        error:
          (error instanceof AwslError && error.code === "PERSISTENCE_ERROR"
            ? error
            : protocolFailure) ??
          providerError("Codex process transport failed", error, recoverable),
        usage: recoverable ? RETRYABLE_ZERO_USAGE : protocol.usage,
        ...(protocol.observation === undefined
          ? {}
          : { observation: protocol.observation }),
      };
    } finally {
      await schemaArtifact?.dispose();
      await resultArtifact?.dispose();
    }
  }
}
