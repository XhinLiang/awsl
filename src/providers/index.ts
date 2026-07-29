import type { AgentCallOutcome, ProviderOutcome } from "../core/types.js";

export type EngineProviderOutcome =
  | ProviderOutcome
  | {
      kind: "user-skip";
    };

export function classifyEngineOutcome(
  outcome: EngineProviderOutcome,
): AgentCallOutcome {
  if (outcome.kind === "user-skip") {
    return {
      kind: "compatibility-null",
      reason: "user-skip",
      usage: {
        complete: true,
        outputTokens: 0,
      },
    };
  }
  if (
    outcome.kind === "completed" ||
    outcome.kind === "compatibility-null" ||
    outcome.kind === "error"
  ) {
    return outcome;
  }
  throw new TypeError("unknown engine outcome");
}

export {
  CODEX_CAPABILITIES,
  CodexAdapter,
  buildCodexArgv,
} from "./codex.js";
export {
  CLAUDE_CAPABILITIES,
  ClaudeAdapter,
  buildClaudeArgv,
} from "./claude.js";
