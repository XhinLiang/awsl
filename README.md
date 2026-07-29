# awsl

awsl (Agentic Workflow Steering Layer) is a standalone runtime and CLI for
trusted JavaScript agent workflows. It loads a small workflow DSL, schedules
Codex or Claude calls, and owns shared budgeting, durable resume, Git worktree
isolation, events, and redaction. It is not a shell wrapper around either
provider. Its compatibility target is the observable workflow behavior of
`claude-code@2.1.218`.

The name also admits a secondary reading: “AWSL — an alternative to A÷’s
West-centric Safety Logic.”

The project does not claim byte-for-byte, universal, or future Claude Code
equivalence. See
[the compatibility report](docs/compatibility/claude-code-2.1.218.md) for the
evidence behind each verified, partial, or unsupported behavior.

## Requirements

- Node.js 22 or newer
- Git for `isolation: "worktree"`
- At least one supported provider executable:
  - Codex CLI `0.145.0` or `0.146.0`
  - Claude Code `2.1.218`

Provider versions are exact compatibility inputs. `awsl doctor` and run
preparation reject other versions; this release does not claim compatibility
with later provider versions.

Install from the public npm registry:

```bash
npm install --global @xhinliang/awsl
awsl --help
```

From a source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm awsl --help
```

The package name is `@xhinliang/awsl`; the installed executable is `awsl`.

## Quick start

Create `example.js`:

```js
export const meta = {
  name: "example",
  description: "Run two independent agents",
  phases: [
    { title: "research", detail: "Collect two answers" },
    { title: "finish", detail: "Return an ordered result" },
  ],
}

phase("research")
const answers = await parallel([
  () => agent("Return exactly FIRST", { label: "first" }),
  () => agent("Return exactly SECOND", { label: "second" }),
])

phase("finish")
log("research complete")
return { answers, spent: budget.spent() }
```

Run it:

```bash
awsl example.js \
  --provider codex \
  --args '{"request":"demo"}' \
  --format json
```

The default provider is Codex. One provider is pinned for the complete workflow
tree; awsl does not fall back from one provider to another during a run.

## CLI

```text
awsl <workflow>
awsl run <workflow>
awsl resume <run-id>
awsl runs list
awsl runs show <run-id>
awsl runs pause <run-id>
awsl doctor
awsl config show
awsl workflow inspect <workflow>
```

`run` accepts:

```text
--provider codex|claude
--args <json>
--args-file <path|->
--cwd <path>
--budget <output-tokens>
--format auto|pretty|jsonl|json
```

`--args`, `--args-file`, and non-empty piped stdin are mutually exclusive.
Input JSON is strict, rejects duplicate keys, and is limited to 512 KiB.

`resume` accepts replacement `--args`, `--args-file`, `--budget`, and
`--format`. The workflow source identity, provider, executable, provider
profile, working directory, compatibility profile, and model policy remain
pinned. Drift is rejected before another provider call starts.

Output contracts:

- `auto` selects `pretty` for a TTY and `jsonl` otherwise.
- `pretty` writes progress to stderr and the final business result to stdout.
- `jsonl` writes only versioned events to stdout.
- `json` writes one terminal envelope to stdout.
- `SIGINT` exits 130 and `SIGTERM` exits 143 after a durable terminal record.

`doctor` probes Node, Git, Codex, and Claude versions without invoking a model.

## Workflow contract

The first statement must be a pure literal `export const meta = ...`.
`meta.name` and `meta.description` are required non-empty strings. Workflow
source is limited to 512 KiB and may use top-level `await` and `return`.

The workflow global API is:

- `args`: the strict JSON input.
- `agent(prompt, options?)`: run one provider call.
- `parallel(thunks)`: run branches concurrently and preserve input order.
- `pipeline(items, ...stages)`: process items concurrently while stages for
  each item remain serial.
- `phase(title)`: change the current display and event phase.
- `log(message)` and `console.*`: emit workflow log events.
- `workflow(reference, args?)`: invoke one child workflow.
- `budget.total`, `budget.spent()`, and `budget.remaining()`.
- bounded `setTimeout` and `clearTimeout`.

Supported `agent` options are:

```js
{
  label: "stable call label",
  phase: "phase name",
  schema: { type: "object" },
  model: "provider model or configured tier",
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  isolation: "worktree",
  agentType: "registered-agent-name",
}
```

Non-cancellation failures inside `parallel` and `pipeline` become `null` and
emit a log, matching the reviewed compatibility profile. A `null` pipeline
value skips the remaining stages for that item. Child workflows inherit the
root provider and shared limits; a child cannot recursively start another child.

The VM deliberately exposes no `process`, `require`, filesystem API, CommonJS
globals, static or dynamic imports. String and WebAssembly code generation,
`Date.now()`, bare or zero-argument `Date`, and `Math.random()` are disabled.
This is a deterministic compatibility boundary, not a hostile-code sandbox.

## Configuration

Precedence, from highest to lowest:

```text
CLI > AWSL_* > <project>/.awsl/config.toml > user config > defaults
```

Recognized environment variables are:

- `AWSL_PROVIDER`
- `AWSL_STATE_DIR`
- `AWSL_RAW_PROVIDER_EVENTS`
- `AWSL_CODEX_COMMAND`
- `AWSL_CLAUDE_COMMAND`

The project config is `.awsl/config.toml`. On macOS, user configuration and
state live below `~/Library/Application Support/awsl`. On Linux and WSL they
use `${XDG_CONFIG_HOME:-~/.config}/awsl` and
`${XDG_STATE_HOME:-~/.local/state}/awsl`.

Example:

```toml
provider = "codex"
raw_provider_events = false

[providers.codex]
executable = "codex"
args = []
profile = "default"

[providers.codex.tiers.fast]
model = "gpt-5.6-terra"
effort = "low"

[registry]
plugin_dirs = []
```

Provider tables accept `executable`, `args`, `default_model`,
`native_models`, `tiers`, and `models`; `profile` is Codex-only.
`awsl config show` reports merged values, field provenance, and hashed config
sources, with defensive redaction.

Provider CLIs may apply their own ambient project rules, instructions, hooks,
MCP configuration, and permission settings. awsl does not independently
reproduce or certify every ambient provider setting. When a requested
`agentType` policy cannot be expressed by an adapter without broadening its
permissions, awsl fails closed.

## Durable state and resume

Runs have `running`, `paused`, `completed`, `failed`, or `killed` status. State
is private by default: directories use mode 0700 and state, journal, lock, and
optional raw-event files use mode 0600.

Resume replays only the longest valid contiguous `journal-key-v2` prefix.
Calls after the first missing or mismatched entry execute again. This gives
at-least-once behavior: if an external side effect completed but its successful
journal record was not durably stored, a resume can repeat that call. Workflow
authors must use idempotency keys or their own reconciliation for side effects.

`awsl runs pause` verifies both PID and process-start identity before signalling
the owner. Opening, listing, or resuming a run repairs only a verified stale
terminal lock.

## Worktrees

`agent(prompt, { isolation: "worktree" })` creates a per-call Git worktree from
the root run's pinned base. awsl never merges it into the original worktree.
Clean successful worktrees are removed; dirty, failed, or cancelled worktrees
are retained and reported for inspection.

## Events

The stable envelope is:

```json
{
  "version": 1,
  "type": "run.started",
  "timestamp": "2026-07-28T00:00:00.000Z",
  "runId": "opaque-run-id",
  "data": {}
}
```

Runtime event types include `run.started`, `run.completed`, `run.failed`,
`run.killed`, `run.paused`, `call.scheduled`, `call.started`,
`call.completed`, `call.failed`, `call.reused`, `phase.changed`,
`workflow.log`, `worktree.created`, and `worktree.retained`. Non-run CLI
commands can emit `command.completed`.

The `data` object is event-specific and may gain fields. Consumers should
dispatch on `version` and `type`, ignore unknown fields, and tolerate unknown
event types.

## Security boundary

Workflow files are trusted code. Provider processes are spawned directly with
an executable and argument vector, never through a shell. awsl does not save the
complete environment or provider credentials. Stored events and JSONL output
redact common authorization headers, cookies, tokens, passwords, credentials,
signatures, API keys, and AWS credential fields.

Raw provider event capture is disabled by default. Enabling
`raw_provider_events` or `AWSL_RAW_PROVIDER_EVENTS=true` creates additional
redacted diagnostic data, but users should still treat it as sensitive.

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/XhinLiang/awsl/security/advisories/new).
The `main` branch and latest release are supported; older releases are not.

Read [SECURITY.md](SECURITY.md) before running third-party workflows.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run build
pnpm run test:package
pnpm run test:conformance
pnpm run sbom
git diff --check
```

CI runs the release gate on Node 22 for Ubuntu and macOS. Oracle capture is
explicitly opt-in and is never run by CI.

The generated `sbom.cdx.json` is a deterministic CycloneDX 1.6 inventory of the
production dependency closure in `pnpm-lock.yaml`. It describes the release
build; dependency ranges can resolve differently in a later consumer install.

## Release prerequisites

`.github/workflows/release.yml` publishes only from a published GitHub Release
whose tag exactly matches `v<package version>`. The official repository pins
the package identity to `@xhinliang/awsl`, uses the `release.yml` npm trusted
publisher, and has immutable releases enabled.

Before each release, an authorized maintainer must confirm the required
licensing and organizational open-source approval. The release job uses GitHub
OIDC and npm provenance. It contains no long-lived npm publication token.

## License

awsl is licensed under the Apache License 2.0. Public CI uses an independently
authored 19-call orchestration profile. External and vendor fixtures are
excluded from the repository and release package.
