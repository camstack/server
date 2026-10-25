---
id: D480
title: A bulk sweep covers the WHOLE collection or it covers the head, and a synthetic owner id is a kind of its own
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/disk-reconcile.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/sweep-cursor-store.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-producer.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-mosaic.ts
  - scripts/check-sweep-coverage.ts
---

## Context

`pipeline-analytics:media` was reported as holding 676 rows whose owning event
no longer exists — framed as the 0.2 % that escapes the `pruneEventsBefore` →
`mediaStore.deleteForEvents` cascade, with two candidate causes: the
best-effort-per-row `deleteForOwner`, or a motion marker still written after the
event insert and so orphaned by a retention pass crossing that gap.

**Both candidates are wrong, and so is the framing.** Measured on the two copies
taken today (`camstack.db.pre-d474`, taken with the container stopped, and the
post-migration VACUUMed `migr-rehearsal/prova3.db`):

| Question | Pre-migration | Post-migration |
| --- | --- | --- |
| media rows total | 532 384 | 528 559 |
| rows with `ownerKind='event'` | 300 910 | 676 |
| of those, `ownerId LIKE 'summary-%'` | 690 | 675 |
| of those, resolving to a live event row | 300 219 | — |
| **genuine cascade escapes** | **1** | 1 |
| `motion`-owned rows with no motion event | — | **0** |
| `summary`-owned rows with no summary | — | **0** |
| `track`-owned rows with no track | — | **23 874 / 9 845 MiB** |

The cascade has ONE escape in 300 220 event-owned rows — 0.0003 %, not 0.2 %.
Every one of the 299 883 surviving `motion` media rows resolves to a live motion
event. Neither the best-effort path nor the post-insert marker write is
producing orphans at a rate any measurement can see.

The 676 are two different things wearing one number:

* **675 are notification summary MOSAICS.** `summary-producer.ts` builds
  `summary-<ruleId>-<windowEndMs>` (`summaryMediaOwnerId`) and files it through
  `storeMosaic`, which wrote `ownerKind: 'event'` with that synthetic id. It was
  never an event id: no event row has ever existed for any of them, so nothing
  was ever pruned. They are one camera (101), one rule
  (`6f294ef8-db7c-4c7c-b4fb-ea9826db710c`), 675 `fullFrame` + 271 MiB, spanning
  2026-09-02 07:37 to the moment of measurement and **still accumulating** at
  ~66 rows / 27 MiB per day. This is the `scene` mistake in the `OWNER_KINDS`
  docblock, verbatim, one owner kind later: *"written as `ownerKind: 'event'`
  with an `ownerId` of `scene-…`, which resolves … to an event row that has
  never existed."* D476 moved the write to `ownerKind: 'object'` and its own
  docblock flags the choice as pragmatic — it is still a synthetic id in a
  namespace the writer does not own.
* **1 is a real orphan** — `event:edd73f47-…:snapshot:1789195606697`, a motion
  visit still whose event is gone. That is the cascade's true escape rate.

**Why nothing swept the 675, which is the finding that matters.** The orphan
audit is correctly wired, runs in `mode=reclaim` (the D304 default), and does
reclaim — 36 passes since 2026-09-01, 16 131 rows, 645 MB. It has nonetheless
never LOOKED at these rows, and cannot.

`pageForAudit` walks the collection by `ORDER BY id ASC` with an `OFFSET`
cursor. Pre-migration the media id is `<ownerKind>:<ownerId>:<kind>:<ts>`, so
the 300 910 `event:` rows sort first — ordered by their UUID — and the mosaics,
whose ownerId begins `summary-`, land at the END of that block:
**offset 300 220 of 532 384**. The walk advances `maxRowsPerScope: 20_000` per
pass and the cursor lives in RAM (`orphanAuditCursors`, with a docblock arguing
that persisting it "would be a durable record of a purely advisory position").
The addon respawns many times a day — nine `analytics orphan audit scheduled`
lines on the day of measurement alone — and the interval is 6 hours, so the
cursor almost never survives to a second pass. Every pass therefore walks
offsets 0–20 000 and stops. The log has been saying exactly this for ten days:

```
analytics orphan audit {mode=reclaim collection=pipeline-analytics:media
  examined=20000 orphans=0 reclaimed=0 bytesReclaimed=0 exempt=0 withinGrace=0
  unresolvable=0 stoppedBy=row-ceiling nextCursor=20000}
```

`orphans=0` is not a bug — offsets 0–20 000 really are 20 000 live motion
snapshots. **96 % of the media collection has never been examined by the orphan
audit**, and that is where all 675 mosaics and all 9 845 MiB of track orphans
live. A `track:`-prefixed row sorts last of all.

Today's D474 migration then swapped one reason for another. It rewrote the
299 883 resolvable rows to `motion:`, which moved the mosaics to offset 0 — but
`'event'` is now in neither `OWNER_KINDS` nor `RETIRED_OWNER_KINDS`, so
`resolveMediaOwner` returns `unresolvable`, and bound #4 ("an unresolvable row
is left alone and counted") makes them permanently immortal. They are now
reachable and unreclaimable, having been unreachable and reclaimable.

**`existingEventIds` is worse than a "missed reclaim".** D476's ADR records the
three-table union as costing a missed reclaim, not a wrong delete, and defers
it. Post-D474 the ids are per-table rowid aliases and the overlap is measured
total: object ids run 1–100 051, audio ids 1–391 984, motion ids 1–1 665 459 —
**100 051 of 100 051 object ids and 391 984 of 391 984 audio ids are also
motion ids.** The probe does not occasionally answer "live" for a dead event; it
answers "live" for every object- and audio-owned media row that exists. The
same collapse is in `disk-reconcile.ts`, whose `eventsWithMedia` set is keyed by
`ownerId` alone across all three owner kinds. Both are missed reclaims, never
wrong deletes — and both are now unconditional rather than rare. They did not
contribute to these 676 (the mosaic ids are strings that match nothing), so this
is a separate, total leak.

## Decision

**A paged bulk sweep either covers the whole collection or it is a sweep of the
collection's head, and the head is whatever the id order happens to put there.**
Three things follow, and none of them is optional on its own:

1. **The cursor is persisted, and the walk is sharded by the dimension the
   sweep judges** — one cursor per `ownerKind` over the existing
   `idx_media_owner`, never one offset across the whole id space. An advisory
   position that resets to zero is not advisory, it is a blind spot whose size
   is "everything after the row ceiling".
2. **A scope reports its SIZE and its coverage, and warns when it has not
   reached `exhausted`.** `stoppedBy=row-ceiling nextCursor=20000` against a
   532 384-row collection reads as pacing; it was a ten-day outage.
   `bytesReclaimed=0` for many consecutive passes of a `reclaim`-mode scope
   against a standing backlog is a WARN, not an INFO — that is the D304
   argument, which fixed the MODE while the ceiling kept the effect.
3. **A synthetic owner id gets its own owner kind.** A writer may not invent an
   id in a namespace it does not own, whatever kind it borrows. The mosaic's
   lifetime is a per-rule bound enforced by its writer (as `boundReferences`
   does for `scene`), not a guess by a sweeper probing a table the id was never
   in.

And **a cleanup deletes bytes**: the reclaim path is `deleteConfirmed`
(unlink → re-probe → drop the row, throwing if it cannot confirm), never
`deleteByKey`, whose `deleteByKeyUnchecked` swallows the unlink error and drops
the row anyway — converting an orphan into a silent leak. The media store's own
docblock already says this is "NOT tolerable for a bulk reclaim"; the audit is
the bulk reclaim and calls the wrong one.

A native `ON DELETE CASCADE` is not available and never was: `media.ownerId` is
polymorphic across six tables with the type in `ownerKind`, and a SQL
`FOREIGN KEY` targets exactly one table. `PRAGMA foreign_keys` has been ON since
2026 (`sqlite-settings-backend.ts:399`), so the pragma was never the constraint.

## Consequences

The sweep must start from the MEDIA row and verify the owner, which it already
does — the defect was reach, not direction. Retention keyed off the event can
never see these rows and is not the place to fix it.

Ordering is load-bearing: the mosaics must be migrated to their own owner kind
BEFORE `'event'` joins `RETIRED_OWNER_KINDS`, or the retired-owner path (which
is bounded, byte-deleting and correct) will collect 271 MiB of delivered
notification images. `'event'` must then join `RETIRED_OWNER_KINDS` in the same
change, or the single genuine orphan and every future leftover stays immortal as
`unresolvable`.

`OwnerRef` gains the owning TABLE (`{kind:'event', table:'motion'|'object'|
'audio', eventId}`) so the probe can be per-table; `existingMotionEventIds`
already exists as the model. `disk-reconcile`'s `eventsWithMedia` becomes keyed
by `(ownerKind, ownerId)`. Until then, no object- or audio-owned media row can
ever be reclaimed.

A per-kind sharded walk costs more cursors and one index seek per shard, and it
is the only shape in which a low-volume owner kind cannot be starved by a
high-volume one. `better-sqlite3` is synchronous on hub-main, so the `breathe()`
yield and the page size stay exactly as they are; the row ceiling becomes
per-shard rather than per-collection.

## Enforcement

The script is NOT named by path here: this record is `proposed`, the
guard ships with the implementation, and a path that does not exist yet
fails `docs:check`'s dead-reference rule and blocks every commit in the
repository. A record cites a path once that path is real.

A guard — a sweep-coverage check under `scripts/`, wired into
`.github/workflows/ci.yml` — fails when a paged scope's row ceiling is smaller
than the collection it walks without a persisted cursor, and when an audit
`reclaim` dep resolves to a delete that is best-effort about its blob.

A test asserts a mosaic write is refused by the type at a borrowed owner kind,
and that a scope whose collection exceeds the row ceiling reaches every shard
across N passes with the cursor discarded between them — the respawn case, which
is the one production actually runs.

Not enforceable by a guard, and so written down: the hub's own audit last
completed a pass on 2026-09-09 04:23 (`pipeline-analytics:ops-log`,
`nodeId='hub'`) while both agents ran the same day. Nothing reports that a node
has not completed a pass. Review only.

## What was implemented, in the order the record requires

Shipped 2026-09-12, in this order, because the order is a safety property and
not a preference:

1. **`mosaic` is an owner kind of its own** (`OWNER_KINDS`,
   `MEDIA_OWNER_TYPES`), its owner id is the RULE, and the count per rule is
   bounded by the WRITER — `summary-mosaic.ts`, `SUMMARY_MOSAIC_MAX_PER_RULE`
   = 200 (~3 days / ~80 MiB at the busiest rule's measured 66 rows, 27 MiB per
   day; over six months for a nightly digest). `NcSummaryPorts.storeMosaic`
   takes a `ruleId` and no owner id at all, and its port has no `ownerKind`
   parameter to borrow. `resolveMediaOwner` answers a new `writer-bounded`
   `OwnerRef` — counted, never probed, never deleted — which is deliberately
   NOT `exempt`: an exempt kind is an enrolment product and
   `locationForOwnerKind` would move the blob to the gallery volume, and a
   mosaic lives where event media lives. `nc.deleteRule` drops a rule's
   mosaics through the same bound at `keep: 0`, because a deleted rule never
   writes again and the writer's bound would never run for it.
2. **THEN `'event'` joined `RETIRED_OWNER_KINDS`**, so the 676 leftovers reach
   the existing bounded, byte-deleting retired-owner path.
3. **The cursor is persisted and the walk is sharded.**
   `pipeline-analytics:sweep-cursors` holds one KV row (`SweepCursorStore`),
   loaded at the start of a pass and written at the end — the embedding leg's
   cursor rides in the same row, since it had the identical RAM-only reset.
   `buildOrphanScopes` emits one scope per owner kind
   (`MEDIA_AUDIT_SHARD_KINDS` = `OWNER_KINDS` minus the exempt and
   writer-bounded kinds, plus every retired kind), each with its own cursor,
   and `pageForAudit(ownerKind, offset, limit)` orders by `ownerId` rather than
   `id`: with `WHERE ownerKind = ?` that is the index's own order, while
   `ORDER BY id` adds `USE TEMP B-TREE FOR ORDER BY` over the whole shard
   (198 066 rows on `track`), rebuilt per page — verified with `EXPLAIN QUERY
   PLAN` on the post-migration copy. Rows whose owner kind no shard walks are
   COUNTED each pass (`countOwnerKindsOutside`, index-only) and WARNed, so the
   sharding cannot itself become a new blind spot. The "purely advisory
   position" docblock is gone.
4. **The reclaim is `deleteConfirmed`.** `OrphanAuditDeps.reclaim` answers
   `{ rows, bytes }`: `rows: 0` counts as nothing, a throw KEEPS the row and
   counts `reclaimFailed` at WARN, and `bytesReclaimed` is what the delete
   confirmed (falling back to the index row's `sizeBytes` only when the delete
   could not say).
5. **The event probe is per table.** `existingEventIds` is GONE, replaced by
   `existingEventIdsIn(table, ids)`; `OwnerRef` carries the table and
   `questionsFor` groups the ids by it. `disk-reconcile`'s `eventsWithMedia` is
   keyed `(ownerKind, ownerId)` and its `deleteEvents` takes `{ table, id }`
   refs.

A scope now reports `collectionSize` (`null` when unmeasured, never 0) and
`coveredWholeShard`, both on the INFO line next to `stoppedBy`; the engine
WARNs when a pass did not cover its scope, and when a reclaim-mode pass found
orphans and freed no bytes.

### Corrections to this record, found while implementing it

Measured again on `migr-rehearsal/prova3.db`, the same copy:

* **`track`-owned orphans are 23 594 rows / 9 714 MiB**, not 23 874 / 9 845.
  Both are the same finding; the record's figures were from the pre-migration
  copy's arithmetic.
* **There are no `object`- or `audio`-owned media rows on this hub at all** —
  the post-migration owner kinds are `motion` (299 883), `track` (198 066),
  `summary` (27 377), `event` (676), `face` (2 073), `identity` (437),
  `plate` (47). The three-table union therefore cost nothing YET; every
  object- and audio-owned row that is ever written would have been
  unreclaimable, which is the same defect one step earlier than the record
  states it.
* **`face`-owned rows have 4 orphans / 13 MiB**, unmentioned in the record.
  They are reclaimable by the same `track` probe the resolver already applies
  to a prefixed face owner id.
* **A WRONG delete was found next door**, worse than the missed reclaim this
  record describes: `EventStore.deleteByIds` deleted an id from the motion AND
  audio tables at once (disk reconcile's only event delete). Post-D474 that
  removes an unrelated audio episode for every doomed motion visit, and every
  audio id on this hub is also a motion id. It is now `deleteByIdsIn(table,
  ids)` with no id-only door left.

### What the next reclaim will do

From the post-migration copy, once the shards are walked: **23 594 `track`
rows / 9 714 MiB**, **676 `event` rows / 271 MiB**, **4 `face` rows / 13 MiB**
— about 9 998 MiB. Paced by `maxReclaimPerScope` (2 000 rows per shard per
pass) and `maxRowsPerScope` (20 000 examined per shard per pass), the `track`
shard needs ~12 passes to clear its backlog and ~10 to walk its 198 066 rows;
at the 6-hour interval that is about three days, and the cursor now survives
the respawns in between. The 271 MiB of legacy mosaics goes in the FIRST pass
(676 rows, one shard, under both ceilings).
