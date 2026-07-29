import { isProxy } from "node:util/types";

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (isProxy(prototype)) return false;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "constructor",
  );
  return (
    constructorDescriptor?.value !== undefined &&
    typeof constructorDescriptor.value === "function" &&
    constructorDescriptor.value.name === "Object" &&
    Object.getPrototypeOf(prototype) === null
  );
}

function clone(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object")
    throw new TypeError(`${path} contains a non-JSON value`);
  if (isProxy(value)) throw new TypeError(`${path} contains a proxy`);
  if (ancestors.has(value)) throw new TypeError(`${path} is circular`);
  if (!Array.isArray(value) && !isPlainObject(value))
    throw new TypeError(`${path} contains a non-plain object`);

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol"))
      throw new TypeError(`${path} contains a symbol key`);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (!descriptor)
          throw new TypeError(`${path}[${index}] is an array hole`);
        if (!("value" in descriptor) || !descriptor.enumerable)
          throw new TypeError(
            `${path}[${index}] must be an enumerable data property`,
          );
        result.push(clone(descriptor.value, `${path}[${index}]`, ancestors));
      }
      const stringKeys = keys as string[];
      if (
        stringKeys.some(
          (key) =>
            key !== "length" &&
            (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
        )
      )
        throw new TypeError(`${path} contains extra array properties`);
      return result;
    }
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new TypeError(
          `${path}.${key} must be an enumerable data property`,
        );
      result[key] = clone(descriptor.value, `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Copies only data that exactly fits the JSON data model, in one descriptor pass. */
export function strictJsonClone(value: unknown, label: string): unknown {
  return clone(value, label, new Set());
}

export function strictJsonPacket(value: unknown, label: string): string {
  return JSON.stringify(strictJsonClone(value, label));
}
