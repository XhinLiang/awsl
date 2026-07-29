const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const originalSend = process.send;
process.send = (message, callback) => {
  originalSend.call(process, message, callback);
  return false;
};

void import(pathToFileURL(resolve(__dirname, "../../../dist/worker/main.js")).href);
