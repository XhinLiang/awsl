import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  strictJsonClone as coreClone,
  strictJsonPacket as corePacket,
} from "../../src/core/strict-json.js";
import {
  strictJsonClone as workerClone,
  strictJsonPacket as workerPacket,
} from "../../src/worker/json.js";

describe("core strict JSON boundary", () => {
  test("keeps worker exports on the exact core-owned implementation", () => {
    expect(workerClone).toBe(coreClone);
    expect(workerPacket).toBe(corePacket);
  });

  test.each([
    ["core", coreClone],
    ["worker", workerClone],
  ])(
    "rejects accessors without invoking them through the %s path",
    (_name, clone) => {
      let getterCalls = 0;
      const value = {};
      Object.defineProperty(value, "secret", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "must-not-run";
        },
      });

      expect(() => clone(value, "payload")).toThrow(
        "payload.secret must be an enumerable data property",
      );
      expect(getterCalls).toBe(0);
    },
  );

  test("rejects a proxied prototype without invoking its traps", () => {
    const sentinel = new Error("prototype trap must not run");
    let trapCalls = 0;
    const trapped = () => {
      trapCalls += 1;
      throw sentinel;
    };
    const prototype = new Proxy(
      {},
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        ownKeys: trapped,
      },
    );
    const value = Object.create(prototype, {
      safe: {
        enumerable: true,
        value: true,
      },
    });

    expect(() => coreClone(value, "payload")).toThrow(
      "payload contains a non-plain object",
    );
    expect(trapCalls).toBe(0);
  });

  test("keeps compatibility negotiation pointed at core instead of worker", async () => {
    const source = await readFile(
      new URL("../../src/compat/agent-negotiation.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('../core/strict-json.js"');
    expect(source).not.toContain("../worker/");
  });
});
