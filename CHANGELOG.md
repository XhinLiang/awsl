# Changelog

All notable changes to this project will be documented in this file.

## 0.3.0 - 2026-08-19

### Added

- Add versioned run timing summaries to JSON terminal envelopes and `awsl runs
  show`, including attempts, resume idle time, phase parallelism, and per-call
  queue/execution/retry durations derived from durable lifecycle events.

- Publish `awsl-workflow@1` as an implementation-backed portable workflow ABI
  proposal, with explicit source, runtime, failure, replay, and non-goal
  boundaries.
- Add a five-workflow gallery for code review, knowledge compilation, incident
  investigation, isolated migration, and research synthesis.
- Add `awsl init` with a compact starter and selectable gallery templates,
  using create-only writes so existing workflow files are never overwritten.
- Add `awsl demo`, a built-in three-logical-call parallel workflow with a
  default 8k output-token gate, explicit active-call overshoot semantics, and
  full durable-run behavior.

- Add `awsl --install-skills` to install the bundled awsl Codex Skill in the
  user-level `~/.agents/skills` directory.
- Add bounded retries for explicitly recoverable, zero-output provider
  failures, with Codex transient-failure classification and `call.retrying`
  lifecycle events.

### Changed

- Route the default Codex `fast` tier to `gpt-5.6-luna` at low reasoning
  effort, while preserving the existing Claude Haiku, Codex balanced, and
  Codex strong mappings.

- Position awsl as the Agent Workflow State Layer: a Codex-verified, durable
  local runtime for compatible Claude Code Workflows, while keeping
  authenticated Claude acceptance as an explicit evidence gap.

### Security

- Pin the patched transitive `nanoid@3.3.18` used by the development toolchain.

## 0.2.0 - 2026-08-06

### Added

- Stable `awsl-workflow@1` ABI reporting and agent-oriented CLI help with
  examples, input rules, output semantics, and nested command discovery.
- Runnable research, code-review, worktree, and durable-resume example
  workflows with offline contract tests.
- Public positioning, migration, contribution, and community guidance.

### Changed

- Accept strictly branded provider semantic versions without a patch-version
  allowlist, report unverified versions, and base doctor readiness on the
  selected provider while preserving exact-version resume pins.
- Improve npm discovery metadata and the repository onboarding experience.

### Fixed

- Make `awsl help`, nested help paths, and an empty invocation exit successfully,
  while rejecting unknown nested commands instead of showing misleading help.
- Update the transitive `fast-uri` dependency to the patched `3.1.5` release.

## 0.1.1 - 2026-07-30

### Fixed

- Allow Codex workflows to run from non-Git working directories.
- Preserve the original provider failure when output-token usage is
  indeterminate.

## 0.1.0 - 2026-07-30

### Added

- JavaScript workflow compilation and deterministic worker execution.
- Codex and Claude CLI provider adapters with fixed-provider workflow trees.
- Agent, parallel, pipeline, phase, log, child-workflow, budget, and worktree
  APIs.
- Durable run state, longest-prefix resume, lifecycle signals, and versioned
  JSONL events.
- Provider Pin V2 for configured native models and attempt-scoped retained
  worktree paths across resume.
- CLI inspection, configuration provenance, doctor, run management, and
  pretty/JSON/JSONL output.
- Package install smoke tests, an independently authored 19-call orchestration
  profile, a reviewed synthetic 2.1.218-informed replay, and a deterministic
  CycloneDX SBOM.
- Public npm package identity `@xhinliang/awsl` with the `awsl` executable.

### Security

- Private state modes, direct process spawning, strict paths and JSON, bounded
  inputs and durable outputs, descendant cleanup, defensive redaction,
  regex-schema rejection, and fail-closed agent policy negotiation.

Compatibility is limited to behaviors supported by evidence in
`docs/compatibility/claude-code-2.1.218.md`; this entry does not certify
universal Claude Code equivalence.
