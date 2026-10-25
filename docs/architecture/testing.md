---
title: Test lanes and heavy specs
last-verified: 2026-10-15
covers:
  - scripts/run-heavy-specs.ts
  - scripts/check-heavy-specs.ts
---

# Test lanes and heavy specs

Three lanes run tests, and a spec belongs to exactly one of them:

| Lane | Runs | Collects |
| --- | --- | --- |
| Default | `npm run test`, `verify:push`, `ci.yml` | every spec except the two below |
| Cluster | `npm run test:cluster`, Checks `e2e` job | `*.cluster.spec.ts` (real multi-broker clusters) |
| Heavy | `npm run test:heavy`, Checks `e2e` job | `*.heavy.spec.*` |

## What qualifies as heavy

A spec whose only failure mode is **timing under machine load**: it passes
alone on an idle machine, and times out when other suites share the CPU (a
fixed-count `flush`, a sleep bounded against a short TTL, a real-tree scan
under vitest's 10 s default). Heavy is not a place for a spec that is wrong or
flaky for another reason; fix those. Its assertions are never weakened to fit;
it is only moved off the automatic gates.

## The convention

- Name it `<name>.heavy.spec.ts(x)` (rename with `git mv`, keeping history).
- Every default vitest config excludes `**/*.heavy.spec.*` unless
  `CAMSTACK_HEAVY_SPECS=1`. A project that owns a heavy spec carries that
  exclusion in its own `vitest.config.*`.
- `npm run test:heavy` (`scripts/run-heavy-specs.ts`) finds every heavy spec and
  runs each through the config of the project that owns it, with
  `CAMSTACK_HEAVY_SPECS=1`, so module resolution is the default lane's.
- The Checks workflow runs `npm run test:heavy`. Checks is on-demand: the
  operator dispatches it.
- `scripts/check-heavy-specs.ts` fails if an owning config stops excluding
  heavy specs or `checks.yml` stops running `test:heavy`. A new heavy spec
  therefore cannot end up running nowhere.
