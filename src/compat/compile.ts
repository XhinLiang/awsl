import { createHash } from "node:crypto";

import { type Node, type Program, parse } from "acorn";

import { AwslError } from "../core/errors.js";
import { DeterminismError, assertDeterministic } from "./determinism.js";
import { PureLiteralError, evaluateLiteral } from "./literal.js";
import { WORKFLOW_ABI } from "./profile.js";

type AstNode = Node & Record<string, unknown>;

export interface WorkflowPhaseMetadata {
  title: string;
  detail?: string;
  model?: string;
}

export interface CompiledWorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMetadata[];
}

export interface CompiledWorkflow {
  workflowAbi: typeof WORKFLOW_ABI.id;
  meta: CompiledWorkflowMeta;
  code: string;
  filename: string;
  sourceHash: string;
}

function compatibilityError(message: string, cause?: unknown): AwslError {
  return new AwslError("COMPATIBILITY_ERROR", message, {
    recoverable: false,
    cause,
  });
}

function blankMetadata(source: string, start: number, end: number): string {
  return `${source.slice(0, start).replace(/[^\r\n]/g, " ")}${source
    .slice(start, end)
    .replace(/[^\r\n]/g, " ")}${source.slice(end)}`;
}

function isMetaDeclaration(statement: AstNode): boolean {
  if (statement.type !== "ExportNamedDeclaration") return false;
  const declaration = statement.declaration as AstNode | null;
  if (
    declaration?.type !== "VariableDeclaration" ||
    declaration.kind !== "const"
  ) {
    return false;
  }
  const declarations = declaration.declarations as AstNode[];
  const first = declarations[0];
  return (
    declarations.length === 1 &&
    first?.id !== undefined &&
    (first.id as AstNode).type === "Identifier" &&
    (first.id as AstNode).name === "meta" &&
    first.init !== null &&
    first.init !== undefined
  );
}

function metadataFrom(value: unknown): CompiledWorkflowMeta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compatibilityError("workflow metadata must be a pure literal object");
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.name !== "string" || fields.name.length === 0) {
    throw compatibilityError("metadata name must be a non-empty string");
  }
  if (
    typeof fields.description !== "string" ||
    fields.description.length === 0
  ) {
    throw compatibilityError("metadata description must be a non-empty string");
  }

  const phases = Array.isArray(fields.phases)
    ? fields.phases.flatMap((phase): WorkflowPhaseMetadata[] => {
        if (
          phase === null ||
          typeof phase !== "object" ||
          Array.isArray(phase)
        ) {
          return [];
        }
        const phaseFields = phase as Record<string, unknown>;
        if (typeof phaseFields.title !== "string") return [];
        return [
          {
            title: phaseFields.title,
            ...(typeof phaseFields.detail === "string"
              ? { detail: phaseFields.detail }
              : {}),
            ...(typeof phaseFields.model === "string"
              ? { model: phaseFields.model }
              : {}),
          },
        ];
      })
    : undefined;

  return {
    name: fields.name,
    description: fields.description,
    ...(typeof fields.title === "string" ? { title: fields.title } : {}),
    ...(typeof fields.whenToUse === "string"
      ? { whenToUse: fields.whenToUse }
      : {}),
    ...(phases === undefined ? {} : { phases }),
  };
}

function parseProgram(source: string): Program {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw compatibilityError("workflow source could not be parsed", error);
  }
}

export function compileWorkflow(
  source: string,
  filename: string,
): CompiledWorkflow {
  if (Buffer.byteLength(source, "utf8") > WORKFLOW_ABI.maxSourceBytes) {
    throw compatibilityError("workflow source exceeds the 512 KiB limit");
  }

  const program = parseProgram(source);
  try {
    assertDeterministic(program);
  } catch (error) {
    if (error instanceof DeterminismError) {
      throw compatibilityError(error.message, error);
    }
    throw error;
  }
  const first = program.body[0] as AstNode | undefined;
  if (first === undefined || !isMetaDeclaration(first)) {
    throw compatibilityError(
      "the first statement must be export const meta = a pure literal",
    );
  }

  try {
    assertDeterministic(program, first);
    const declaration = first.declaration as AstNode;
    const declarator = (declaration.declarations as AstNode[])[0];
    const meta = metadataFrom(evaluateLiteral(declarator.init as AstNode));
    const body = blankMetadata(source, first.start, first.end);
    return {
      workflowAbi: WORKFLOW_ABI.id,
      meta,
      code: `(async function __awslWorkflow__() {"use strict";${body}\n}).call(undefined)`,
      filename,
      sourceHash: createHash("sha256").update(source, "utf8").digest("hex"),
    };
  } catch (error) {
    if (error instanceof AwslError) throw error;
    if (
      error instanceof PureLiteralError ||
      error instanceof DeterminismError
    ) {
      throw compatibilityError(error.message, error);
    }
    throw error;
  }
}
