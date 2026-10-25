---
id: D481
title: A narrower index is dropped only when the wider one is MEASURED serving its queries, in both statistics worlds
status: proposed
date: 2026-09-12
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/media-index-audit-capture.spec.ts
last-verified: 2026-10-02
---

!!! warning "The measurement below is from BEFORE D482. The rule survives it; the numbers do not."

    Re-read 2026-09-23. **The rule in Decision still stands, and it is now cited
    in the code it governs** (`MEDIA_INDEXES`, on `idx_media_slot`). Two things
    under it have moved and neither has been re-measured:

    - **The table carries EIGHT b-trees now, not seven.**
      [D482](adr-0482-a-media-row-is-addressed-by-its-own-id.md) stopped
      `media.id` encoding its owner, and the idempotence that the composite id
      used to carry moved to a new UNIQUE index, `idx_media_slot` over
      `(ownerKind, ownerId, kind, slotTs)`. It leads with the same prefix as
      `idx_media_owner` and is deliberately NOT treated as replacing it — by
      this record's own rule, quoted there. Every MB figure in the census below
      was taken before that index existed, and so was the ~98.71 MB total.
    - **`getByKey` is gone.** The `sqlite_autoindex_…media_1` row's verdict
      names it as one of two consumers; only `pageForAudit` survives, and the
      autoindex's reason for keeping is now simply that `media.id` is the
      primary key.

    **The drop this record recommends has NOT shipped.** `idx_media_location`
    is still declared, the prefix guard under Enforcement is still unarmed, and
    `status:` is still `proposed`. Whoever ships it re-runs the capture harness
    first: the read surface changed under D474/D476 (the event-id split), D480
    (the orphan audit covering the whole collection) and D547, and a plan
    measured against a statement the store no longer prepares is exactly what
    this record exists to refuse.

## Context

`pipeline-analytics:media` carries seven indexes. Two pairs LOOK redundant by
leading column — `idx_media_location` under `idx_media_location_size`, and
`idx_media_device_ts` beside `idx_media_device_size` — and the hand-over put
~24 MB of reclaim on that suspicion. D447 is the record of what "looks
redundant" costs on this exact store: a mis-served aggregate held the one
synchronous `hub/sqlite-settings` thread 4–7 s and every configuration read in
the cluster queued behind it. So nothing here was concluded from a column list.

**Method.** `better-sqlite3`'s `prepare` was observed while every read path
against `media` was driven for real (`media-index-audit-capture.spec.ts`), and
the 22 distinct captured statements were `EXPLAIN`ed on a writable copy of the
hub's own post-migration database — where `sqlite_stat1` exists and the
planner's choice between two indexes that both fit is the real one. A four-row
temp database has no statistics and would have answered a different question:
`analyze-stats.ts` already records the 727 ms → 0.3 ms flip that statistics
decide on this very table.

**Six of the eight figures handed over were wrong, because they came from two
different databases.** Measured by `dbstat`, per index, MB:

| index | post-migration (`prova3.db`) | pre-migration (`camstack.db.pre-d474`) | handed over |
| --- | ---: | ---: | ---: |
| `sqlite_autoindex_…media_1` | 26.70 | 47.21 | 26 |
| `idx_media_owner` | 17.32 | 33.79 | 20 |
| `idx_media_location_size` | 13.66 | 17.25 | 17 |
| `idx_media_kind_device_size` | 12.67 | 16.27 | 16 |
| `idx_media_location` | 11.68 | 14.60 | 14 |
| `idx_media_device_ts` | 9.11 | 10.51 | 10 |
| `idx_media_device_size` | 7.57 | 9.70 | 9 |
| **index total** | **98.71** | **149.33** | 116 |
| table | 102.29 | 136.03 | 134 |

The five middle rows of the hand-over are the PRE-migration numbers; the two
top rows are post-migration. The table is 528 559 rows, not the ~1.25 M every
comment in `MEDIA_INDEXES` still assumes, and 528 122 of those rows are on ONE
location (`eventMedia:ssd`) with ZERO `locationId IS NULL` left — the
collection is fully sealed.

**No index is unused.** Every one of the seven is chosen by at least one plan,
so the only question any of them poses is substitutability.

**`idx_media_location` is substitutable, measured in both statistics worlds.**
Its three consumers are the seal-gate probe, the seal count, and the
location-discard page. With it dropped, all three move onto
`idx_media_location_size` with an identical search shape, and the seal count
stays `USING COVERING INDEX`:

    probe   SEARCH … USING INDEX idx_media_location_size (locationId=?)
    count   SEARCH … USING COVERING INDEX idx_media_location_size (locationId=?)
    discard SEARCH … USING INDEX idx_media_location_size (locationId=?)

Same result with the hub's current stale statistics and after a fresh
`ANALYZE`. The scheduled aggregate never touches the narrow index in either
world.

**`idx_media_device_ts` is NOT substitutable, and the pair was never a prefix
pair.** `(deviceId, timestamp)` and `(deviceId, sizeBytes)` share a leading
column and neither is a prefix of the other; each carries a second column the
other cannot supply. Dropping `device_ts` degrades two plans:

    reclaim cursor  SEARCH … idx_media_kind_device_size (kind=? AND deviceId=?)
                    + USE TEMP B-TREE FOR ORDER BY
    relocate census SCAN pipeline-analytics:media
                    + USE TEMP B-TREE FOR ORDER BY

The reclaim cursor loses its ordered seek: `afterMs` stops being a seek and
becomes a filter applied after a sort of the whole `(kind, deviceId)`
population — 97 132 snapshot rows on the worst camera, per page, for a
500-row page. The relocate census stops using an index at all and becomes a
full scan of the 26 187-page table plus a sort of 528 559 rows.

**Rejected: one `(deviceId, timestamp, sizeBytes)` replacing both device
indexes.** It was built and measured. It preserves every plan — the reclaim
cursor's range search with no sort, the `GROUP BY deviceId` histogram and the
per-camera aggregate as covering scans, the fleet total as a covering scan —
and it costs 11.13 MB against the 16.68 MB of the two it replaces, so 5.55 MB.
It is rejected because the census's skip-scan
(`SEARCH … (ANY(deviceId) AND timestamp>? AND timestamp<?)`) came back only
AFTER `ANALYZE`: a skip-scan needs statistics, a new index ships with none, and
`runAnalyzeIfMissing` is one-shot on the existence of `sqlite_stat1` and will
therefore never re-run on this hub. Shipping it alone buys 5.55 MB and hands
the relocate census a full table scan with no log line. 5.55 MB is not worth a
plan that depends on a refresh the system has deliberately disarmed.

**Found on the way, unasked: four of the six named indexes have no statistics
at all.** `sqlite_stat1` on this hub holds rows only for `idx_media_owner`,
`idx_media_device_ts` and the autoindex — the three that existed when the
one-shot `ANALYZE` ran — and those rows say 872 225 rows / 145 371 distinct
owner pairs against a measured 528 559 / 75 509. `idx_media_location_size`,
`idx_media_device_size` and `idx_media_kind_device_size` are being chosen on
default guesses. They are chosen CORRECTLY today, because covering-ness is
structural and does not need statistics — but that is luck holding, not a
property, and it is the same condition `analyze-stats.ts` was written for.

## Decision

A narrower index is dropped only when the wider one is measured serving every
one of the narrow index's queries — from the statement the store really
prepares, `EXPLAIN`ed on a copy of the real database, and confirmed both with
the statistics the hub actually has and after a fresh `ANALYZE`, because a plan
that holds in only one of those two worlds is a plan that changes without a
deploy. A shared leading column is not a prefix relationship: two indexes
`(a, b)` and `(a, c)` are both load-bearing until the queries behind `b` and
`c` are each shown served elsewhere. And a REPLACEMENT index inherits no
statistics, so any plan of its that needs them (a skip-scan) is a regression
until an `ANALYZE` that nothing schedules has run.

Verdicts for the seven, each with the plan that decided it:

| index | verdict | measured reason |
| --- | --- | --- |
| `sqlite_autoindex_…media_1` (26.70 MB) | keep | out of scope by decision; `media.id` is the idempotence key. Serves `getByKey` and `pageForAudit`. Not reclaimable. |
| `idx_media_owner` (17.32 MB) | keep | seven statements, no wider index carries `(ownerKind, ownerId)`; `remainingMedia` is covering on it. |
| `idx_media_location_size` (13.66 MB) | keep | the ONE scheduled aggregate (D447), `USING COVERING INDEX` in both statistics worlds, and it absorbs the narrow index's three queries. |
| `idx_media_kind_device_size` (12.67 MB) | keep | the only index leading with `kind`; both per-kind aggregates covering. |
| `idx_media_location` (11.68 MB) | **drop** | all three consumers move to `idx_media_location_size` with an identical search shape, covering where they were covering, in both statistics worlds. |
| `idx_media_device_ts` (9.11 MB) | keep | sole server of the reclaim cursor's ordered seek and the relocate census's skip-scan; dropping it yields a full table scan plus a 528 559-row sort. |
| `idx_media_device_size` (7.57 MB) | keep | covering for the `GROUP BY deviceId` histogram, the per-camera aggregate and the fleet total. Replacing it and `device_ts` with one three-column index saves 5.55 MB and is rejected above. |

**Reclaimable: 11.68 MB, one index, no downtime** — not the ~24 MB the
suspicion offered, and not 116 MB of index either.

## Consequences

- Dropping `idx_media_location` is a `DROP INDEX` plus removing its entry from
  `MEDIA_INDEXES`; `declareCollection` emits `CREATE INDEX IF NOT EXISTS` and
  never drops, so removing the declaration alone leaves the index on every
  existing hub forever. The drop has to be done on the database, and the
  declaration removed so it is not rebuilt.
- The comment on `idx_media_location` documents the seal gate and is the only
  place the `NULL`s-sort-first reasoning is written down. It moves onto
  `idx_media_location_size`, or the reasoning is lost — the gate still depends
  on it, just on a wider b-tree.
- The `~1.25 M rows` and `~24 MB` / `~36 MB` figures in `MEDIA_INDEXES` are
  stale by roughly half and should be restated against 528 559 with the
  `dbstat` numbers above.
- Whoever ships the drop should add the structural guard this record cannot add
  today (below), since with `idx_media_location` present it would be red.
- The occupancy refresh's cadence is NOT the five minutes D447 observed:
  `LocationOccupancySlice` is serve-and-revalidate on a 60 s window
  (`DEFAULT_STALE_AFTER_MS`) kicked by any read, so once a minute is the floor
  and five minutes was how often a reader asked. The scheduled aggregate's
  covering-ness matters more than D447 says, not less.
- The missing statistics are a separate decision, deliberately not taken here.
  Re-analysis would put a multi-second statement on the settings thread, which
  is what `analyze-stats.ts` refused; naming the condition is what this record
  does.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/media-index-audit-capture.spec.ts`
  captures the prepared statement for every read path against `media` and
  writes it to `CAMSTACK_D481_CAPTURE`. It is the harness that makes this
  auditable again without re-deriving the read surface; it asserts capture, not
  plans, because the plans that matter need the real database's statistics.
- `media-footprint-plan-over-real-sqlite.spec.ts` (D447) already holds the
  scheduled aggregate to `USING COVERING INDEX idx_media_location_size`, and it
  is what would go red if the drop were mistaken about which index the
  aggregate uses.
- **Not yet armed, to add with the drop:** a guard asserting no entry in
  `MEDIA_INDEXES` has columns that are a strict prefix of another entry's. It
  would be red today on `idx_media_location`, which is the finding, and green
  the moment the drop ships — after which it stops the pair being
  re-introduced.
