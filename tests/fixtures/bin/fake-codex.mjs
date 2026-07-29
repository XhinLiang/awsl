#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

const log = async (kind) => {
  if (process.env.AWSL_FAKE_CODEX_LOG)
    await appendFile(process.env.AWSL_FAKE_CODEX_LOG, `${kind}\n`);
};

if (process.argv.slice(2).includes("--version")) {
  await log("version");
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}

await log("run");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.AWSL_FAKE_CODEX_CAPTURE) {
  await appendFile(
    process.env.AWSL_FAKE_CODEX_CAPTURE,
    `${JSON.stringify({ argv: process.argv.slice(2), prompt })}\n`,
  );
}
const delay = Number(process.env.AWSL_FAKE_CODEX_DELAY_MS ?? 0);
if (Number.isFinite(delay) && delay > 0)
  await new Promise((resolve) => setTimeout(resolve, delay));

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: "fake-thread" });
emit({ type: "turn.started" });
if (process.env.AWSL_FAKE_CODEX_FAIL === "1") {
  emit({
    type: "turn.failed",
    error: { message: "fixture failure" },
    usage: {
      input_tokens: 3,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
  });
  process.exit(0);
}
emit({
  type: "item.completed",
  item: {
    id: "message-1",
    type: "agent_message",
    text: prompt.includes("return-json") ? '{"answer":"FAKE"}' : "FAKE",
  },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 3,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
});
