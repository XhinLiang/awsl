#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, writeFileSync } from "node:fs";
import process from "node:process";

const scenario = process.env.AWSL_TRANSPORT_SCENARIO;
const markerPath = process.env.AWSL_TRANSPORT_MARKER;

if (markerPath) {
  writeFileSync(markerPath, "spawned", { flag: "wx" });
}

function emit(value, ending = "\n") {
  process.stdout.write(`${JSON.stringify(value)}${ending}`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

switch (scenario) {
  case "capture": {
    const prompt = await readStdin();
    emit({
      type: "capture",
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      prompt,
      inheritedPath: typeof process.env.PATH === "string",
      override: process.env.AWSL_TRANSPORT_OVERRIDE,
    });
    break;
  }
  case "capture-proto": {
    await readStdin();
    emit({
      type: "proto",
      own: Object.hasOwn(process.env, "__proto__"),
      value: Object.getOwnPropertyDescriptor(process.env, "__proto__")?.value,
    });
    break;
  }
  case "utf8-split": {
    await readStdin();
    const encoded = Buffer.from(
      `${JSON.stringify({ type: "unicode", value: "雪🙂" })}\n`,
      "utf8",
    );
    const snowStart = encoded.indexOf(Buffer.from("雪", "utf8"));
    process.stdout.write(encoded.subarray(0, snowStart + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(encoded.subarray(snowStart + 1));
    break;
  }
  case "line-endings": {
    await readStdin();
    process.stdout.write("\r\n \t\r\n");
    emit({ type: "first", value: 1 }, "\r\n");
    emit({ type: "second", value: 2 }, "");
    break;
  }
  case "line-bytes": {
    await readStdin();
    const target = Number.parseInt(
      process.env.AWSL_TRANSPORT_LINE_BYTES ?? "",
      10,
    );
    const framingBytes = Buffer.byteLength('{"value":""}', "utf8");
    if (!Number.isInteger(target) || target < framingBytes) {
      process.exitCode = 64;
      break;
    }
    process.stdout.write(
      `${JSON.stringify({ value: "a".repeat(target - framingBytes) })}\n`,
    );
    break;
  }
  case "stderr-success": {
    await readStdin();
    process.stderr.write("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    emit({ type: "ok" });
    break;
  }
  case "ordered-events": {
    await readStdin();
    emit({ type: "event", index: 1 });
    emit({ type: "event", index: 2 });
    emit({ type: "event", index: 3 });
    break;
  }
  case "malformed": {
    await readStdin();
    process.stdout.write('{"secret":"RAW_MALFORMED"\n');
    break;
  }
  case "nonzero": {
    await readStdin();
    process.stderr.write("RAW_STDERR_SUPER_SECRET");
    process.exitCode = 7;
    break;
  }
  case "stdin-close": {
    closeSync(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    emit({ type: "should-not-succeed" });
    break;
  }
  case "hang-with-grandchild": {
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join(""),
      ],
      { stdio: "ignore" },
    );
    process.on("SIGTERM", () => process.exit(0));
    emit({
      type: "ready",
      parentPid: process.pid,
      grandchildPid: grandchild.pid,
    });
    setInterval(() => {}, 1_000);
    break;
  }
  case "success-with-grandchild": {
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join(""),
      ],
      { stdio: "ignore" },
    );
    grandchild.unref();
    emit({
      type: "ready",
      parentPid: process.pid,
      grandchildPid: grandchild.pid,
    });
    break;
  }
  case "success-with-inherited-stdio-grandchild":
  case "failure-with-inherited-stdio-grandchild": {
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join(""),
      ],
      { stdio: "inherit" },
    );
    grandchild.unref();
    emit({
      type: "ready",
      parentPid: process.pid,
      grandchildPid: grandchild.pid,
    });
    if (scenario === "failure-with-inherited-stdio-grandchild") {
      process.exitCode = 7;
    }
    break;
  }
  case "terminal-then-hang": {
    emit({ type: "terminal" });
    setInterval(() => {}, 1_000);
    break;
  }
  default:
    process.stderr.write("missing or invalid AWSL_TRANSPORT_SCENARIO");
    process.exitCode = 64;
}
