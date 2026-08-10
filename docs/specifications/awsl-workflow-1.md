# awsl-workflow@1

**Status:** Proposal

**Category:** Portable workflow ABI proposal

**Owner:** awsl project

## TL;DR

`awsl-workflow@1` defines the portable boundary between a trusted JavaScript
workflow and an agent runtime: the source shape, metadata, global functions,
failure behavior, result values, budgets, and resume identity. It is an
awsl-owned proposal backed by the current implementation. It is not an
industry standard and does not version a provider executable.

An implementation can execute an `awsl-workflow@1` program without exposing
Node.js, a filesystem, or provider-specific process details to the workflow.

## 1. Source module

A workflow is a UTF-8 JavaScript source file no larger than 512 KiB.

The first statement MUST be exactly one declaration of this form:

```js
export const meta = {
  name: "review",
  description: "Review a change",
}
```

The initializer MUST be a pure literal. It may contain strings, booleans,
`null`, finite numbers, negative finite numeric literals, arrays without holes,
objects, and template literals without interpolation. It MUST NOT contain
spread properties, computed properties, methods, accessors, regular
expressions, `BigInt`, or the object keys `__proto__`, `constructor`, and
`prototype`.

No other export, static or dynamic import, or `import.meta` is allowed. The
body may use top-level `await` and `return`.

## 2. Metadata

`meta.name` and `meta.description` MUST be non-empty strings. The following
fields are recognized:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Stable workflow name |
| `description` | string | Short description |
| `title` | string | Optional display title |
| `whenToUse` | string | Optional routing guidance |
| `phases` | array | Optional display metadata for phases |

A phase entry is retained when its `title` is a string. Its optional `detail`
and `model` values are retained when they are strings. Unknown metadata fields
and invalid optional phase entries are ignored.

## 3. Runtime globals

The workflow body receives these globals:

| Global | Contract |
|---|---|
| `args` | Strict JSON input, or `undefined` when omitted |
| `agent(prompt, options?)` | Execute one provider call |
| `parallel(thunks)` | Execute all thunks concurrently and preserve input order |
| `pipeline(items, ...stages)` | Process items concurrently; stages for one item remain serial |
| `workflow(reference, args?)` | Execute one child workflow |
| `phase(title)` | Set the current root workflow phase |
| `log(message)` | Emit an informational workflow log |
| `console.*` | Emit `log`, `info`, `warn`, `error`, or `debug` workflow logs |
| `budget` | Read the shared output-token budget |
| `setTimeout`, `clearTimeout` | Use bounded runtime timers |

`agent` requires a string prompt. Its options object accepts only:

```js
{
  label: "display label",
  phase: "display phase",
  schema: { type: "object" },
  model: "provider model or configured tier",
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  isolation: "worktree",
  agentType: "registered-agent-name",
}
```

Without `schema`, `agent` normally resolves to provider text. With `schema`, it
normally resolves to strict JSON that satisfies the schema. A Claude-compatible
terminal API error resolves to `null`; this compatibility outcome is completed
but is not eligible for replay. Other provider and validation failures reject.
A workflow tree may start at most 1,000 agent calls.

An inline `schema` is limited to 64 KiB. An omitted `$schema` means JSON Schema
Draft 7; the Draft 7 and Draft 2020-12 canonical dialect URLs are supported.
Schema references (`$ref`, `$dynamicRef`, and `$recursiveRef`), regular
expression keywords (`pattern`, `patternProperties`, and the `regex` format),
and asynchronous validators are rejected. Validation uses strict schema mode.

`parallel` requires an array of functions. It returns values in input order.
A non-cancellation branch error is logged and becomes `null`; cancellation
propagates.

`pipeline` requires an array followed by stage functions. For each item, a
stage receives `(previous, original, index)`. A `null` value skips later stages
for that item. A non-cancellation error is logged and makes that item's result
`null`; cancellation propagates. Output order matches input order.

`workflow` accepts a non-empty registry reference or
`{ scriptPath: "non-empty path" }`. One child level is allowed. Children inherit
the root provider, scheduler, budget, and call cap. A child cannot invoke
another child.

`budget.total` is the current attempt's output-token limit or `null` when
unlimited. `budget.spent()` reports output tokens recorded in the current
attempt. `budget.remaining()` returns the difference or positive infinity when
unlimited. A resumed attempt starts its spending counter at zero and may use a
replacement total. The budget gates every call before replay lookup and gates
new work once spending reaches the limit; already active calls may complete
above it.

## 4. Values and failures

Workflow arguments, child-workflow arguments, options, and final results cross
the runtime boundary as strict JSON data: `null`, booleans, strings, finite
numbers, arrays without holes, and plain objects. Cycles, accessors, proxies,
symbols, non-enumerable properties, and unsupported numeric values are rejected.

A direct `agent` or `workflow` failure rejects, except for the completed
Claude-compatible terminal API error described in section 3. `parallel` and
`pipeline` apply the error-to-`null` behavior described above. Workflow
cancellation always propagates and MUST NOT be converted to `null`.

## 5. Determinism boundary

The runtime does not expose `process`, `require`, CommonJS globals, a filesystem
API, static or dynamic imports, or `import.meta`. String and WebAssembly code
generation, `Date.now()`, zero-argument or function-call `Date`, and
`Math.random()` are disabled. `Date.parse`, `Date.UTC`, and constructed dates
with explicit arguments remain available.

These are limited deterministic-API restrictions for trusted workflow code,
not a complete reproducibility guarantee or a security sandbox for hostile
code. Explicit dates and `Intl` operations can still observe host locale and
timezone behavior.

## 6. Durable replay

For each resumed attempt, awsl considers the attempt immediately before it. It
reuses that attempt's longest contiguous prefix of completed, non-null result
observations whose usage is complete and whose chained identities still match.
Failed, indeterminate, and compatibility-null observations are not reusable.
An intervening attempt with no reusable prefix prevents reuse from an older
attempt.

Call identity includes the prompt, schema, requested model, requested effort,
isolation, and agent type. `label` and `phase` are display metadata and do not
affect identity. Replay gates, including the attempt budget and call cap, run
before observation lookup.

The provider, executable profile, working directory, Workflow ABI, and model
policy remain pinned for a resumed run. The root workflow is reloaded from its
stored reference; its source bytes are not content-pinned by this ABI. Editing
that file between attempts can change execution, although only calls with the
same chained identities can reuse observations.

Resume means observation reuse, not JavaScript continuation capture: the
workflow starts again and deterministic calls are replayed from the durable
prefix.

## 7. Conformance and non-goals

An implementation claiming `awsl-workflow@1` compatibility MUST implement the
observable source, runtime, value, failure, and replay behavior in this
document. Provider-specific model availability may differ and MUST fail
explicitly when a requested option is unsupported.

The ABI does not define:

- provider executable arguments or streaming protocols;
- durable state filenames or directory layout;
- workflow source versioning or content-addressed resume pins;
- terminal UI, event transport, or exact scheduler implementation;
- distributed execution or remote coordination;
- hostile-code isolation;
- byte-for-byte equivalence with Claude Code or Codex output.

The canonical identifier is `awsl-workflow@1`. Future incompatible observable
semantics require a new identifier; compatible clarifications may revise this
proposal without changing it.
