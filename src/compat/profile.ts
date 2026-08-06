/**
 * The stable contract implemented by the awsl workflow compiler and runtime.
 *
 * Claude Code 2.1.218 was the original behavioral oracle for this contract,
 * but the contract is owned and versioned by awsl. It is deliberately not a
 * provider executable version.
 */
export const WORKFLOW_ABI = {
  id: "awsl-workflow@1",
  agentCap: 1000,
  structuredOutputAttempts: 5,
  maxSourceBytes: 512 * 1024,
  maxConfigBytes: 512 * 1024,
  maxProviderArgs: 32,
  maxProviderArgBytes: 4 * 1024,
  providerProcess: {
    maxNdjsonLineBytes: 8 * 1024 * 1024,
    stderrTailBytes: 64 * 1024,
    killGraceMs: 1_000,
  },
} as const;

/** Internal compatibility alias retained while callers migrate to WORKFLOW_ABI. */
export const COMPATIBILITY_PROFILE = WORKFLOW_ABI;

/**
 * Provider Pin V1/V2 and behavior-fingerprint V1 encoded the original oracle
 * name. Keep this immutable so runs created by awsl 0.1.x remain resumable.
 */
export const LEGACY_COMPATIBILITY_PROFILE = {
  ...WORKFLOW_ABI,
  id: "claude-code@2.1.218",
} as const;
