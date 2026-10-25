---
id: D684
title: A pick-up's instant is stored on its row, and every package subject reads it from there
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
covers:
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

Completes [D682](adr-0682-a-pick-ups-footage-is-cut-around-the-pick-up.md)
(its open point on the reconcile path).

## Context

D682 anchored a package pick-up's notification footage on the moment the
parcel went instead of the moment the departure was CONCLUDED (five minutes of
unseen time later, `PACKAGE_STILLNESS_TTL_MS`). It did so by handing the instant
BESIDE the persisted row, on the live hook only:
`onPersisted(ev, 'picked-up', { observedAt })` → `onPackageEventPersisted` →
`incomingFromPackageEvent(ev, phase, observedAt)` → `subjectFromPackageEvent`.

The row did not store it. Every path that rebuilds a subject from the row —
the boot crash-gap reconcile (`NotificationCenter.reconcile`) and the
`testRule` dry-run — called `subjectFromPackageEvent(ev, phase)` with nothing,
so a pick-up replayed after a restart was anchored on its conclusion: the
empty-doormat gif D682 set out to remove, now merely logged. Two call shapes
for one subject meant two answers for one row.

Readers of package event rows, traced: the detector itself (`queryObject`,
pairing a pick-up to its delivery by idempotence key), the NC boot reconcile
and the NC dry-run (`queryObjectSince` → `subjectFromPackageEvent`), and the
timeline / track reads (`queryObject`, `queryObjectByTrackIds`), which hand the
row to the UI as-is. The outbox already freezes `subject.observedAt`, so a
retry or a drain after a restart replays the frozen value, not the row.

## Decision

**The instant is a column on the row, and the row is all anyone is handed.**
`ObjectEvent.observedAt` (optional, epoch ms) is declared on the
object-events collection (`OBJECT_COLUMNS`, INTEGER, additive —
`declareCollection` adds it in place). `PackageDropDetector` writes
`observedAt = collector?.observedAt ?? pickupInstantOf(entry)` into the
pick-up DRAFT, so the id-bearing event handed to `onPersisted(ev, phase)` and
the row the reconcile reads back are the same object. `subjectFromPackageEvent`
reads `ev.observedAt` — the one place every path builds a package subject — and
the side-channel (`PackagePersistedMoment`, the `observedAt` parameter on
`incomingFromPackageEvent` / `onPackageEventPersisted`) is gone. `timestamp`
keeps its meaning: the conclusion. A delivery stores none; it is concluded as it
happens.

## Consequences

- Live hook, reconcile and dry-run cannot disagree about a pick-up's anchor:
  they call the same function on the same row.
- Pick-up rows written before D684 have SQL NULL in the column, which
  `stripNulls` turns into absent: the moment is UNKNOWN, never 0 and never
  `timestamp`. Such a row still replays; the dispatcher logs `package pick-up
  footage anchored on the conclusion — moment unknown` and — since the D682
  review — orders no recorded footage for it, gif or video (`reason:
  moment-unknown`).
- The field travels on every object-event read, including the cap output the
  timeline receives. Additive and optional, so an older consumer ignores it.
- `@camstack/types` changed (schema field). `addon-post-analysis` bundles it, so
  the two ship together; no other addon reads the field.
- The column is not indexed: nothing selects by it.

## Enforcement

- `event-store-observed-at-over-real-sqlite.spec.ts` — over the real
  `SqliteSettingsBackend`: `observedAt` round-trips through `queryObjectSince`
  and `queryObject`; a table that predates the column gains it in place, the
  old row reads with no `observedAt`, the new one with it. Red with the column
  removed from `OBJECT_COLUMNS` (the backend drops the key silently).
- `package-pickup-instant-stored.spec.ts` — the boot reconcile freezes a stored
  pick-up's instant onto the outbox subject; the live hook and the reconcile
  freeze the same instant and the same anchor; a pre-D684 row replays as
  unknown. Red with the `ev.observedAt` read removed from
  `subjectFromPackageEvent`.
- `package-drop-detector.spec.ts` — the pick-up ROW carries the last sighting
  (or the collector's instant) and the conclusion as `timestamp`; the delivery
  row carries none; the live subject equals the one rebuilt from the stored row.
  Red with the field removed from the draft.
