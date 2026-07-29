export const meta = {
  name: "worktree-agent",
  description: "Run one isolated agent",
}

return await agent("isolated", { isolation: "worktree" })
