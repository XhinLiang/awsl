# Contributing to awsl

Thanks for helping make coding-agent workflows more reliable.

By submitting a contribution, you agree that it may be distributed under the
Apache License 2.0 and that you have the right to provide it. Do not add
third-party source, fixtures, generated output, credentials, or model
transcripts unless their provenance and redistribution terms are documented.

## Before you start

- Use an issue or Discussion for contract changes, new provider behavior, or
  changes to durable state and resume semantics.
- Report vulnerabilities through
  [GitHub private vulnerability reporting](https://github.com/XhinLiang/awsl/security/advisories/new),
  not a public issue.
- Never attach credentials, private prompts, raw provider transcripts, or
  sensitive run-state files.

## Local setup

awsl requires Node.js 22 or newer and pnpm 9.15.4 through Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

## Pull requests

Keep changes focused and explain their effect on the public CLI, JavaScript
workflow API, events, compatibility profile, and durable state. Add tests for
behavior changes and state any real-provider evidence that is still missing.
Behavior changes should start with a failing regression test.

Tests must not require provider credentials, mutate an external repository, or
contact external services. Use provider protocol fixtures for deterministic
coverage. Real-provider and Claude oracle capture commands are opt-in acceptance
evidence and must remain separate from CI.

Compatibility claims must name the exact profile, command or fixture that
supports them, and whether the evidence came from a real provider, a protocol
fixture, or a reviewed oracle capture.

Run the release gate before opening a pull request:

```bash
pnpm run check
pnpm run test
pnpm run build
pnpm run test:package
pnpm run test:conformance
pnpm run sbom
git diff --check
```

Workflow files are trusted code. Examples and tests must use inert inputs and
fixture providers unless a real-provider run is explicitly opt-in and its
evidence is sanitized.

## Code and documentation

- Keep workflow and JSON limits fail-closed.
- Preserve deterministic event, journal, and resume behavior.
- Do not weaken provider policy or path validation for convenience.
- Keep public package exports intentional; internal `dist` paths are not API.
- Update `CHANGELOG.md` and the compatibility report for observable changes.
- Never commit raw provider events, unredacted transcripts, session IDs,
  absolute user paths, or credentials.
- Use focused commits and do not rewrite unrelated changes.

## Compatibility changes

Provider versions and observable behavior are compatibility inputs. Changes to
provider invocation, model routing, permissions, concurrency, resume, budgets,
worktrees, or event schemas must update the relevant compatibility evidence and
call out unsupported or unverified behavior.
