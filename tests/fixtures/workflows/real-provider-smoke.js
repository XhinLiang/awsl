export const meta = {
  name: "real-provider-smoke",
  description: "Run one read-only provider round trip",
}

if (
  !args ||
  args.message !== "Return exactly AWSL_SMOKE_OK and do not use tools."
) {
  throw new Error("invalid smoke arguments")
}

const response = await agent(args.message, { label: "real-provider-smoke" })
return { response: String(response).trim() }
