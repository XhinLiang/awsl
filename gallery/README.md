# Workflow gallery

## TL;DR

These five runnable workflows show distinct orchestration patterns supported by
`awsl-workflow@1`. They are provider-neutral, return structured results, and
state their intended agent access. A read-only prompt is not an enforced
sandbox boundary; the selected provider policy still governs what an agent can
do.

| Workflow | Use case | Pattern | Agent access |
|---|---|---|---|
| [Code review](../examples/parallel-code-review.js) | Review one change from independent perspectives | Parallel specialists, then adjudication | Prompted read-only; provider policy applies |
| [Knowledge compile](../examples/knowledge-compile.js) | Turn repository evidence into a reusable knowledge brief | Parallel evidence collection, then compilation | Prompted read-only; provider policy applies |
| [Incident investigation](../examples/incident-investigation.js) | Build an evidence-ranked incident assessment | Parallel hypotheses, then incident lead synthesis | Prompted read-only; provider policy applies |
| [Migration](../examples/migration.js) | Plan and implement a bounded code migration | Durable plan, then isolated implementation | Worktree cwd; provider policy applies |
| [Research panel](../examples/research-panel.js) | Explore a question before making a decision | Independent perspectives, then synthesis | Prompted read-only; provider policy applies |

Run a workflow from the repository it should inspect or change:

```bash
awsl run /path/to/awsl/examples/incident-investigation.js \
  --args '{"incident":"API requests intermittently return 502"}' \
  --budget 20000
```

Each file documents its required arguments. Use `awsl workflow inspect <file>`
to inspect metadata without invoking a model. Set a budget appropriate for the
task before running a multi-agent workflow.
