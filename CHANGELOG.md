# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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
