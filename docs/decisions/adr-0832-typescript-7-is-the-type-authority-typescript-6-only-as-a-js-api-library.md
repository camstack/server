---
id: D832
title: TypeScript 7 is the type authority; TypeScript 6 only as a JS-API library
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - scripts/check-ci-baselines.ts
  - scripts/typecheck-tsgo.ts
  - package.json
---

## Context

The type check ran on `tsc` 6 locally and in Checks while CI already graded with
`tsgo` (TypeScript 7), so a push could be green locally and red in CI on an
error tsc never reported. The CI host is an N100 shared with a live agent, and
`tsgo --checkers 1` needs less RAM and a fraction of the wall time of tsc 6 on
the same programs. The transition plan
(`docs/design/2026-10-09-ts7-transition-plan.md`) gated the flip on ten
parity-clean Checks runs. Checks is on-demand and had not run since 2026-10-06,
so that count could never be reached.

On 2026-10-13 `scripts/typecheck-tsgo.ts --parity` ran over every workspace
project: identical normalized error sets (`file(line,col): TSxxxx`) for tsc 6
and tsgo, zero new errors over the pins. The viewer's `ts-check` showed the same
18 diagnostics on both engines. The operator accepted that as the evidence.

## Decision

TypeScript 7 (`typescript-7`, the `npm:typescript@7.0.2` alias, called by path)
is the type authority: `npm run typecheck`, the pinned-debt guard in Checks, and
`--update` of `scripts/ci-baseline.json` all use it by default. `typescript` 6
stays installed only as a JS-API library for tools that cannot yet use the TS 7
API (ts-morph, typescript-eslint, the AST-only guard scripts, `expo lint`), and
as the editor's workspace version. `npm run typecheck:tsc6` and
`check-ci-baselines.ts --engine=tsc` keep the reference engine one command away;
`typecheck-tsgo.ts --parity` compares both by hand when TypeScript is bumped.

## Consequences

- A local typecheck now means what CI means; "green locally, red in CI" on a
  type error is closed.
- tsc 6 is not removed: while any dependency needs its JS API it must stay in
  the lockfile. Upstream tracking (TS 7 JS API, typescript-eslint, ts-morph)
  stays open, re-evaluated at each TS 7.x release.
- A TypeScript bump must be followed by one `--parity` run before the pins are
  trusted.

## Enforcement

`scripts/check-ci-baselines.ts` (default engine tsgo) in the Checks pinned-debt
guard, and `scripts/ci/verify-push.sh`, which grades with tsgo.
