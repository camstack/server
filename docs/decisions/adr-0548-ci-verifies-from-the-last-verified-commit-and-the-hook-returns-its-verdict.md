---
id: D548
title: CI verifies from the last VERIFIED commit, its cache lives on the runner, and the hook returns CI's verdict
status: accepted
date: 2026-09-20
supersedes:
covers:
  - .github/workflows/ci.yml
  - .husky/pre-commit
  - scripts/check-docs-drift.ts
  - scripts/lib/walk-sources.ts
  - scripts/docs-generate.ts
  - packages/addon-pipeline/src/__tests__/guards/hour-ledger-names-no-file.guard.ts
  - packages/addon-pipeline/src/__tests__/guards/label-tier-declared.guard.ts
  - packages/addon-pipeline/src/__tests__/guards/per-macro-slider-reaches-the-pool.guard.ts
  - server/backend/src/__tests__/guards/core-router-classification.guard.ts
---

## Context

On 2026-09-20 the last thirty runs of `ci.yml` were 0 green, 9 red, 20
cancelled, at a median of 31.6 minutes. Every one of the fourteen completed
runs died on the guards or the docs step; the pinned-debt typecheck, the 3 010
spec files, the scripts tests and the Python pool did not execute once — the
nightly full suite included. The first run to get past both blockers, later
that morning, took 51.6 minutes and spent 1 006 s in a cold typecheck.

**The cache moved and never hit.** `actions/cache` carried a 1.07 → 1.39 GB
tarball of `.nx/cache` through GitHub's cache service at 2–4 MB/s: 291–598 s
to restore and 125–412 s to save, per run. Behind it, `Successfully ran
target build for 54 projects` — 454 s of building, zero `[local cache]` lines,
in every run. Nx ≥ 20 resolves every cache lookup through the sqlite index in
`.nx/workspace-data/`, which `git clean -ffdx` wiped before each job and the
tarball never carried; there is no legacy file-keyed lookup left in Nx 23 to
fall back on. The restored entries were orphans by construction.

**The base skipped what was cancelled.** `nx affected` diffed from
`github.event.before`, the previous push's head. Under `cancel-in-progress`
most previous runs never finish (20 of 30), so their commits' packages were
diffed past by the next push and tested by nobody until the nightly — which
had not been green either.

**The hook and CI disagreed by design.** The pre-commit hook ran
`check-docs-drift` without a ceiling and printed the stale list marked "(not a
failure)"; CI ran it with `--max-stale 0` and failed. Two more classes of red
were invisible locally for the same reason: the API reference regenerated in
the hook only when a `*.cap.ts` was staged, but it resolves Zod shapes
transitively (`RecordingBandSchema.audio`, three red runs); and
`check-method-tiers` / `check-export-coverage`, which fire on every NEW cap
method, ran only in CI. Of fourteen red runs, fourteen were bookkeeping the
author could not see before pushing; zero were code defects.

**One job, serial, and guards that walked the world.** A typecheck failure
waited behind every test; a red guard waited behind the build. Of the 106
guards, 104 are regex over text and 60 never consider comments — two of the
three red causes were exactly that class (a mount path quoted in a docblock; a
constant not followed). Measured per guard on the 2026-09-20 sweep, five were
60 % of it: `check-no-service-account-keys` 130 s (a `readdir` from the repo
root into every untracked tree), `check-settings-key-has-reader` 66 s (a fresh
`RegExp` per line × key), `check-durable-state-declared` 26 s,
`check-cgroup-path-single-owner` 24 s, `check-no-commit-sha-references` 22 s
(one `git cat-file` spawn per hex token).

The claim "35 guards read a single package" was a heuristic count of path
strings and it was wrong: checked by their real scan roots, three of the nine
sampled walked `packages` and `server` whole, ten read `docs/`, `scripts/` or
the viewer submodule (no package to live in), and of the ones that do read one
package, seven read `packages/types` and eight `packages/addon-post-analysis`
— both being written by other sessions on the day this landed.

Alternatives weighed. Cache: keep the tarball and add `.nx/workspace-data`
(the index is named after the machine id, so a tarball from `agent_a_1`
still misses on `_2`, and the transfer stays); `@nx/shared-fs-cache` on a bind
mount shared by both runner containers — correct, and the operator considered
it and chose NOT to change the Unraid template: per-runner caches are the
zero-touch shape and were chosen deliberately; Nx Cloud (a third party for a
self-hosted repo). Base: `nrwl/nx-set-shas` does the same query in a black
box; nine lines of `curl` read in the log. Guards: a mass edit of all sixty
comment-blind guards onto the shared walker was judged not worth its blast
radius on the day — the five heaviest were done, the rest move when touched.

## Decision

1. Nx's cache and workspace-data directories live in `runner.workspace`,
   beside the checkout, bounded by `NX_MAX_CACHE_SIZE`; nothing is tarred
   through the GitHub cache service. Each runner keeps its own; a container
   rebuild costs one cold run.
2. The `affected` base on a push is the head of the newest SUCCESSFUL run on
   `main` (any event — a green nightly counts), verified as an ancestor of
   `HEAD`. The previous push is the fallback only while no green run exists.
3. The pre-commit hook returns CI's verdict on the same tree and BLOCKS on it:
   it passes CI's own `--max-stale` ceiling (read out of `ci.yml`, one
   source), regenerates the API reference on any change under
   `packages/types/src`, and runs the two cap-method baseline guards when a
   `*.cap.ts` is staged. Its leniency about untracked files is unchanged.
4. The workflow is two jobs. `static` judges the tree without running it
   (guards, docs, codegen, the pinned-debt typecheck); `tests` runs it
   (affected on a push, everything nightly, plus the scripts and Python
   suites). Each builds from the runner-local cache. Wall-clock is the larger
   of the two, and a red guard is reported when the guard finishes.
5. A guard that reads ONE package lives in it, as
   `src/__tests__/guards/<name>.guard.ts` with a spec beside it that asserts
   the checked-out package passes AND that the violation the guard was written
   for still fails. `nx affected -t test` runs it exactly when the package
   changes. Four moved today (three in `addon-pipeline`, one in
   `server/backend`, with its classification table); `docs/reference/guards.md`
   lists them under their own heading, so the reference cannot under-report
   what is enforced.
6. A guard whose subject is the WORLD rather than the commit runs nightly and
   on demand, never on a push: `check-npm-orphan-packages` asks the npm
   registry. The other four candidates of the first plan were re-examined and
   kept on the push — they read only git and the tree.
7. The push-time sweep runs two guards at a time (`xargs -P2`), the list
   inline in `ci.yml` as literal names.
8. `scripts/lib/walk-sources.ts` is the one walker: tracked files from `git
   ls-files`, and every entry carries both the verbatim `source` and a
   comment-blanked `code`, so a guard says which it judges.

## Consequences

The first run on each runner after this lands is cold (build ≈ 8 min,
pinned-debt typecheck ≈ 17 min on this hardware); every later run on a warm
runner pays neither. The 13 minutes of transfer are gone from every run.

**A push takes both runners.** A second push during a run waits for both —
and under `cancel-in-progress` it cancels the first, so the queue is one
deep. That is the price of the wall-clock, chosen knowingly.

The hook can refuse a commit that touched no docs when the tree already
exceeds the ceiling: the fix is the one CI would have demanded an hour later,
and it is demanded of the person who can still see why.

A guard on the shared walker judges what a commit CARRIES: a file not yet
`git add`ed is not scanned. CI always sees committed trees, and no guard on
the walker runs in the hook, so nothing changes in practice — but a guard
that must see untracked files passes `tracked: false`.

Per-guard timings after the change, same tree, same machine: cgroup 24 →
3.6 s, service-account-keys 130 → 7.2 s, settings-key-has-reader 66 → 6.6 s,
sha-references 22 → 1.1 s. `check-durable-state-declared` is NOT faster: its
26 s is `scripts/lib/parse-storage.ts`, the storage map the hook comment
already prices at "45 s parsing twice", shared with `docs-generate`. A walker
cannot touch it; that is a separate piece of work and it is named here so it
does not read as overlooked.

Deferred, named: the seven single-package guards over `packages/types` and
the eight over `packages/addon-post-analysis` move the same way when those
packages are not under another session's hands. The guards over `docs/`,
`scripts/` and the viewer submodule have no package to live in and stay
scripts. The remaining fifty-five comment-blind guards move onto the shared
walker one at a time, when touched.

## Enforcement

`docs/reference/guards.md` is generated from the steps of `ci.yml` plus every
`*.guard.ts` under a package's `src/__tests__/guards/`, and lists any
`scripts/check-*` the workflow does not name as unwired. The hook's ceiling is
read from `ci.yml` at commit time, so there is no second number to drift. The
cache hit rate is visible in the build step's output (`[local cache]` per
task) and in the `du -sh` the workflow prints before the build. Each moved
guard's spec carries its negative case; `scripts/__tests__/walk-sources.spec.ts`
covers the walker.
