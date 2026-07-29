export const meta = {
  name: "child",
  description: "Run an agent in a child workflow",
}

phase("ignored-child-phase")
return {
  child: await agent("child", { phase: "ignored-explicit-child-phase" }),
  spent: budget.spent(),
}
