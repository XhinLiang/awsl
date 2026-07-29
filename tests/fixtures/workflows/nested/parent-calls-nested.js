export const meta = {
  name: "parent-calls-nested",
  description: "Invoke a child that invokes a grandchild",
}

return await workflow(
  { scriptPath: args.childPath },
  { grandchildPath: args.grandchildPath },
)
