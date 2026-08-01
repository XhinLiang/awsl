export const meta = {
  name: "research-panel",
  title: "Research panel",
  description: "Run independent research perspectives, then synthesize them",
  whenToUse: "Explore a question from several perspectives before deciding",
  phases: [
    { title: "research", detail: "Collect independent perspectives" },
    { title: "synthesize", detail: "Combine the available evidence" },
  ],
}

// awsl run examples/research-panel.js \
//   --args '{"topic":"When should an agent workflow be resumable?"}'

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.topic !== "string" ||
  args.topic.trim().length === 0
) {
  throw new Error('research-panel requires {"topic":"..."}')
}

const topic = args.topic.trim()
const perspectives = [
  {
    label: "practitioner",
    focus: "practical adoption, constraints, and failure modes",
  },
  {
    label: "skeptic",
    focus: "weak assumptions, counterexamples, and missing evidence",
  },
  {
    label: "strategist",
    focus: "long-term consequences, trade-offs, and decision criteria",
  },
]
const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "keyPoints", "confidence"],
  properties: {
    summary: { type: "string" },
    keyPoints: {
      type: "array",
      items: { type: "string" },
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
  },
}

phase("research")
const findings = await parallel(
  perspectives.map(
    (perspective) => () =>
      agent(
        `Research this topic from the ${perspective.label} perspective:\n\n${topic}\n\nFocus on ${perspective.focus}. Distinguish facts from assumptions. Do not edit files or perform external side effects.`,
        {
          label: `research-${perspective.label}`,
          effort: "medium",
          schema: findingSchema,
        },
      ),
  ),
)

const completed = []
for (let index = 0; index < findings.length; index += 1) {
  const finding = findings[index]
  if (finding !== null) {
    completed.push({
      perspective: perspectives[index].label,
      finding,
    })
  }
}

if (completed.length === 0) {
  throw new Error("all research-panel branches failed")
}

phase("synthesize")
const synthesis = await agent(
  `Synthesize the available research for this topic:\n\n${topic}\n\nResearch JSON:\n${JSON.stringify(completed)}\n\nPreserve disagreements and identify what still needs verification. Do not edit files or perform external side effects.`,
  {
    label: "research-synthesis",
    effort: "high",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "agreements", "uncertainties"],
      properties: {
        answer: { type: "string" },
        agreements: {
          type: "array",
          items: { type: "string" },
        },
        uncertainties: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
)

if (synthesis === null) {
  throw new Error("research synthesis returned no result")
}

return {
  status:
    completed.length === perspectives.length ? "completed" : "partial",
  topic,
  perspectivesRequested: perspectives.length,
  perspectivesCompleted: completed.length,
  synthesis,
  budget: { total: budget.total, spent: budget.spent() },
}
