import type { Node, Program } from "acorn";
import { simple } from "acorn-walk";

type AstNode = Node & Record<string, unknown>;

export class DeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeterminismError";
  }
}

export function assertDeterministic(
  program: Program,
  metadataStatement?: Node,
): void {
  if (metadataStatement !== undefined) {
    for (const statement of program.body) {
      if (
        statement !== metadataStatement &&
        (statement.type === "ExportNamedDeclaration" ||
          statement.type === "ExportDefaultDeclaration" ||
          statement.type === "ExportAllDeclaration")
      ) {
        throw new DeterminismError(
          "module syntax not allowed in workflow body",
        );
      }
    }
  }

  simple(program, {
    ImportDeclaration() {
      throw new DeterminismError("import declarations are not allowed");
    },
    ImportExpression() {
      throw new DeterminismError("import expressions are not allowed");
    },
    MetaProperty(node) {
      const metaProperty = node as unknown as AstNode;
      if ((metaProperty.meta as AstNode).name === "import") {
        throw new DeterminismError(
          "module syntax not allowed in workflow body",
        );
      }
    },
  });
}
