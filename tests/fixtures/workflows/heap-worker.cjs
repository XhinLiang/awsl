process.on("message", () => {
  const memoryFlags = process.execArgv.filter((value) =>
    value.startsWith("--max-old-space-size="),
  );
  process.send({ type: "result", value: memoryFlags });
});
