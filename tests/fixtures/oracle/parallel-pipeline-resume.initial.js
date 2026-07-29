export const meta = {
  name: "parallel-pipeline-resume",
  description: "Capture deterministic parallel, pipeline, and budget behavior",
  phases: [
    { title: "setup", detail: "Run the stable prefix" },
    { title: "finish", detail: "Return the closed oracle result" },
  ],
}

if (!args || args.oracle !== "AWSL_ORACLE_V1") {
  throw new Error("invalid oracle arguments")
}

const before = budget.spent()
phase("setup")
log("AWSL_ORACLE_SETUP")
const parallelResult = await parallel([
  () =>
    agent("Return exactly AWSL_ORACLE_ALPHA", {
      label: "alpha",
      phase: "setup",
      agentType: "oracle-no-tools",
    }),
  () =>
    agent("Return exactly AWSL_ORACLE_BETA", {
      label: "beta",
      phase: "setup",
      agentType: "oracle-no-tools",
    }),
  async () => {
    throw new Error("AWSL_ORACLE_EXPECTED_BRANCH_FAILURE")
  },
])

const pipelineResult = await pipeline(
  ["keep", "drop"],
  async (value) => (value === "drop" ? null : `${value}:stage-one`),
  async (value) =>
    value === "keep:stage-one" ? "AWSL_ORACLE_PIPELINE_OK" : "unexpected",
)

phase("finish")
log("AWSL_ORACLE_FINISH")
return {
  oracle: args.oracle,
  parallel: parallelResult,
  pipeline: pipelineResult,
  budget: {
    total: Number.isFinite(budget.total) ? "limited" : "unlimited",
    before: before === 0 ? "zero" : "positive",
    after: budget.spent() > 0 ? "positive" : "zero",
    remaining: Number.isFinite(budget.remaining()) ? "finite" : "infinity",
  },
}
