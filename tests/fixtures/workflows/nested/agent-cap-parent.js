export const meta = {
  name: "agent-cap-parent",
  description: "Consume the root worker cap before invoking a child",
}

for (let index = 0; index < 1000; index += 1) {
  await agent("cached")
}
return await workflow({ scriptPath: args.childPath })
