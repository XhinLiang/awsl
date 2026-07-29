import type { Node } from "acorn";

type AstNode = Node & Record<string, unknown>;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class PureLiteralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PureLiteralError";
  }
}

function fail(message: string): never {
  throw new PureLiteralError(`metadata must be a pure literal: ${message}`);
}

function propertyName(key: AstNode): string {
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (
    key.type === "Literal" &&
    typeof key.value === "number" &&
    Number.isFinite(key.value)
  ) {
    return String(key.value);
  }
  return fail("object keys must be finite numbers or strings");
}

function evaluateArray(node: AstNode): unknown[] {
  const elements = node.elements as Array<AstNode | null>;
  return elements.map((element) => {
    if (element === null) return fail("sparse arrays are not allowed");
    if (element.type === "SpreadElement") return fail("spread is not allowed");
    return evaluateLiteral(element);
  });
}

function evaluateObject(node: AstNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = node.properties as AstNode[];

  for (const property of properties) {
    if (property.type === "SpreadElement") fail("spread is not allowed");
    if (property.type !== "Property") fail("object properties are required");
    if (property.computed === true) fail("computed keys are not allowed");
    if (property.method === true || property.kind !== "init") {
      fail("methods and accessors are not allowed");
    }

    const key = propertyName(property.key as AstNode);
    if (RESERVED_KEYS.has(key)) fail(`reserved key ${key} is not allowed`);
    result[key] = evaluateLiteral(property.value as AstNode);
  }

  return result;
}

export function evaluateLiteral(node: AstNode): unknown {
  switch (node.type) {
    case "Literal": {
      const value = node.value;
      if (typeof value === "bigint" || value instanceof RegExp) {
        return fail("BigInt and regular expressions are not allowed");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        return fail("numbers must be finite");
      }
      return value;
    }
    case "UnaryExpression": {
      if (
        node.operator !== "-" ||
        (node.argument as AstNode).type !== "Literal"
      ) {
        return fail("only negative numeric literals are allowed");
      }
      const value = (node.argument as AstNode).value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail("numbers must be finite");
      }
      return -value;
    }
    case "TemplateLiteral": {
      const expressions = node.expressions as AstNode[];
      if (expressions.length > 0)
        return fail("template interpolation is not allowed");
      const quasis = node.quasis as AstNode[];
      return quasis
        .map((quasi) => (quasi.value as { cooked: string | null }).cooked ?? "")
        .join("");
    }
    case "ArrayExpression":
      return evaluateArray(node);
    case "ObjectExpression":
      return evaluateObject(node);
    default:
      return fail(`${node.type} is not allowed`);
  }
}
