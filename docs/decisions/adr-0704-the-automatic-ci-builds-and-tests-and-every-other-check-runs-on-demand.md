---
id: D704
title: The automatic CI builds and tests; every other check runs on demand
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - .github/workflows/ci.yml
  - .github/workflows/checks.yml
  - .github/workflows/release.yml
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

## Amendment (2026-10-25) — GitHub-hosted runners

Public CI does not run on the home self-hosted pool. `ci.yml`, `checks.yml`,
`publish-packages.yml` and `unpublish-retired.yml` run on `ubuntu-latest`
(4 vCPU, 16 GB). Releases are the exception recorded below.

The Checks job keeps an 8 GB heap
(`NODE_OPTIONS=--max-old-space-size=8192`). The automatic typecheck step uses
the same ceiling. 16 GB is enough for it. Per-step heaps below that exist so
three parallel builds, or two vitest forks, fit in the machine.

Nx's cache is `actions/cache` over `.nx/cache` and `.nx/workspace-data`, keyed
on `package-lock.json` and `nx.json` (D548's persistent directory does not
exist on an ephemeral VM). `scripts/ci/align-nx-db.sh` copies the restored
database onto this machine's id, because Nx 23 names the file after it. The
pinned ffmpeg is cached the same way, under `.camstack-ffmpeg`, keyed on
`packages/types/src/deps/ffmpeg-artifacts.ts`.

`runner-watchdog.yml` watched the home queue and is not in this repository.
A pull request job receives the default token only.

## Amendment (2026-10-25) — releases stay on the home runners

Docker and Electron in `release.yml` run on the home runners
(`[self-hosted, linux, x64, ci-release]` and `docker` for the image;
`[self-hosted, macos, arm64]` for the desktop app). Those runners sit in the
org runner group `release`, which allows only
`camstack/server/.github/workflows/release.yml` on `refs/heads/main`. GitHub's
group restriction cannot name a `refs/tags/v*` pattern, so a tag push cannot
reach them. The workflow is `workflow_dispatch` only, and its first job refuses
any other ref. A public repo's fork pull request must never schedule a job on
those machines: there is no pull-request trigger, and the group would refuse
one anyway. The light jobs (`derive-version`, `create-release`,
`publish-release`, `summary`) run on `ubuntu-latest` and hold no secret beyond
`GITHUB_TOKEN`. `publish_release=true` reads `product-version.json`, refuses
an existing `v<version>` tag, and `create-release` creates that tag on the
dispatched commit.
