## Summary

Describe the user-visible or runtime-contract change.

## Motivation

Explain the workflow problem and why it belongs in awsl.

## Verification

- [ ] `pnpm run check`
- [ ] Relevant unit or integration tests
- [ ] `pnpm run test:conformance` when workflow behavior changes
- [ ] `pnpm run test:package` when the published package changes
- [ ] Real-provider evidence is included, or the missing evidence is stated

List the commands run and their results:

```text

```

## Compatibility and risk

- [ ] Public CLI, JavaScript API, events, and durable-state effects are described
- [ ] Provider-version or protocol assumptions are explicit
- [ ] Resume and at-least-once side effects were considered
- [ ] Security, redaction, permissions, and worktree effects were considered
- [ ] Backward-incompatible behavior is called out

## Documentation and release

- [ ] Documentation and `CHANGELOG.md` are updated when needed
- [ ] No credentials, private prompts, raw provider transcripts, or sensitive paths are included
