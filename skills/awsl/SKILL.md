---
name: awsl
description: Run Claude Code JavaScript Workflows through the awsl compatibility runtime. Use when an agent's current task or loaded Skill requires dispatching a Claude Code Workflow but the host cannot execute that Workflow natively, or when awsl workflow inspection, durable run state, resume, or provider diagnostics are needed.
---

# Claude Code Workflow compatibility

Use the installed `awsl` executable as the workflow runtime. Run `awsl help`
or `awsl help <command>` when repository instructions do not provide the
complete invocation contract.

Do not search for or select repository Skills on awsl's behalf. The calling
agent remains responsible for its current task and loaded Skill. Use this Skill
only after those instructions require a Claude Code Workflow and native
Workflow dispatch is unavailable or incompatible.

## Adapt the dispatch

When current instructions dispatch a request shaped like:

```json
{ "name": "<workflow>", "args": {} }
```

1. Preserve the calling instructions' prerequisite checks, argument defaults,
   modes, and reporting contract.
2. Use the explicit Workflow implementation path from the calling
   instructions. If only a name is provided, resolve it to
   `.claude/workflows/<workflow>.js` below the repository root.
3. Read the Workflow's literal `meta` and confirm `meta.name` matches the
   dispatch name.
4. Do not copy, migrate, symlink, or edit the calling Skill or Workflow to make
   it compatible.

## Run the workflow

1. Validate locally with `awsl workflow inspect <workflow>` when the path or
   Workflow ABI is uncertain.
2. Translate the existing dispatch to the CLI:

```bash
awsl run <workflow> --provider codex --cwd <repo-root> --args '<strict-json>'
```

Pass only the dispatch object's `args` value to `--args`; `name` selects the
Workflow and is not part of its arguments. Do not invent missing values,
reinterpret the calling instructions, or reimplement the Workflow as ad hoc
model calls. Prefer `--args-file` when JSON is large or shell quoting would be
fragile.

## Continue or diagnose

- Run `awsl doctor` when the executable or Codex provider is unavailable.
- awsl automatically retries only safe transient failures that occur before
  provider output or tool activity; do not wrap `awsl run` in another blind
  retry loop.
- Run `awsl runs list` and `awsl runs show <run-id>` before deciding whether a
  failed or interrupted operation should resume.
- Use `awsl resume <run-id>` only when the repository workflow's own run ID and
  awsl's durable run ID have been identified correctly; they may be different.
- Report the workflow's terminal result. On failure, preserve repository
  checkpoints and include the awsl run ID needed for continuation.
