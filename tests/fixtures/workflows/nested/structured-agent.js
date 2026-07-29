export const meta = {
  name: "structured-agent",
  description: "Run one structured agent",
}

return await agent("structured", {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string" },
    },
  },
})
