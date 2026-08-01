export const meta = {
  name: "resume-after-failure",
  title: "Resume after failure",
  description: "Checkpoint a completed agent call and reuse it on resume",
  whenToUse: "Learn how a durable awsl run resumes without repeating its valid prefix",
  phases: [
    { title: "plan", detail: "Create a reusable checkpoint" },
    { title: "execute", detail: "Continue after the checkpoint" },
  ],
}

// First create an intentional failure after the durable checkpoint:
// awsl run examples/resume-after-failure.js --format json \
//   --args '{"task":"Explain the module","failAfterCheckpoint":true}'
// Then reuse the completed plan call from the emitted run ID:
// awsl resume <run-id> --format json \
//   --args '{"task":"Explain the module","failAfterCheckpoint":false}'

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.task !== "string" ||
  args.task.trim().length === 0
) {
  throw new Error(
    'resume-after-failure requires {"task":"...","failAfterCheckpoint":true|false}',
  )
}

const task = args.task.trim()
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "steps", "risks"],
  properties: {
    goal: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
}

phase("plan")
// Keep this prompt independent of failAfterCheckpoint. On resume, its journal
// key stays stable and awsl can reuse the completed call.
const plan = await agent(
  `Create a concise, read-only execution plan for this task:\n\n${task}\n\nDo not edit files or perform external side effects.`,
  {
    label: "resume-checkpoint-plan",
    effort: "medium",
    schema: planSchema,
  },
)

if (plan === null) {
  throw new Error("checkpoint planning returned no result")
}

if (args.failAfterCheckpoint === true) {
  throw new Error(
    "intentional demo failure after checkpoint; resume with failAfterCheckpoint=false",
  )
}

phase("execute")
const result = await agent(
  `Complete this task as a read-only analysis:\n\n${task}\n\nPlan JSON:\n${JSON.stringify(plan)}\n\nDo not edit files or perform external side effects.`,
  {
    label: "resume-final-analysis",
    effort: "medium",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "followUps"],
      properties: {
        answer: { type: "string" },
        followUps: { type: "array", items: { type: "string" } },
      },
    },
  },
)

if (result === null) {
  throw new Error("resumed analysis returned no result")
}

return {
  status: "completed",
  task,
  plan,
  result,
  budget: { total: budget.total, spent: budget.spent() },
}
