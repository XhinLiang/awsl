import { readRegularUtf8Text } from "../config/paths.js";
import { canonicalJson } from "../core/canonical-json.js";
import { AwslError } from "../core/errors.js";
import { strictJsonClone } from "../core/strict-json.js";
import { parseUniqueJson } from "../core/unique-json.js";

export type OutputFormat = "auto" | "pretty" | "jsonl" | "json";
export type ResolvedOutputFormat = Exclude<OutputFormat, "auto">;

export interface StdinInput {
  readonly isTTY: boolean;
  read(): Promise<string>;
}

export interface ResolveArgsInputOptions {
  readonly cwd: string;
  readonly argsText?: string;
  readonly argsFile?: string;
  readonly stdin: StdinInput;
}

export type ResolvedArgsInput =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown };

export interface ParsedResume {
  readonly runId: string;
  readonly argsPresent: boolean;
  readonly args?: unknown;
  readonly argsFile?: string;
  readonly budget?: number;
  readonly format?: OutputFormat;
}

export const MAX_ARGS_BYTES = 512 * 1024;
const runToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const formats = new Set<OutputFormat>(["auto", "pretty", "jsonl", "json"]);
const pinnedResumeOptions = new Set([
  "--provider",
  "--cwd",
  "--profile",
  "--model",
  "--executable",
  "--compatibility-profile",
]);

function usage(message: string): never {
  throw new AwslError("USAGE_ERROR", message, { recoverable: false });
}

function oneValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    usage(`${option} requires one value`);
  return value;
}

export function parseBudget(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    usage("budget must be a nonnegative safe integer");
  return Number(value);
}

export function parseOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string" || !formats.has(value as OutputFormat))
    usage("format must be auto, pretty, jsonl, or json");
  return value as OutputFormat;
}

export function parseJsonArgs(source: string): unknown {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > MAX_ARGS_BYTES
  )
    usage("workflow arguments exceed the byte limit");
  try {
    const value = strictJsonClone(
      parseUniqueJson(source),
      "workflow arguments",
    );
    canonicalJson(value);
    return value;
  } catch {
    usage("workflow arguments must be unique-key strict JSON");
  }
}

export function parseResume(argv: readonly string[]): ParsedResume {
  const runId = argv[0];
  if (typeof runId !== "string" || !runToken.test(runId))
    usage("resume requires a safe run identifier");
  let argsText: string | undefined;
  let argsFile: string | undefined;
  let budget: number | undefined;
  let format: OutputFormat | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const separator = token.indexOf("=");
    const option = separator === -1 ? token : token.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : token.slice(separator + 1);
    const pinned = [...pinnedResumeOptions].find(
      (candidate) => option === candidate,
    );
    if (pinned !== undefined) usage(`${pinned.slice(2)} is pinned for resume`);
    if (!["--args", "--args-file", "--budget", "--format"].includes(option))
      usage("unknown resume option");
    if (seen.has(option)) usage(`${option} may be supplied only once`);
    seen.add(option);
    const value =
      inlineValue === undefined ? oneValue(argv, index, option) : inlineValue;
    if (value.length === 0) usage(`${option} requires one value`);
    if (inlineValue === undefined) index += 1;
    if (option === "--args") argsText = value;
    else if (option === "--args-file") argsFile = value;
    else if (option === "--budget") budget = parseBudget(value);
    else format = parseOutputFormat(value);
  }
  if (argsText !== undefined && argsFile !== undefined)
    usage("workflow argument sources are mutually exclusive");
  return Object.freeze({
    runId,
    argsPresent: argsText !== undefined || argsFile !== undefined,
    ...(argsText === undefined ? {} : { args: parseJsonArgs(argsText) }),
    ...(argsFile === undefined ? {} : { argsFile }),
    ...(budget === undefined ? {} : { budget }),
    ...(format === undefined ? {} : { format }),
  });
}

export async function resolveArgsInput(
  options: ResolveArgsInputOptions,
): Promise<ResolvedArgsInput> {
  const explicitSources =
    Number(options.argsText !== undefined) +
    Number(options.argsFile !== undefined);
  if (explicitSources > 1)
    usage("workflow argument sources are mutually exclusive");

  const stdinText =
    options.argsFile === "-" || !options.stdin.isTTY
      ? await options.stdin.read()
      : undefined;
  if (
    stdinText !== undefined &&
    Buffer.byteLength(stdinText, "utf8") > MAX_ARGS_BYTES
  )
    usage("workflow arguments exceed the byte limit");
  const automaticStdin =
    options.argsFile !== "-" &&
    !options.stdin.isTTY &&
    stdinText !== undefined &&
    stdinText.trim().length > 0;
  if (explicitSources > 0 && automaticStdin)
    usage("workflow argument sources are mutually exclusive");

  let source: string | undefined;
  if (options.argsText !== undefined) source = options.argsText;
  else if (options.argsFile === "-") source = stdinText ?? "";
  else if (options.argsFile !== undefined)
    source = (
      await readRegularUtf8Text(options.argsFile, options.cwd, MAX_ARGS_BYTES)
    ).source;
  else if (automaticStdin) source = stdinText;
  if (source === undefined) return Object.freeze({ present: false });
  return Object.freeze({ present: true, value: parseJsonArgs(source) });
}
