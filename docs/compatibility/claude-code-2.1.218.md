# Compatibility with Claude Code 2.1.218

## TL;DR

- AWSl records observable workflow behavior for the pinned Claude Code profile; it does not claim byte-for-byte or future-version compatibility.
- An independently authored 19-call fixture exercises public orchestration, phase accounting, event ordering, durable state, and side-effect isolation.
- Real-provider evidence remains limited to the exact Codex scenarios and versions stated below; authenticated Claude evidence is still absent.

**Profile:** `claude-code@2.1.218`

**Report date:** 2026-07-29

**Overall status:** `partial`

AWSl implements the observable JavaScript workflow behaviors listed below. This
report does not claim byte-for-byte equivalence, compatibility with future
Claude Code releases, or equivalence for rows marked `partial` or `gap`.

Statuses:

- `verified`: passed with the stated evidence.
- `partial`: only a subset or a non-authoritative evidence path passed.
- `gap`: the required evidence or capability is absent.

Evidence types:

- `real-provider`: a real Codex or Claude executable was invoked.
- `fixture-provider`: a side-effect-free executable speaking the provider's
  public protocol was invoked.
- `synthetic-oracle`: replay against a reviewed, digest-locked expected
  observation; this is not a live Claude capture.
- `static`: parser, unit, integration, package, source, or configuration
  evidence that did not invoke a real model provider.
- `none`: no supporting execution evidence exists; the pointer records the
  missing command or external prerequisite instead.

## Runtime behavior

| Behavior | Status | Evidence | Evidence pointer | Boundary |
|---|---|---|---|---|
| Installed `awsl <workflow.js>` command and package export | `verified` | `static` | `tests/package/install-smoke.test.ts` — `packed CLI installs and runs from a clean directory`; `pnpm run test:package` | The smoke test packs, installs with cache-first dependency resolution, invokes the CLI, and imports the package root. |
| Pure-literal metadata, top-level `await`/`return`, and 512 KiB source limit | `verified` | `static` | `tests/compat/compile.test.ts` — `extracts pure metadata and permits top-level await and return`, `enforces the UTF-8 512 KiB source limit at its boundary` | The parser and compiler behavior is local and deterministic. |
| Restricted deterministic VM and IPC boundary | `verified` | `static` | `tests/worker/sandbox.test.ts` — `does not expose process or require`, `enforces sync and async watchdogs and aborts timer promptly`, `strictly rejects getters, proxies, hidden fields, and array properties without reading getters` | This is a constrained trusted-workflow runtime, not hostile-code isolation. |
| `parallel()` ordering, barrier, branch-null behavior, and cancellation | `verified` | `static`, `fixture-provider` | `tests/worker/sandbox.test.ts` — `parallel preserves order, turns local failures into null, and rejects invalid input`; `tests/runtime/engine.test.ts` — `returns null for a failed provider branch without failing parallel`; `pnpm run test:conformance` | The public orchestration fixture also traverses parallel provider calls. |
| `pipeline()` concurrent items, serial per-item stages, null short-circuit, and ordered results | `verified` | `static` | `tests/worker/sandbox.test.ts` — `pipeline preserves item order, serial stages and null short circuit`, `pipeline has no cross-item stage barrier` | The second regression proves stages are serial per item without a global stage barrier. |
| `phase()`, `log()`, structured events, and pretty/JSON/JSONL output | `verified` | `static`, `fixture-provider` | `tests/worker/sandbox.test.ts` — `proxies agent, phases, logs and every console level over IPC`; `tests/cli/run.test.ts` — `JSONL emits only versioned events`, `pretty writes progress to stderr and the business result to stdout`, `runs a real Codex JSONL protocol fixture and includes result in completion` | Output modes and event ordering are asserted. |
| Text and schema `agent()` results | `verified` | `static`, `fixture-provider` | `tests/runtime/engine.test.ts` — `validates structured results again before completing the call`; `tests/providers/schema.test.ts` — `rejects workflow-controlled regular expressions`, `rejects workflow-controlled schema references`; `tests/cli/run.test.ts` — `runs a real Codex JSONL protocol fixture and includes result in completion` | Workflow-controlled regex keywords and schema references are rejected to avoid coordinator-side ReDoS. |
| Project and namespaced-plugin child workflows | `verified` | `static` | `tests/runtime/engine.test.ts` — `runs project and namespaced plugin workflows in the parent run`, `shares budget, counters, run identity, and a forced child phase` | Parent run identity, provider pin, shared budget, forced child phase, and registry provenance are checked. |
| Nested-workflow depth and shared provider/semaphore/budget/call cap | `verified` | `static` | `tests/runtime/engine.test.ts` — `rejects a grandchild before launching an agent`, `enforces the shared 1000-call cap before replaying a cached child call`; `tests/runtime/scheduler.test.ts` — `never exceeds its limit and admits work in FIFO order` | Grandchildren fail before provider launch. |
| Fixed provider identity and no provider fallback | `verified` | `static`, `fixture-provider` | `tests/config/provider-identity.test.ts` — `normalizes only the exact trimmed banners and rejects controls, BOM, and foreign versions`; `tests/providers/process.test.ts` — `uses exact argv and cwd, inherits env, and keeps hostile text off a shell`; `tests/runtime/engine.test.ts` — `rejects a resume pin mismatch before locking, replay, or provider use` | Executable, exact supported version, cwd, sources, model policy, and fingerprints are pinned. |
| Configured private native-model pinning | `verified` | `static` | `tests/config/provider-pin.test.ts` — `captures configured native models for a discovered default`, `upgrades a legacy V1 base-native default but rejects a downgrade`; `tests/runtime/engine.test.ts` — `rejects a legacy V1 pin for a fresh run before locking or provider use`, `durably discovers and resumes a configured native default`, `upgrades a V1 pin to V2 before a live resumed call` | Provider Pin V2 persists the sorted configured-native set. V1 is legacy-read-only and upgrades only after shared fingerprints match; V2-to-V1 is rejected. |
| Output-token budget, bounded active-call overshoot, and 1,000-call cap | `verified` | `static` | `tests/runtime/budget.test.ts` — `allows an active completion to overshoot and gates only later work`; `tests/runtime/engine.test.ts` — `enforces the shared 1000-call cap before replaying a cached child call` | Budget is charged from output tokens and shared across nested work. |
| Durable state, bounded streams, append-only journal, and longest-prefix replay | `verified` | `static` | `tests/runtime/engine.test.ts` — `writes a validator-clean file journal and resumes its longest prefix`; `tests/store/run-store.test.ts` — `strictly and boundedly reads run, result, and lock snapshots`; `tests/store/run-store-fake-ops.test.ts` — `never truncates a valid final stream record after LF repair I/O fails` | Matching read/write limits and bounded tail repair are asserted. |
| Signals, pause, terminal state, and stable exit codes | `verified` | `static`, `fixture-provider` | `tests/cli/process.test.ts` — generated `SIGINT persists killed and exits 130` and `SIGTERM persists killed and exits 143` cases, plus `runs pause verifies the owner and waits for a durable paused run`; `tests/cli/state.test.ts` — `repairs a proven orphan and makes started work at-least-once` | CLI lifecycle tests use child processes and protocol fixtures. |
| Clean, dirty, failed, cancelled, and resumed worktree lifecycle | `verified` | `static` | `tests/runtime/worktree.test.ts` — `pins detached HEAD, maps a nested cwd, and removes clean success`, `retains dirty, failed, and cancelled worktrees with bounded reasons`; `tests/runtime/engine.test.ts` — `removes a clean worktree when its snapshot persistence fails before provider launch`, `removes a clean worktree when its event persistence fails before provider launch`, `preserves the stored Git base if resume attempt journaling fails`, `preserves the stored Git base when its resume revalidation fails`, `keeps a retained worktree while a later attempt uses a distinct path` | Physical names are attempt-scoped; resume preserves the pinned base before its first snapshot and after a failed revalidation. Exact Claude changed-worktree behavior remains oracle-gated. |
| Direct shell-free provider launch and descendant cleanup | `verified` | `static`, `fixture-provider` | `tests/providers/process.test.ts` — `uses exact argv and cwd, inherits env, and keeps hostile text off a shell`, `cleans an inherited-stdio descendant as soon as the successful provider exits`, `cleans an inherited-stdio descendant before reporting a nonzero exit`, and the cancellation process-group case | POSIX success, failure, cancellation, bounded streams, and descendant cleanup are exercised through an executable fixture. |
| Secret redaction and private durable-state modes | `verified` | `static` | `tests/store/redact.test.ts` — `redacts sensitive structure and every string leaf`, `redacts a bare valid Basic authorization credential`; `tests/cli/state.test.ts` — `uses a stable collision-resistant project namespace and private hierarchy` | Authorization and proxy authorization, Bearer and valid Basic credentials, cookies, token fields, and private modes are covered. |
| macOS and Linux hosted release gate | `partial` | `static` | `.github/workflows/ci.yml`; `tests/package/ci-security.test.ts` — `pins every GitHub Action to an immutable commit`; local command: `pnpm run check` | CI defines Node 22 jobs for both systems. This checkout has no hosted run or WSL evidence. |

The complete local gate is:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run build
pnpm run test:package
pnpm run test:conformance
pnpm run sbom
git diff --check
```

## Provider and oracle evidence

AWSl accepts exactly Codex CLI `0.145.0` or `0.146.0` and Claude Code
`2.1.218`. `awsl doctor` and run preparation fail closed for other versions;
those exact versions are part of this profile rather than a promise about later
provider releases. The real-provider Codex evidence below remains specific to
`0.145.0`; `0.146.0` support is covered by version-locked static and fixture
tests, not a claimed real-provider acceptance run.

| Behavior | Status | Evidence | Evidence pointer | Boundary |
|---|---|---|---|---|
| Real Codex no-tools round trip | `verified` | `real-provider` | Direct built-CLI command with canonical isolated state and `AWSL_RAW_PROVIDER_EVENTS=false`; see [real Codex acceptance record](../implementation/260729-real-codex-acceptance.md). | Codex `0.145.0` returned `AWSL_SMOKE_OK` with complete usage. No provider transcript is committed. |
| Real Codex file read, cwd, and project-instruction application | `verified` | `real-provider` | Direct built-CLI command from `tests/fixtures/real-provider-project`, with canonical isolated state and `AWSL_RAW_PROVIDER_EVENTS=false`; see [real Codex acceptance record](../implementation/260729-real-codex-acceptance.md). | The acceptance returned the file, cwd, and project markers; the unchanged fixture digest was `930489592d120658676b02f4f4264ce0b37901da4b43799c0e39e21de4d14316`. |
| Real Codex hooks, MCP, and all permission modes | `partial` | `real-provider`, `static` | Read-marker acceptance and `tests/providers/codex.test.ts` — `publishes only capabilities the adapter can actually enforce`; see [real Codex acceptance record](../implementation/260729-real-codex-acceptance.md). | The real run proves file-tool and project-instruction behavior, not hooks, MCP, or every ambient permission configuration. |
| Codex stream success, failure, schema, and usage normalization | `verified` | `real-provider`, `static` | No-tools acceptance and `tests/providers/codex.test.ts` — `consumes a complete event stream and preserves public observations`, `returns turn failures as an error outcome while retaining usage`, `writes a private structured schema file, parses the final JSON, and cleans up`; see [real Codex acceptance record](../implementation/260729-real-codex-acceptance.md). | Static adapter tests cover the public `codex exec --json` shapes; the real smoke covers the success path and exact version. |
| Codex implicit default-model discovery | `gap` | `static` | `tests/config/provider-pin.test.ts` — `keeps fingerprint-only null, then stores one detached frozen public default`; `tests/providers/codex.test.ts` — `consumes a complete event stream and preserves public observations`; see [real Codex acceptance record](../implementation/260729-real-codex-acceptance.md). | Codex `0.145.0` exposes no stable resolved-model event. Explicit defaults pin; unreported implicit defaults remain unresolved. |
| Claude stream protocol, schema loop, tool events, null, and error normalization | `partial` | `static` | `tests/providers/claude.test.ts` — `returns the authoritative successful result and complete usage`, `fails closed after the sixth StructuredOutput tool use without another session`, `accepts the version-locked tool loop and awaits raw events in order`, `maps success/is_error true to the evidenced compatibility null` | These injected protocol tests do not constitute an authenticated executable round trip. |
| Real Claude no-tools and read-marker workflows | `gap` | `real-provider` | Attempted smoke command is the Codex command above with `--provider claude`; prerequisite check `claude auth status --json` returned `loggedIn:false` | The executable was inspected, but authentication blocked a provider acceptance run. |
| Public clean-room 19-call orchestration | `verified` | `fixture-provider` | `tests/conformance/orchestration.test.ts` — `executes an independently authored 19-call orchestration profile`; `AWSL_CODEX_COMMAND="$PWD/tests/fixtures/bin/fake-codex-orchestration.mjs" pnpm awsl tests/fixtures/workflows/orchestration-19.js --provider codex --args '{"fixture":"AWSL_ORCHESTRATION_19"}' --format json` | The executable fixture completes 19 launches with `setup=2`, `summarize=10`, `finalize=5`, and `commit=2`, without cwd or sentinel side effects. |
| Reviewed 2.1.218-informed replay | `partial` | `synthetic-oracle` | `tests/conformance/oracle-golden.test.ts` — `replays the reviewed 2.1.218-informed synthetic profile`; `pnpm run test:conformance` | The committed golden is digest-locked as `sha256:757323ff84b0ac5794a5162da2e9a5f2a4f7378eff70f6c19a1f5b18015b03c3` and identifies itself as synthetic. |
| Authenticated Claude Workflow oracle capture | `gap` | `none` | Required command: `AWSL_CAPTURE_CLAUDE_ORACLE=1 node scripts/capture-claude-oracle.mjs`; not run successfully because `claude auth status --json` reported `loggedIn:false` | No live capture exists. The inspected binary digest does not attest that it produced the committed observation. |
| Oracle capture guardrails | `verified` | `static` | `tests/conformance/oracle-golden.test.ts` — `keeps live Claude oracle capture opt-in and fail-closed`, `rejects a version-spoofing Claude command before executing it` | Capture is opt-in, CI-disabled, Darwin arm64-only, exact-version-only, and binary-digest-only. |

Provider CLIs may apply their own ambient project and user configuration. AWSl
does not independently reproduce or certify all ambient hooks, MCP servers, or
permission settings. For named-agent restrictions, the selected adapter must
express the policy without broadening it or AWSl rejects the call.

## Release readiness

| Requirement | Status | Evidence | Evidence pointer | Boundary or blocker |
|---|---|---|---|---|
| Public-source hygiene and Apache-2.0 files | `partial` | `static` | `tests/package/source-distribution.test.ts` — `excludes the complete external fixture directory`, `keeps public source free of private context and release secrets`; `pnpm run test:package` | The source check rejects ignored fixture paths, private context, personal build paths, and secret-shaped literals. Publication still requires an authorized owner/licensor and any required organizational OSS approval. |
| Installable allowlisted tarball | `verified` | `static` | `tests/package/install-smoke.test.ts` — `packed CLI installs and runs from a clean directory`; `pnpm run test:package` | The test rejects source, tests, lockfiles, secrets, unexpected paths, and embedded source content, then installs and runs in a clean project. |
| Installer-visible security and compatibility documentation | `verified` | `static` | `tests/package/install-smoke.test.ts` — `packed CLI installs and runs from a clean directory`; `pnpm pack --pack-destination <temporary-directory>` | The tarball contains `SECURITY.md`, this report, `CHANGELOG.md`, and the generated SBOM. |
| Deterministic CycloneDX 1.6 SBOM | `verified` | `static` | `tests/package/sbom.test.ts` — `generates a deterministic production-only CycloneDX SBOM`; `pnpm run sbom` | The generator records the production lock closure and integrities and is byte-reproducible. Consumer resolution may differ within compatible ranges. |
| Fail-closed release workflow | `verified` | `static` | `tests/package/ci-security.test.ts` — `keeps publication OIDC-only and fail-closed on release identity`, `pins every GitHub Action to an immutable commit`; `pnpm exec vitest run tests/package/ci-security.test.ts` | The workflow stops before publication until an owned package identity is configured and validates the repository and security-policy identity. |
| Concrete private vulnerability channel and supported-version policy | `verified` | `host+static` | GitHub private vulnerability reporting is enabled for `XhinLiang/awsl`; `SECURITY.md`; release guard in `.github/workflows/release.yml`; `pnpm exec vitest run tests/package/ci-security.test.ts` | The repository-specific private reporting channel is enabled and the `main`/latest-release support policy is configured. |
| Owned npm package identity | `gap` | `static` | `npm view awsl name version`; `node -p "require('./package.json').name"` | Unscoped `awsl` is already registered. An authorized owner must choose and acquire a scoped name. |
| Public repository metadata and trusted publisher | `partial` | `static` | `package.json` identifies `https://github.com/XhinLiang/awsl`; `.github/workflows/release.yml` validates the runtime repository identity. | Repository metadata is configured. npm trusted publishing and provenance still require an owned scoped package and host-side configuration. |
| Immutable release tag and published package | `gap` | `none` | `git tag --list` has no release tag; repository release immutability and tag protection require the future host; no authorized scoped package exists to query | No tag or AWSl package has been published. |
| Hosted CI result for the final revision | `gap` | `none` | `.github/workflows/ci.yml` defines the gate, but no hosted run is recorded in this report. | A hosted run is required for the published revision. |

## Known gaps

- Codex user-skip and terminal API-error discrimination has no stable public
  discriminator in Codex `0.145.0`; AWSl fails closed.
- Retry/stall timing and structured-output retry behavior are bounded and
  tested but not live-oracle certified.
- Complete custom-agent merge behavior, provider model fallback, and full JSON
  Schema draft parity are not claimed.
- Exact Claude crash-adoption, changed-worktree, and VM sanitizer details remain
  oracle-gated.
- Claude's proprietary `/workflows` TUI, remote task infrastructure, CCR,
  internal telemetry, and internal transcript formats are out of scope.
- Native Windows is out of scope; the first release targets macOS, Linux, and
  Windows through WSL.
