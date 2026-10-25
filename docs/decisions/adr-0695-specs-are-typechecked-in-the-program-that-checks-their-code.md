---
id: D695
title: Specs are typechecked in the same tsc program as the code they test, and their debt is a separate ratchet
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - scripts/check-specs-are-typechecked.ts
  - scripts/check-src-imports-stay-in-package.ts
  - scripts/lib/typecheck-split.ts
  - scripts/lib/baseline-update.ts
covers:
  - packages/*/tsconfig.spec.json
  - server/backend/tsconfig.spec.json
  - e2e/tsconfig.spec.json
---

## Context

Most packages' `tsconfig.json` excludes `**/__tests__/**` and `**/*.test.ts`,
because the build must not emit specs — and `typecheck` ran that same file.
vitest strips types without checking them. So in those packages nothing ever
typechecked a spec: a fixture could lose half its fields, call a method that
was renamed, or pass a string where a number goes, and stay green. The first
typecheck over the specs (2026-10-01) reported 1 762 errors in 500 spec files
of seven packages — addon-pipeline 656, addon-post-analysis 650,
server/backend 319, types 86, system 43, desktop 7, addon-decoder-nodeav 1.
That is the "the fake supplied what production forgot" shape CLAUDE.md warns
about, at scale, and it had been found by hand in addon-post-analysis more
than once.

The obvious shape — a second `typecheck:specs` target per package over a
`tsconfig.spec.json` — checks every source file twice, because specs import
the code they test. Measured locally at two-way parallelism: the existing
typecheck sweep 4 m 03 s, a spec-inclusive program 5 m 07 s on its own; two
targets would have been ~9 min, on a CI runner where the `static` job's
typecheck is already its longest step.

## Decision

A package with specs has a `tsconfig.spec.json` that extends its build
config and drops only the test excludes, and its `typecheck` script runs
`tsc --noEmit -p tsconfig.spec.json` — ONE program over code and specs. The
pinned-debt guard splits that pass's diagnostics by the file they are
reported in: a non-test file counts in `typecheck` (per package, held at
zero as before), a test file counts in `typecheck-specs` (per spec file,
pinned in `scripts/ci-baseline.json` and only ever re-pinned downward). A
spec error never pays for a production error, nor the reverse. The build
config (`tsconfig.json`) is untouched, and the spec config may not loosen it:
it is the production check's config now, so it sets nothing but an
allowlisted `rootDir` (system and types keep specs in a package-root
`__tests__/`; one addon-pipeline spec helper mounts system's real settings
engine) and desktop's `allowJs`. `rootDir` is NOT emit-only — it also raises
TS6059 for a program file outside it, which was the only thing refusing a
production file that reaches a sibling package by relative path. The first
cut widened it to the repository root everywhere and silently dropped that
check (caught in review with a probe import); the property is now held by
`check-src-imports-stay-in-package` for every package, whatever `rootDir` is.

## Consequences

- The root `npm run typecheck` IS the ratchet
  (`tsx scripts/check-ci-baselines.ts typecheck typecheck-specs`): green on
  the pins, red on anything NEW, naming the file. The raw sweep is
  `npm run typecheck:raw`, and a package's own `npm run typecheck -w <pkg>`
  stays raw — red while that package carries pinned spec debt.
- The spec bucket is keyed per FILE, not per error: fixing one error and
  adding another in the same spec stays green. The same trade the oxlint
  bucket makes; per-error keys would churn on every moved line.
- `--update` only ratchets down: a raise or a new key is refused unless the
  check is named in `--allow-increase <check>`, and production `typecheck`
  cannot be pinned at all (`scripts/lib/baseline-update.ts`).
- The typecheck sweep costs more by the spec files only: 4 m 03 s → 5 m 27 s,
  measured LOCALLY (a shared 4-core box, two-way parallelism — not CI) (55 projects instead of 53: `desktop` and
  `e2e` gained a `typecheck` target), against ~9 min for a second target.
- Fixing spec debt is ordinary work: fix, re-run
  `tsx scripts/check-ci-baselines.ts --update typecheck-specs`, commit the
  shrunken pin. No casts — the CLAUDE.md Types rules apply to specs too.

## Enforcement

- `scripts/check-specs-are-typechecked.ts` (CI guard list and pre-commit):
  every package with specs has a `tsconfig.spec.json` extending its build
  config and setting only its allowlisted options; `typecheck` runs it as
  exactly `tsc --noEmit -p tsconfig.spec.json` (optionally followed by more
  programs); every spec file on disk is in that program as TypeScript itself
  resolves the config; and no test file makes an ambient declaration that
  would retype the shared program (matcher typing and one documented backend
  shim excepted).
- `scripts/check-src-imports-stay-in-package.ts` (CI guard list and
  pre-commit): no production file's relative import leaves its package.
- `scripts/check-ci-baselines.ts` (CI "Pinned-debt guard" step): the
  `typecheck` and `typecheck-specs` buckets, via `scripts/lib/typecheck-split.ts`.
- `scripts/check-specs-have-test-script.ts`: the sibling rule — specs that
  exist are also RUN.
