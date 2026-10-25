---
id: D383
title: The enabled locations of a class ARE its write set — there is no default
status: accepted
date: 2026-09-07
supersedes: D301
applies-to:
  - packages/types/src/interfaces/storage-location.ts
  - packages/types/src/capabilities/storage.cap.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/location-store.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/placement-service.ts
  - packages/addon-pipeline/src/recorder/addon/placement-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts
  - scripts/check-storage-write-target-enabled.ts
---

## Context

A storage class had **three** write authorities that could point three
different ways: the flag (`StorageLocation.isDefault`), the stored per-camera
assignment (`placement-store.ts`), and the pool of enabled locations. Measured
on the live hub on 2026-08-30, after `recordingsLow` was repointed: three
cameras still writing to the disk a drain was emptying, and 18 placement
decisions in 40 minutes carrying `divergent: true`.

D301 made that disagreement *visible* — it stamped the class authority in the
placement blob and invalidated an assignment when the stamp moved. It was
correct for the model it lived in, and it is the wrong shape for the model the
operator actually wants: *"abilitare N locations dovrebbe rendere il sistema
capace di usarle tutte contemporaneamente. Disabilitarne una la rende
read-only"* [enabling N locations should make the system able to use all of them at the same time. Disabling one makes it read-only], and *"aggiungi anche l'eliminazione del concetto di default, non ha
veramente senso ed è confusionario."* [also add the removal of the concept of default, it makes no real sense and is confusing.]

The concrete cost of keeping the default: enabling a second disk for
`recordings` did not reliably make the fleet use it. Every unplaced camera
resolved to the flagged location, and a repoint of the flag moved cameras in a
block toward it rather than spreading them by capacity. An operator adding a
disk got a flag to move, not a pool to grow.

`docs/design/2026-08-30-enabled-locations-are-the-write-set.md` is the design;
this record is its Stages 2 and 3, shipped.

## Decision

**`enabled` is the only write authority a storage class has.** Every enabled
location of a class is a write target and they are used together; a disabled one
is READ-ONLY — still read, still played back, still age-swept, still evicted,
still drained — and never written. `isDefault`, `getDefaultLocation` and
`setDefaultLocations` are deleted, not demoted.

Four consequences of that one rule, each load-bearing:

1. **Which enabled location a camera gets is a capacity question.** An unplaced
   (camera, profile) resolves to the enabled member of its class with the most
   measured headroom (`min(free − minFree floor, maxUsedGb − used)`), ties by
   lexicographic id; the 30 s planner then holds the fleet at headroom share
   with a 15 pp hysteresis band. Nothing prefers an instance by name.
2. **A stored assignment cannot point outside the pool.** Membership is the
   operator's instruction, so an assignment naming a location that left the pool
   is invalidated at the next attach and re-resolved — there is no second
   authority for it to disagree with, and D301's stamp, repoint and divergence
   report are deleted with the thing they measured. What they were FOR survives
   as a placement census: one line per (class, location) with its denominator,
   plus a warning for an enabled location holding zero assignments.
3. **Absence stops existing.** A row persisted before `enabled` existed is
   stamped `true` by a one-time boot migration — absence already meant active,
   so behaviour is preserved exactly and the tri-state collapses. The retired
   `isDefault` key is DECLARED (`LegacyStorageLocationDefaultSchema`) and read
   deliberately by that migration, because a key dropped from a non-strict
   `z.object` is stripped in silence (D380, D381). The `is_default` column stays
   as dead data, written 0, so an interrupted deploy is safe in both directions.
4. **A cutover moves the write set, it does not shrink the pool.** The migration
   coordinator's `repointing` phase now calls `setWriteTargets` with
   `{destination: true, source: false}` per move — one compensated commit,
   refused if it would leave a write-serving type with nothing enabled. Every
   other enabled location of the class is untouched.

A bare type ref (`storage.write({ location: 'eventMedia' })`) resolves to the
sole location of the type; when a type has several it resolves — transitionally,
logged as deprecated — to the `<type>:default`-SLUGGED row, and otherwise
refuses naming the candidates. That slug is a NAME, not a restored flag: legacy
rows that stamped no `locationId` have their bytes on the row that was the write
target when they were written, and a slug-anchored read cannot be repointed out
from under them.

## Consequences

- **"Where does class X write?" loses its one-word answer.** The answer is a set
  plus a per-camera plan. The census line is the mitigation, not a cure.
- **Enabling is no longer inert.** Enabled means in use: the planner starts
  placing cameras on a newly enabled disk within a tick. Locations are still
  created born-disabled, which is what keeps this unsurprising.
- **A camera's timeline interleaves across disks over time.** Playback stitches
  across roots per row and reads never filter on `enabled`, so this is correct —
  but a single-disk failure now punches windows across many cameras instead of
  losing whole cameras. An operator who wants one-class-one-disk expresses it
  the only way left: one enabled location.
- **D301 is deleted months-old.** Its tests are rewritten around the census. It
  was right for a system with a class authority; this one has none.
- **The transitional bare-ref rule keeps a `:default` slug alive** until no
  unstamped `eventMedia` row exists. Stage 5 of the design retires it.

## Enforcement

`scripts/check-storage-write-target-enabled.ts` (already in
`.github/workflows/ci.yml`) now fails on any occurrence of `getDefaultLocation`
or `setDefaultLocations`, and on `isDefault` in any file that also mentions
`StorageLocation` — except the three files that carry the retired key through
the migration, each listed with its reason. Verified in both directions: the
guard goes red when either is reintroduced, and green with them absent.

Specs: `write-set-migration.spec.ts` (migration, idempotency, `writeTargets`,
`setWriteTargets`, bare refs) and
`packages/addon-pipeline/src/recorder/addon/__tests__/enabled-is-the-write-set.spec.ts`
(both enabled disks receive footage, the emptiest wins an unplaced camera, a
disabled and a read-only location keep serving reads).
