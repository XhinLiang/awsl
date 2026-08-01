export const meta = {
  name: "worktree-refactor",
  title: "Isolated worktree refactor",
  description: "Implement and test a change in an isolated Git worktree",
  whenToUse: "Let an agent change code without touching the original checkout",
  phases: [
    { title: "refactor", detail: "Edit and test in an isolated worktree" },
  ],
}

// Run from the Git repository being changed:
// awsl run /path/to/awsl/examples/worktree-refactor.js \
//   --args '{"task":"Rename the parser helper without changing behavior"}'

if (
  args === undefined ||
  args === null ||
  typeof args !== "object" ||
  Array.isArray(args) ||
  typeof args.task !== "string" ||
  args.task.trim().length === 0
) {
  throw new Error('worktree-refactor requires {"task":"..."}')
}

const task = args.task.trim()

phase("refactor")
const result = await agent(
  `Work only inside the isolated Git worktree that awsl provides.\n\nTask:\n${task}\n\nInspect the repository, implement the smallest coherent change, and run relevant tests. Do not modify anything outside the repository. Do not commit: leave successful changes uncommitted so awsl retains the worktree for review. If the task cannot be completed safely, explain why without making speculative changes.`,
  {
    label: "isolated-refactor",
    effort: "high",
    isolation: "worktree",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "changedFiles", "tests", "remainingRisks"],
      properties: {
        summary: { type: "string" },
        changedFiles: {
          type: "array",
          items: { type: "string" },
        },
        tests: {
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
        remainingRisks: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
)

if (result === null) {
  throw new Error("isolated refactor returned no result")
}

const hasChanges = result.changedFiles.length > 0
return {
  status: hasChanges ? "ready-for-review" : "completed-without-changes",
  task,
  result,
  nextStep: hasChanges
    ? "Use `awsl runs show <run-id>` to find the retained worktree; review and integrate it manually."
    : "No changed files were reported; a clean successful worktree may be removed automatically.",
  budget: { total: budget.total, spent: budget.spent() },
}
