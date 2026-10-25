---
id: D485
title: A prune window is a number the operator can reach — and the number decides
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/prune-windows.ts
  - packages/addon-post-analysis/src/notification-center/artifact-store.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-mosaic.ts
---

## Context

Five prune windows were hardcoded in five files: the notification outbox
(7 days), a rendered timelapse (7 days), the retained artefact shelf
(14 days / 2 000 rows / 2 GiB), a rule's digest mosaics (200 per rule) and the
analytics ops log (30 days). The operator asked for all of them to be
configurable — *"tutti quelli che oggi sono ancora hard coded"* [all those that today are still hard coded].

"Make the days configurable" is not a specification, and three of the five said
so:

- **The artefact shelf has three bounds and the first to bite wins.** Exposing
  only the days would hand the operator a number that does not decide: raise it
  to 60 and the shelf still cuts at 2 000 rows, with nothing saying why. This
  repo has shipped four knobs that decided nothing already (D62's per-family
  windows, `zoneMembershipMinOverlap`, `rescueCentroidFactor`,
  `audioThresholdDbfs`), and every one read as a decision that had been made.
- **The mosaic is bounded by COUNT, not by time.** D480 chose that deliberately:
  a writer-imposed limit has no clock, and there is exactly one age-keyed sweep
  in this system (D61).
- **The ops log has a written reason to stay fixed.** `retention-model.ts` calls
  it *"the one root that must NOT follow a device window … the audit trail is
  not history of the camera, it is history of the sweep"*.

The operator answered each: the shelf becomes days-ONLY, the mosaic changes
mechanism, and the ops log becomes configurable through the LOGGING capability
rather than this addon's own form, so that every log-ish window is configured in
one place.

## Decision

Four cluster windows — `outboxDays`, `timelapseExportDays`, `artifactShelfDays`,
`summaryMosaicDays` — are resolved in ONE place (`prune-windows.ts`), rendered as
one form section, and read at call time so a Save takes effect on the next sweep
rather than the next release. `0` means keep forever and resolves to `null`;
negative, NaN and absent fall back to the shipped default. The ops log's window
moves to `opsLogRetentionDays` on the logging settings document
(`system.getLoggingSettings`), configured from the Levels page.

The artefact shelf's row and byte caps are REMOVED, not raised. The mosaic's
count bound is REPLACED by an age one; it still runs on the write path, still
belongs to the writer, and the sweeper is still told to keep its hands off, so
the half of D480 about there being one age-keyed SWEEP is untouched.

## Consequences

What this costs, measured rather than estimated:

- **The artefact shelf now has nothing behind it.** `artifacts` is not a class
  the storage evictor sweeps — it is absent from `STORAGE_CLASS_SUBTREES` — so
  those three bounds were the only thing between that shelf and the disk. On the
  live hub the day this shipped: 901 retained files, ~710 MB, the busiest camera
  at 820 files / 580 MB. At the 14-day default the age bound is what bites and
  the other two had never fired, so today this changes nothing. At 60 days that
  one camera alone would hold roughly 2.5 GB, and nothing would stop it.
- **The mosaic default moves footprint in both directions.** The busiest rule on
  this hub makes ~66 mosaics and ~27 MiB a day: 14 days is ~370 MiB for it,
  against ~80 MiB under the count bound. A rule that fires once a night goes the
  other way, from over six months of history to 14 days.
- **The ops-log knob ships in the framework closure**, not with
  `camstack deploy` like the four beside it. That asymmetry is the price of the
  operator's "uniform" — one document for everything log-shaped.
- **`keptMaxAgeMs` is `number | null` and `??` is now wrong on it.** `null` is
  "forever" and the default is 14 days; folding one into the other is the exact
  opposite of what the operator asked for. `expiresAt` carries `NEVER_EXPIRES`
  (`MAX_SAFE_INTEGER`) rather than becoming nullable, because `NULL <= now` is
  unknown, not false, and would silently lose every reader.
- **Two bugs were introduced and caught while writing this**, both worth
  naming because both were silent: `fresh.slice(undefined)` is a FULL COPY, so
  removing the count bound carelessly condemned the entire shelf on the first
  sweep; and reading the four windows as four `this.state(...).get()` calls took
  a cold settings resolve from one addon-store read to four, on the synchronous
  thread D447 is about.

## Enforcement

`scripts/check-prune-settings-consumed.ts` (wired into CI) checks that every
declared window is rendered in the `prune-windows` section AND read outside the
resolver, in both directions. It was verified by breaking it on purpose in both
directions; the first version used `includes()` and reported `outboxMsXX` as a
reader of `outboxMs`, which is precisely the rename it exists to catch.

`artifact-shelf-age-only.spec.ts` pins that nothing inside the window is swept
however many entries there are — the assertion that the removed bounds stay
removed, rather than their absence being merely untested. `mosaic-age-bound.spec.ts`
pins the two readings that are catastrophic when confused: "evict everything"
(`{ all: true }`) and "evict nothing" (`{ olderThanMs: null }`).
