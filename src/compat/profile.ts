export const COMPATIBILITY_PROFILE = {
  id: "claude-code@2.1.218",
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
