# Contributing

Thank you for improving AWSl.

By submitting a contribution, you agree that it may be distributed under the
Apache License 2.0 and that you have the right to provide it. Do not add
third-party source, fixtures, generated output, credentials, or model
transcripts unless their provenance and redistribution terms are documented.

## Development setup

Use Node.js 22 or newer:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Before opening a change, run:

```bash
pnpm run check
pnpm run test
pnpm run build
pnpm run test:package
pnpm run test:conformance
git diff --check
```

Tests must not require provider credentials, mutate an external repository, or
contact external services. Use provider protocol fixtures for deterministic
coverage. Real-provider and Claude oracle capture commands are opt-in acceptance
evidence and must remain separate from CI.

Behavior changes should start with a failing regression test. Compatibility
claims must name the exact profile, command or fixture that supports them, and
whether the evidence came from a real provider, a protocol fixture, or a
reviewed oracle capture.

## Code and documentation

- Keep workflow and JSON limits fail-closed.
- Preserve deterministic event, journal, and resume behavior.
- Do not weaken provider policy or path validation for convenience.
- Keep public package exports intentional; internal `dist` paths are not API.
- Update `CHANGELOG.md` and the compatibility report for observable changes.
- Never commit raw provider events, unredacted transcripts, session IDs,
  absolute user paths, or credentials.

Use focused commits and do not rewrite unrelated user changes.
