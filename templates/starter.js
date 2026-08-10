export const meta = {
  name: "starter",
  description: "Complete one repository task with a coding agent",
  phases: [{ title: "work", detail: "Inspect the repository and complete the task" }],
}

const task =
  args !== undefined &&
  args !== null &&
  typeof args === "object" &&
  !Array.isArray(args) &&
  typeof args.task === "string" &&
  args.task.trim().length > 0
    ? args.task.trim()
    : "Summarize this repository and identify the highest-priority next step."

phase("work")
return agent(task, { label: "starter", effort: "medium" })
