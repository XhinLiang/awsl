export const meta = {
  name: "migration",
  title: "Isolated migration",
  description: "Plan and implement a bounded migration in a Git worktree",
  whenToUse: "Make a reviewable code migration without touching the original checkout",
  phases: [
    { title: "plan", detail: "Map the migration and compatibility constraints" },
    { title: "migrate", detail: "Implement and verify in an isolated worktree" },
  ],
}

// Run from the Git repository being migrated:
// awsl run /path/to/awsl/examples/migration.js \
//   --args '{"task":"Migrate the parser API while preserving callers"}'

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.task !== "string" ||
  args.task.trim().length === 0
) {
  throw new Error('migration requires {"task":"..."}')
}

const task = args.task.trim()
phase("plan")
const plan = await agent(
  `Inspect the current repository and plan this migration:\n\n${task}\n\nIdentify affected contracts, callers, compatibility risks, incremental steps, and verification commands. Do not edit files or perform external side effects.`,
  {
    label: "migration-plan",
    effort: "high",
    isolation: "worktree",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "constraints", "steps", "verification"],
      properties: {
        scope: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
        verification: { type: "array", items: { type: "string" } },
      },
    },
  },
)
if (plan === null) throw new Error("migration planning returned no result")

phase("migrate")
const implementation = await agent(
  `Work only inside the isolated Git worktree that awsl provides.\n\nMigration task:\n${task}\n\nApproved plan JSON:\n${JSON.stringify(plan)}\n\nImplement the smallest coherent migration, preserve the identified contracts, and run relevant verification. Do not modify anything outside the repository and do not commit. If the migration is unsafe or incomplete, leave the worktree reviewable and report the exact gap.`,
  {
    label: "migration-implementation",
    effort: "high",
    isolation: "worktree",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "changedFiles", "verification", "remainingRisks"],
      properties: {
        summary: { type: "string" },
        changedFiles: { type: "array", items: { type: "string" } },
        verification: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["command", "outcome"],
            properties: {
              command: { type: "string" },
              outcome: { type: "string" },
            },
          },
        },
        remainingRisks: { type: "array", items: { type: "string" } },
      },
    },
  },
)
if (implementation === null) throw new Error("migration implementation returned no result")

return {
  status:
    implementation.changedFiles.length > 0
      ? "ready-for-review"
      : "completed-without-changes",
  task,
  plan,
  implementation,
  nextStep:
    implementation.changedFiles.length > 0
      ? "Use `awsl runs show <run-id>` to locate the retained worktree, then review and integrate it manually."
      : "No changed files were reported; a clean successful worktree may be removed automatically.",
  budget: { total: budget.total, spent: budget.spent() },
}
