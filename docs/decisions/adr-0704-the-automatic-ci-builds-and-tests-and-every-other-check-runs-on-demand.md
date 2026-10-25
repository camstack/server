---
id: D704
title: The automatic CI builds and tests; every other check runs on demand
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - .github/workflows/ci.yml
  - .github/workflows/checks.yml
  - .husky/pre-commit
  - scripts/docs-generate.ts
---

## Context

`ci.yml` carried two jobs per push: `static` (about 140 repository guards,
codegen drift, the pinned-debt typecheck / oxlint / format / double-cast
ratchet) and `tests`. The docs sync had already left push CI on 2026-10-04
because it burned minutes without gating a green build. What remained still
went red for reasons that did not stop a build from shipping, often enough
that nobody read the verdict: the last 98 CI runs before this record all
ended `cancelled`, and for five days of them no job started at all (stale
self-hosted runner version, jobs queued forever) without anyone noticing.
The pre-commit hook added a second source of friction: docs drift, the
subsystem map, English-only prose and private-data checks blocked commits of
code changes because of a doc line elsewhere.

## Decision

The automatic pipeline (`ci.yml`: push, pull request, nightly) builds every
package and runs the tests — affected on push/PR, the full suite nightly — and
nothing else. Repository guards, codegen drift, the pinned-debt ratchet, the
docs checks and the e2e suite run in `checks.yml`, which is
`workflow_dispatch` only (`gh workflow run Checks --ref main`). The
pre-commit hook no longer runs docs checks (drift, subsystem map, English,
private data); it still regenerates the generated docs pages, which is a fix
rather than a verdict.

## Consequences

- A guard violation, new typecheck debt or a docs drift is no longer reported
  on push. It surfaces when someone runs `Checks` — run it before a release
  and after changing what a guard protects.
- `docs/reference/guards.md` reads both workflow files, so a guard listed in
  `checks.yml` is still documented as enforced (by the on-demand checks).
- New guards are wired into `checks.yml`, not `ci.yml`.
- The automatic verdict is green exactly when the code builds and its tests
  pass, which is the property that makes people look at it.

## Enforcement

Nothing automatic: a step added back to `ci.yml` is caught in review only.
