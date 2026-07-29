let runId;

process.on("message", (message) => {
  if (message?.type === "start") {
    runId = message.runId;
    if (runId === "old-run") {
      process.send({
        type: "request",
        id: "1",
        method: "agent",
        params: { prompt: "old", options: {} },
      });
      process.send({ type: "result", value: "old-result" });
      return;
    }
    process.send({
      type: "request",
      id: "1",
      method: "agent",
      params: { prompt: "new", options: {} },
    });
    return;
  }
  if (
    runId === "new-run" &&
    message?.type === "response" &&
    message.id === "1"
  )
    process.send({
      type: "request",
      id: "2",
      method: "phase",
      params: { title: "new-ready" },
    });
});
