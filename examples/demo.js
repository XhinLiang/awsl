export const meta = {
  name: "awsl-demo",
  title: "awsl demo",
  description: "Run a small parallel panel through the durable awsl runtime",
  phases: [
    { title: "panel", detail: "Ask two independent perspectives" },
    { title: "synthesize", detail: "Combine the answers" },
  ],
}

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.topic !== "string" ||
  args.topic.trim().length === 0
) {
  throw new Error('awsl demo requires {"topic":"..."}')
}

const topic = args.topic.trim()
phase("panel")
const answers = await parallel([
  () =>
    agent(
      `Give a concise practical answer to this question:\n\n${topic}\n\nUse general knowledge only. Do not inspect files, use tools, or change external state.`,
      { label: "demo-practitioner", effort: "low" },
    ),
  () =>
    agent(
      `Give a concise skeptical answer to this question:\n\n${topic}\n\nChallenge the main assumption. Use general knowledge only. Do not inspect files, use tools, or change external state.`,
      { label: "demo-skeptic", effort: "low" },
    ),
])
if (answers.some((answer) => answer === null)) {
  throw new Error("a demo panel call returned no result")
}

phase("synthesize")
const synthesis = await agent(
  `Synthesize these two short answers to the question below. Preserve the key trade-off and end with one concrete recommendation.\n\nQuestion:\n${topic}\n\nAnswers JSON:\n${JSON.stringify(answers)}\n\nDo not inspect files, use tools, or change external state.`,
  { label: "demo-synthesis", effort: "low" },
)
if (synthesis === null) throw new Error("demo synthesis returned no result")

return {
  topic,
  answers,
  synthesis,
  budget: { total: budget.total, spent: budget.spent() },
}
