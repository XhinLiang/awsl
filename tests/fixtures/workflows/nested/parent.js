export const meta = {
  name: "parent",
  description: "Run parent and child agents",
}

phase("Parent")
const parent = await agent("parent")
const child = await workflow({ scriptPath: args.childPath })
return { parent, child, spent: budget.spent() }
