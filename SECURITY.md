# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/XhinLiang/awsl/security/advisories/new).
Include affected versions, impact, reproduction steps, and any proposed
mitigation. Do not include live credentials or private provider output.

## Supported versions

| Version | Status |
|---|---|
| `main` and latest release | Supported |
| Older releases | Unsupported |

## Trust boundary

- Workflow files are trusted code. The Node VM and worker process are
  deterministic compatibility boundaries, not an OS sandbox for hostile code.
- Providers are launched directly as a binary plus argument vector without a
  shell. A provider CLI may apply ambient project instructions, hooks, MCP
  servers, and permission settings; awsl does not independently reproduce or
  certify all of that ambient configuration.
- Restrictive named-agent policy is fail-closed. awsl refuses a call if the
  selected adapter cannot express its tools, MCP, or permission restrictions
  without broadening access.
- `isolation: "worktree"` protects the caller's working tree from ordinary
  changes; it is not a container or filesystem sandbox.

## Sensitive data

State directories are created with mode 0700. State, journal, lock, schema, and
optional raw-provider files are created with mode 0600.

Raw provider capture is off by default. When explicitly enabled, awsl applies
structural and text redaction, but the resulting diagnostics should still be
handled as sensitive data.

awsl does not intentionally persist the full process environment or provider
credentials. Persistence and JSONL output defensively redact common
Authorization, Cookie, token, secret, password, credential, signature, API key,
and AWS credential fields. Redaction is defense in depth, not a substitute for
keeping secrets out of prompts and workflow results.

## Dependency and release safety

Executable package code is limited to the `dist` allowlist. Package smoke tests
install the tarball in a clean directory, reject unexpected package paths and
common credential material, and run the installed executable. The package also
contains this policy, the compatibility report, the changelog, and a
deterministic CycloneDX 1.6 SBOM for the production closure recorded by
`pnpm-lock.yaml`.

External and vendor fixtures are excluded from the repository and release
package. Public CI uses only independently authored fixtures.
