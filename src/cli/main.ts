#!/usr/bin/env node

import type { Readable, Writable } from "node:stream";

import { AwslError } from "../core/errors.js";
import { MAX_ARGS_BYTES } from "./args.js";
import { executeCli } from "./commands.js";

function streamWriter(stream: Writable): (value: string) => Promise<void> {
  return async (value) => {
    try {
      await new Promise<void>((resolve, reject) => {
        stream.write(value, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      throw new AwslError("PERSISTENCE_ERROR", "output stream failed", {
        recoverable: false,
        cause: error,
      });
    }
  };
}

function boundedStdin(stream: Readable): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= (async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts: string[] = [];
      let size = 0;
      try {
        for await (const raw of stream) {
          const chunk =
            typeof raw === "string"
              ? Buffer.from(raw, "utf8")
              : Buffer.from(raw as Uint8Array);
          size += chunk.byteLength;
          if (size > MAX_ARGS_BYTES)
            throw new AwslError(
              "USAGE_ERROR",
              "workflow arguments exceed the byte limit",
              { recoverable: false },
            );
          parts.push(decoder.decode(chunk, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join("");
      } catch (error) {
        if (error instanceof AwslError) throw error;
        throw new AwslError(
          "USAGE_ERROR",
          "workflow arguments must be valid UTF-8",
          { recoverable: false },
        );
      }
    })();
    return cached;
  };
}

const exitCode = await executeCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdoutIsTTY: process.stdout.isTTY === true,
  stdin: {
    isTTY: process.stdin.isTTY === true,
    read: boundedStdin(process.stdin),
  },
  writeStdout: streamWriter(process.stdout),
  writeStderr: streamWriter(process.stderr),
}).catch(() => 1);

process.exitCode = exitCode;
