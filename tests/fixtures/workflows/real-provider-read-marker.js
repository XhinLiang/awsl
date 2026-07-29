export const meta = {
  name: "real-provider-read-marker",
  description: "Read one committed marker and inherited project instruction",
}

if (
  !args ||
  typeof args.expectedInstruction !== "string" ||
  !args.expectedInstruction
) {
  throw new Error("invalid marker arguments")
}

return await agent(
  "Read MARKER.txt in the current working directory and follow the inherited " +
    "project instruction. Return only the requested structured object. Do not " +
    "write or modify any file.",
  {
    label: "read-marker",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["marker", "cwdMarker", "projectInstruction"],
      properties: {
        marker: { type: "string", const: "AWSL_READ_MARKER_V1" },
        cwdMarker: { type: "string", const: "AWSL_REAL_PROVIDER_PROJECT_V1" },
        projectInstruction: {
          type: "string",
          const: args.expectedInstruction,
        },
      },
    },
  },
)
