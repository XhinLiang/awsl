export const meta = {
  name: "child-calls-grandchild",
  description: "Attempt forbidden second-level nesting",
}

return await workflow({ scriptPath: args.grandchildPath })
