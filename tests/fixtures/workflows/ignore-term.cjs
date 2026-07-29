const { writeFileSync } = require("node:fs");
process.on("message", (message) => {
  if (message?.type === "start") {
    writeFileSync(process.env.AWSL_CLOSE_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
  }
});
process.on("SIGTERM", () => {});
