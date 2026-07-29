export const meta = {
  name: "parallel-two",
  description: "Run two agents concurrently",
}

return await parallel([
  () => agent("one"),
  () => agent("two"),
])
