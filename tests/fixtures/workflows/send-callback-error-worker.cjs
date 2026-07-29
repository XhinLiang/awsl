const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const { writeFileSync } = require("node:fs");

const originalSend = process.send;
if (process.env.AWSL_CALLBACK_PID_FILE)
  writeFileSync(process.env.AWSL_CALLBACK_PID_FILE, String(process.pid));
process.send = (message, callback) =>
  originalSend.call(process, message, () => {
    callback?.(new Error("fixture async IPC callback failure"));
  });

void import(pathToFileURL(resolve(__dirname, "../../../dist/worker/main.js")).href);
