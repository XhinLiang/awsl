import { createHash } from "node:crypto";

import {
  canonicalJson,
  isUnicodeScalarString,
  omitUndefined,
} from "../core/canonical-json.js";
import type { AgentEffort } from "../core/types.js";

export {
  canonicalJson,
  omitUndefined,
  type CanonicalValue,
} from "../core/canonical-json.js";

export interface JournalKeyV2Input {
  previousKey: string;
  prompt: string;
  schema?: Record<string, unknown>;
  requestedModel?: string;
  requestedEffort?: AgentEffort;
  isolation?: "worktree";
  agentType?: string;
}

export function journalKeyV2(input: JournalKeyV2Input): `v2:${string}` {
  if (
    !isUnicodeScalarString(input.previousKey) ||
    !isUnicodeScalarString(input.prompt)
  ) {
    throw new TypeError("canonical JSON rejects a lone surrogate");
  }
  const identity = canonicalJson(
    omitUndefined({
      schema: input.schema,
      model: input.requestedModel,
      effort: input.requestedEffort,
      isolation: input.isolation,
      agentType: input.agentType,
    }),
  );
  const digest = createHash("sha256")
    .update(input.previousKey, "utf8")
    .update("\0", "utf8")
    .update(input.prompt, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest("hex");
  return `v2:${digest}`;
}
