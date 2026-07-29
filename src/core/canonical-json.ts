import { types } from "node:util";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function fail(reason: string): never {
  throw new TypeError(`canonical JSON rejects ${reason}`);
}

export function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function checkedOwnKeys(value: object): string[] {
  if (types.isProxy(value)) fail("a proxy");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return fail("a proxy");
  }
  if (keys.some((key) => typeof key === "symbol")) fail("symbol keys");
  return keys as string[];
}

function quote(value: string): string {
  if (!isUnicodeScalarString(value)) fail("a lone surrogate");
  return JSON.stringify(value);
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0))
        fail("a non-finite number or negative zero");
      return JSON.stringify(value);
    case "string":
      return quote(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      return fail(`a ${typeof value}`);
    case "object":
      break;
    default:
      return fail("an unsupported value");
  }

  if (types.isProxy(value)) fail("a proxy");
  if (seen.has(value)) fail("a cycle or shared reference");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        fail("a custom array prototype");
      const keys = checkedOwnKeys(value);
      const expected = new Set(
        Array.from({ length: value.length }, (_, index) => String(index)),
      );
      if (
        keys.length !== expected.size + 1 ||
        !keys.includes("length") ||
        keys.some((key) => key !== "length" && !expected.has(key))
      ) {
        fail("a sparse array or extra array property");
      }
      const entries: unknown[] = [];
      for (const key of keys.filter((key) => key !== "length")) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor?.get !== undefined ||
          descriptor?.set !== undefined ||
          descriptor?.enumerable !== true
        )
          fail("an accessor or non-enumerable array index");
        entries[Number(key)] = descriptor.value;
      }
      return `[${entries.map((entry) => encode(entry, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fail("a custom prototype");
    const keys = checkedOwnKeys(value);
    const pairs = keys.map((key) => {
      if (!isUnicodeScalarString(key)) fail("a lone surrogate key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        fail("a non-enumerable property or accessor");
      }
      return [key, descriptor.value] as const;
    });
    if (pairs.some(([key]) => key === "toJSON")) fail("an own toJSON");
    pairs.sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    return `{${pairs.map(([key, entry]) => `${quote(key)}:${encode(entry, seen)}`).join(",")}}`;
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.startsWith("canonical JSON")
    )
      throw error;
    return fail("a proxy");
  } finally {
    // `seen` intentionally remains populated: aliases are not canonical data.
  }
}

/** Serializes the deliberately narrow, identity-safe JSON domain. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

/** Removes only absent optional fields before identity serialization. */
export function omitUndefined<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  if (types.isProxy(value)) fail("a proxy");
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of checkedOwnKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    )
      fail("an accessor");
    if (descriptor.enumerable && descriptor.value !== undefined)
      Object.defineProperty(result, key, {
        enumerable: true,
        value: descriptor.value,
      });
  }
  return result;
}
