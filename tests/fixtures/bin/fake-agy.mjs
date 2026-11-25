#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) {
  process.stdout.write(`${process.env.AWSL_FAKE_AGY_VERSION || "1.5.16"}\n`);
  process.exit(0);
}

const stdinText = readFileSync(0, "utf8");
if (process.env.AWSL_FAKE_AGY_CAPTURE) {
  appendFileSync(
    process.env.AWSL_FAKE_AGY_CAPTURE,
    `${JSON.stringify({ argv, cwd: process.cwd(), stdin: stdinText })}\n`,
    "utf8",
  );
}

let model;
let schemaPath;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--model" && argv[i + 1]) model = argv[++i];
  else if (argv[i] === "--json-schema" && argv[i + 1]) schemaPath = argv[++i];
}

const firstLine = stdinText.trim().split("\n")[0] || "{}";
const envelope = JSON.parse(firstLine);
const content =
  typeof envelope?.message?.content === "string"
    ? envelope.message.content
    : "";

let effectivePrompt = content;
const filePromptMatch = /Read the full prompt from "([^"]+)"/.exec(content);
if (filePromptMatch?.[1]) {
  effectivePrompt = readFileSync(filePromptMatch[1], "utf8");
}

const fileResultMatch =
  /Write the exact UTF-8 JSON result to this file, replacing its current contents: "([^"]+)"/.exec(
    effectivePrompt,
  );

const conversationId = "fake-agy-conv-001";
const writeEvent = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

writeEvent({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: process.cwd(),
    tools: ["run_command", "view_file", "write_to_file"],
    permission_mode: argv.includes("--dangerously-skip-permissions")
      ? "always-proceed"
      : "request-review",
    ...(model ? { model } : {}),
    ...(schemaPath
      ? { json_schema: JSON.parse(readFileSync(schemaPath, "utf8")) }
      : {}),
  },
});

writeEvent({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: 0,
    state: "DONE",
    step_type: "user_input",
  },
});

writeEvent({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    state: "DONE",
    step_type: "tool",
    tool_name: "view_file",
    tool_info: {
      name: "view_file",
      parameters: { Path: "README.md" },
      output: "ok",
    },
  },
});

let responseText = `echo:${effectivePrompt.slice(-32)}`;
let structuredOutput;

if (fileResultMatch?.[1]) {
  const resultPath = fileResultMatch[1];
  const payload = { ok: true, length: effectivePrompt.length };
  writeFileSync(resultPath, JSON.stringify(payload), "utf8");
  structuredOutput = { result_path: resultPath };
  responseText = JSON.stringify(structuredOutput);
} else if (schemaPath) {
  structuredOutput = { ok: true, echo: effectivePrompt.slice(-16) };
  responseText = JSON.stringify(structuredOutput);
}

writeEvent({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: 2,
    state: "DONE",
    step_type: "agent_response",
    text_delta: responseText,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      thinking_tokens: 2,
      cache_read_tokens: 4,
      total_tokens: 17,
    },
  },
});

writeEvent({
  event: "result",
  result: {
    conversation_id: conversationId,
    status: "SUCCESS",
    response: responseText,
    duration_seconds: 0.1,
    num_turns: 1,
    ...(structuredOutput === undefined
      ? {}
      : { structured_output: structuredOutput }),
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      thinking_tokens: 2,
      cache_read_tokens: 4,
      total_tokens: 17,
    },
  },
});
