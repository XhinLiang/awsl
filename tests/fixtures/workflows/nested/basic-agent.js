export const meta = {
  name: "basic-agent",
  description: "Run one agent and return its text",
}

return {
  answer: await agent(args.prompt),
  requestedStatus: "failed",
}
