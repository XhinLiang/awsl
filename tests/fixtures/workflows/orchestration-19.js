export const meta = {
  name: "orchestration-19",
  description: "Exercise a fixed multi-phase agent graph",
  phases: [
    { title: "setup", detail: "Prepare two inputs" },
    { title: "summarize", detail: "Run shards and summaries" },
    { title: "finalize", detail: "Prepare, write, check, and persist" },
    { title: "commit", detail: "Finish two independent calls" },
  ],
}

const input = JSON.stringify(args)

function schema(label, verdict = "ok") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "verdict"],
    properties: {
      label: { const: label },
      verdict: { const: verdict },
    },
  }
}

function run(label, verdict = "ok") {
  return agent(`label=${label}; input=${input}`, {
    label,
    schema: schema(label, verdict),
  })
}

phase("setup")
log("setup")
await parallel([
  () => run("prepare-1"),
  () => run("prepare-2"),
])

phase("summarize")
log("summarize")
await parallel([
  () => run("shard-1"),
  () => run("shard-2"),
  () => run("shard-3"),
])
await run("join-1")
await parallel([
  () => run("summary-1"),
  () => run("summary-2"),
  () => run("summary-3"),
  () => run("summary-4"),
  () => run("summary-5"),
  () => run("summary-6"),
])

phase("finalize")
log("finalize")
await run("prepare-3")
await run("write-1")
const lint = await run("lint-1", "rewrite")
if (lint.verdict === "rewrite") await run("rewrite-1")
await run("persist-1")

phase("commit")
log("commit")
await parallel([
  () => run("commit-1"),
  () => run("commit-2"),
])

return { profile: "orchestration-19", status: "ok" }
