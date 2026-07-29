# Real Codex Acceptance Implementation Record

## TL;DR

- This record captures successful real Codex acceptance performed on 2026-07-29.
- Codex CLI `0.145.0` was authenticated and completed both a no-tools round trip and a read-only project-fixture run through the built AWSl CLI.
- The second run demonstrated a committed file read, current-working-directory context, and inherited project instruction without changing the fixture tree.
- This is exact-provider evidence for the stated scenarios only. It does not certify hooks, MCP, every permission mode, implicit resolved default-model discovery, or Claude.

## Contents

- [Scope and prerequisites](#scope-and-prerequisites)
- [Commands](#commands)
- [Observed results](#observed-results)
- [Integrity and retained evidence](#integrity-and-retained-evidence)
- [Failed precondition attempt](#failed-precondition-attempt)
- [Limitations](#limitations)

## Scope and prerequisites

The environment check reported Node `22.20.0`, pnpm `9.15.4`, Codex `0.145.0`,
and Claude `2.1.218`; Codex login was active. AWSl stored the selected provider
pin as provider `codex`, executable version `0.145.0`, and compatibility profile
`claude-code@2.1.218`.

Each successful command used a canonical isolated AWSl state directory. Its `PATH`
contained only existing absolute entries. Raw provider events were disabled and no
provider transcript, run identifier, state directory, or executable realpath is
retained in this repository.

## Commands

Run the commands from the repository root after building. `CANONICAL_ISOLATED_STATE_DIR`
denotes a caller-created canonical isolated directory; it is intentionally not a
repository path.

### No-tools round trip

```bash
AWSL_STATE_DIR="$CANONICAL_ISOLATED_STATE_DIR" \
AWSL_RAW_PROVIDER_EVENTS=false \
node dist/cli/main.js tests/fixtures/workflows/real-provider-smoke.js \
  --provider codex \
  --args '{"message":"Return exactly AWSL_SMOKE_OK and do not use tools."}' \
  --format json
```

### Read-marker, cwd, and project instruction

```bash
(
  cd tests/fixtures/real-provider-project
  AWSL_STATE_DIR="$CANONICAL_ISOLATED_STATE_DIR" \
  AWSL_RAW_PROVIDER_EVENTS=false \
  node ../../../dist/cli/main.js ../workflows/real-provider-read-marker.js \
    --provider codex \
    --args '{"expectedInstruction":"AWSL_PROJECT_INSTRUCTION_CODEX_V1"}' \
    --format json
)
```

These are direct invocations of the built CLI, not the `pnpm awsl` script alias.

## Observed results

| Acceptance | Result | Metrics |
|---|---|---|
| No-tools | `{ "response": "AWSL_SMOKE_OK" }` | `agentCount=1`, `attemptOutputTokens=9`, `cachedInputTokens=7424`, `inputTokens=22405`, `outputTokens=9`, `reasoningTokens=0`, `usageComplete=true` |
| Read-marker | `marker="AWSL_READ_MARKER_V1"`, `cwdMarker="AWSL_REAL_PROVIDER_PROJECT_V1"`, `projectInstruction="AWSL_PROJECT_INSTRUCTION_CODEX_V1"` | `agentCount=1`, `attemptOutputTokens=289`, `cachedInputTokens=22272`, `inputTokens=45497`, `outputTokens=289`, `reasoningTokens=89`, `usageComplete=true` |

The first response verifies a successful real Codex no-tools turn. The second
response verifies that Codex read the committed marker in the fixture working
directory and applied the Codex project instruction. The read-marker workflow
requests a structured result and is read-only.

## Integrity and retained evidence

The fixture tree digest was identical before and after the read-marker run:

```text
930489592d120658676b02f4f4264ce0b37901da4b43799c0e39e21de4d14316
```

`git status --short` under `tests/fixtures/real-provider-project` was empty after
the run. The repository retains only the fixture source and this summary; raw
provider events and provider transcripts remain disabled and uncommitted.

## Failed precondition attempt

An earlier unsanitized `PATH` attempt failed before provider launch with:

```text
CONFIG_ERROR provider PATH entry is unavailable
```

It produced no provider evidence. Only the successful runs with the restricted,
existing-absolute-entry `PATH` are evidence for this record.

## Limitations

The acceptance proves exact real Codex success for the two commands above,
including the file read, working-directory marker, and project instruction. It
does not prove hooks, MCP, all permission modes, implicit resolved default-model
discovery, or any Claude behavior.
