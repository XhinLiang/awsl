import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  journalKeyV2,
  omitUndefined,
} from "../../src/store/canonical-json.js";

describe("canonical JSON", () => {
  test("sorts keys recursively by UTF-8 byte order without changing arrays", () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: ["z", "a"] })).toBe(
      '{"a":["z","a"],"z":{"a":2,"b":1}}',
    );
    expect(canonicalJson({ "\u{10000}": 1, "\u{e000}": 2 })).toBe(
      '{"":2,"𐀀":1}',
    );
  });

  test("preserves an own __proto__ data property", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { safe: true },
    });
    expect(canonicalJson(value)).toBe('{"__proto__":{"safe":true}}');
  });

  test.each([
    undefined,
    1n,
    () => undefined,
    Symbol("x"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
  ])("rejects unsupported canonical values", (value) => {
    expect(() => canonicalJson(value)).toThrow(/canonical/i);
  });

  test("rejects sparse arrays", () => {
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => canonicalJson(sparse)).toThrow(/canonical/i);
  });

  test("rejects lone surrogates", () => {
    expect(() => canonicalJson("\ud800")).toThrow(/canonical/i);
  });

  test("rejects transparent proxies, array subclasses, and non-data indexes", () => {
    expect(() => canonicalJson(new Proxy({ a: 1 }, {}))).toThrow(/canonical/i);
    expect(() => canonicalJson(new Proxy([1], {}))).toThrow(/canonical/i);
    expect(() => canonicalJson(new (class extends Array {})())).toThrow(
      /canonical/i,
    );
    const array = [1];
    Object.defineProperty(array, "0", { enumerable: false, value: 1 });
    expect(() => canonicalJson(array)).toThrow(/canonical/i);
  });

  test("rejects object and array proxies without invoking any trap", () => {
    let hookCalls = 0;
    const trap = () => {
      hookCalls += 1;
      throw new Error("canonical JSON must not invoke proxy hooks");
    };
    const handler: ProxyHandler<object> = {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    };

    expect(() => canonicalJson(new Proxy({ a: 1 }, handler))).toThrow(
      /canonical/i,
    );
    expect(() =>
      canonicalJson(new Proxy([1], handler as ProxyHandler<number[]>)),
    ).toThrow(/canonical/i);
    expect(hookCalls).toBe(0);
  });

  test("does not read getters while omitting undefined", () => {
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("read");
      },
    });
    expect(() => omitUndefined(source)).toThrow(/canonical/i);
  });

  test("rejects cycles, shared references, accessors, custom prototypes and toJSON", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const shared = { x: 1 };
    const accessor = {};
    Object.defineProperty(accessor, "x", { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(cycle)).toThrow(/canonical/i);
    expect(() => canonicalJson({ a: shared, b: shared })).toThrow(/canonical/i);
    expect(() => canonicalJson(accessor)).toThrow(/canonical/i);
    expect(() => canonicalJson(new (class X {})())).toThrow(/canonical/i);
    expect(() => canonicalJson({ toJSON() {} })).toThrow(/canonical/i);
  });

  test("omits only undefined identity fields", () => {
    expect(omitUndefined({ a: undefined, b: null, c: 0 })).toEqual({
      b: null,
      c: 0,
    });
  });
});

describe("journalKeyV2", () => {
  const input = {
    previousKey: "",
    prompt: "hi  \r\n😀",
    schema: { z: { b: 1, a: 2 } },
    requestedModel: "m",
    requestedEffort: "high" as const,
    isolation: "worktree" as const,
    agentType: "reviewer",
  };

  test("hashes exact UTF-8 prompt bytes and only identity fields", () => {
    const key = journalKeyV2(input);
    const expected = createHash("sha256")
      .update(
        `${input.previousKey}\0${input.prompt}\0${canonicalJson({ schema: { z: { b: 1, a: 2 } }, model: "m", effort: "high", isolation: "worktree", agentType: "reviewer" })}`,
        "utf8",
      )
      .digest("hex");
    expect(key).toBe(`v2:${expected}`);
    expect(journalKeyV2({ ...input, prompt: "hi  \n😀" })).not.toBe(key);
    expect(journalKeyV2({ ...input, schema: { z: { a: 2, b: 1 } } })).toBe(key);
    expect(journalKeyV2({ ...input, schema: { z: { a: 2, b: 3 } } })).not.toBe(
      key,
    );
  });
});
