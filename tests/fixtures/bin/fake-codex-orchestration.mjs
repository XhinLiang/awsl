#!/usr/bin/env node

import { readFile } from "node:fs/promises";

if (process.argv.slice(2).includes("--version")) {
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}

for await (const _chunk of process.stdin) {
  // Drain the prompt without interpreting source-specific prose.
}

const schemaFlag = process.argv.indexOf("--output-schema");
if (schemaFlag < 0 || process.argv[schemaFlag + 1] === undefined) {
  process.stderr.write("missing output schema\n");
  process.exit(2);
}

const schema = JSON.parse(await readFile(process.argv[schemaFlag + 1], "utf8"));
const properties = schema.properties;
if (
  schema.type !== "object" ||
  schema.additionalProperties !== false ||
  !Array.isArray(schema.required) ||
  properties === null ||
  typeof properties !== "object"
) {
  process.stderr.write("unsupported fixture schema\n");
  process.exit(2);
}

const result = {};
for (const name of schema.required) {
  const rule = properties[name];
  if (
    typeof name !== "string" ||
    rule === null ||
    typeof rule !== "object" ||
    !Object.hasOwn(rule, "const")
  ) {
    process.stderr.write("unsupported fixture schema\n");
    process.exit(2);
  }
  result[name] = rule.const;
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: "orchestration-thread" });
emit({ type: "turn.started" });
emit({
  type: "item.completed",
  item: {
    id: "message-1",
    type: "agent_message",
    text: JSON.stringify(result),
  },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
});
