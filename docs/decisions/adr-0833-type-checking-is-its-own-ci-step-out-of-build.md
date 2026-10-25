---
id: D833
title: Type checking is its own CI step, out of build
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - .github/workflows/ci.yml
  - scripts/typecheck-tsgo.ts
---

## Context

D704 made CI "build + test" and kept the type gate inside `build`: the admin-ui,
agent-ui and desktop build scripts began with `tsc --noEmit`. That covered three
packages out of 55, and built each of those programs twice (gate, then emit; for
admin-ui three times with the spec program). It was also among the largest
memory consumers of the CI build step.

## Decision

Type checking is one CI step after the build: `scripts/typecheck-tsgo.ts` over
every workspace project, sequentially, `--checkers 1`, graded against the pins in
`scripts/ci-baseline.json`. The `build` scripts no longer type-check. This
amends D704 by adding exactly this one step to "build + test"; nothing else is
added to the per-push CI.

## Consequences

- Every package is type-checked, not three; each program is built once.
- Peak memory is the single largest program (admin-ui specs, about 3 GB), not
  the sum of overlapping tasks.
- A build can now succeed with a type error; the typecheck step is what fails.
  Anything that builds outside the CI workflow must run `npm run typecheck`.

## Enforcement

The CI "Typecheck (TypeScript 7)" step; locally `npm run verify:push`.
