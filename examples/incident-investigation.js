export const meta = {
  name: "incident-investigation",
  title: "Incident investigation",
  description: "Build an evidence-ranked incident assessment",
  whenToUse: "Investigate a failure without turning hypotheses into facts",
  phases: [
    { title: "investigate", detail: "Collect independent incident views" },
    { title: "assess", detail: "Rank evidence and define next actions" },
  ],
}

// Run from the affected service repository:
// awsl run /path/to/awsl/examples/incident-investigation.js \
//   --args '{"incident":"API requests intermittently return 502"}'

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.incident !== "string" ||
  args.incident.trim().length === 0
) {
  throw new Error('incident-investigation requires {"incident":"..."}')
}

const incident = args.incident.trim()
const investigators = [
  { label: "timeline", focus: "timeline, triggering change, and blast radius" },
  { label: "runtime", focus: "logs, metrics, dependencies, and resource pressure" },
  { label: "code", focus: "relevant code paths, failure handling, and recent changes" },
]
const assessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "hypotheses", "unknowns"],
  properties: {
    observations: { type: "array", items: { type: "string" } },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence", "confidence"],
        properties: {
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
  },
}

phase("investigate")
const rawAssessments = await parallel(
  investigators.map(
    (investigator) => () =>
      agent(
        `Investigate this incident from the ${investigator.label} perspective:\n\n${incident}\n\nFocus on ${investigator.focus}. Inspect available repository and runtime evidence, but do not edit files or change external state. Cite the source of each observation. Mark unsupported explanations as hypotheses and list missing evidence explicitly.`,
        {
          label: `incident-${investigator.label}`,
          effort: "high",
          schema: assessmentSchema,
        },
      ),
  ),
)

const assessments = []
for (let index = 0; index < rawAssessments.length; index += 1) {
  if (rawAssessments[index] !== null) {
    assessments.push({
      investigator: investigators[index].label,
      result: rawAssessments[index],
    })
  }
}
if (assessments.length === 0) {
  throw new Error("all incident investigation branches failed")
}

phase("assess")
const report = await agent(
  `Act as the incident lead for this incident:\n\n${incident}\n\nIndependent assessments JSON:\n${JSON.stringify(assessments)}\n\nDeduplicate evidence, challenge conflicting hypotheses, and do not claim a root cause unless the evidence supports it. Produce safe, ordered next actions. Do not edit files or change external state.`,
  {
    label: "incident-lead",
    effort: "high",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "rootCause", "evidence", "nextActions"],
      properties: {
        status: { type: "string", enum: ["confirmed", "probable", "undetermined"] },
        summary: { type: "string" },
        rootCause: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } },
      },
    },
  },
)
if (report === null) throw new Error("incident assessment returned no result")

return {
  status: assessments.length === investigators.length ? "completed" : "partial",
  incident,
  investigatorsRequested: investigators.length,
  investigatorsCompleted: assessments.length,
  report,
  budget: { total: budget.total, spent: budget.spent() },
}
