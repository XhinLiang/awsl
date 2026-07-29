import { canonicalJson } from "../core/canonical-json.js";
import { AwslError } from "../core/errors.js";
import type { AwslEvent } from "../core/events.js";
import { strictJsonClone } from "../core/strict-json.js";
import { redactJson } from "../store/redact.js";
import type { OutputFormat, ResolvedOutputFormat } from "./args.js";

export interface OutputControllerOptions {
  readonly format: OutputFormat;
  readonly stdoutIsTTY: boolean;
  readonly writeStdout: (value: string) => void | Promise<void>;
  readonly writeStderr: (value: string) => void | Promise<void>;
}

export interface CompletionEnvelope {
  readonly runId: string;
  readonly status: string;
  readonly result?: unknown;
  readonly [key: string]: unknown;
}

export interface OutputController {
  readonly format: ResolvedOutputFormat;
  event(event: AwslEvent): Promise<void>;
  complete(envelope: CompletionEnvelope): Promise<void>;
}

function prettyEvent(event: AwslEvent): string {
  const data =
    event.data !== null && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : undefined;
  const message = data?.message;
  if (typeof message === "string") return `${message}\n`;
  const phase = data?.phase;
  if (typeof phase === "string") return `[${event.type}] ${phase}\n`;
  return `[${event.type}]\n`;
}

function safeEvent(value: AwslEvent): AwslEvent {
  try {
    return strictJsonClone(
      redactJson(strictJsonClone(value, "CLI event")),
      "redacted CLI event",
    ) as AwslEvent;
  } catch {
    throw new AwslError("PERSISTENCE_ERROR", "could not render event safely", {
      recoverable: false,
    });
  }
}

export function createOutputController(
  options: OutputControllerOptions,
): OutputController {
  const format: ResolvedOutputFormat =
    options.format === "auto"
      ? options.stdoutIsTTY
        ? "pretty"
        : "jsonl"
      : options.format;
  return Object.freeze({
    format,
    event: async (rawEvent: AwslEvent) => {
      const event = safeEvent(rawEvent);
      if (format === "jsonl")
        await options.writeStdout(`${canonicalJson(event)}\n`);
      else if (format === "pretty")
        await options.writeStderr(prettyEvent(event));
    },
    complete: async (envelope: CompletionEnvelope) => {
      if (format === "json")
        await options.writeStdout(`${canonicalJson(envelope)}\n`);
      else if (format === "pretty" && Object.hasOwn(envelope, "result")) {
        const result = envelope.result;
        await options.writeStdout(
          typeof result === "string"
            ? `${result}\n`
            : `${canonicalJson(result)}\n`,
        );
      }
    },
  });
}
