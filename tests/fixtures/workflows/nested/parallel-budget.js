export const meta = {
  name: "parallel-budget",
  description: "Exercise concurrent budget overshoot",
}

const first = await parallel([
  () => agent("one"),
  () => agent("two"),
])
let thirdError = null
try {
  await agent("three")
} catch (error) {
  thirdError = error.code
}
return { first, thirdError, spent: budget.spent() }
