---
id: D161
title: A live track is never forgotten, only closed — and every delete reports the bytes it freed
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/delete-track-cascade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit-actions.ts
---

## Context

Measured on the live hub on 2026-08-14: **74,700 `ownerKind='track'` media rows
with no track row, 18.9 GB, files still on disk, growing ~1.15 GB/day**, plus
23,296 orphan object events and 4,543 orphan CLIP vectors. The ops log said
`3,732 cascade ops, 8,461 tracks deleted, 0 events, 0 media, bytesReclaimed 0`.

**The first hypothesis was wrong, and how it was killed matters.**
`docs/design/track-persistence-gates.md` §2.2 proposed that `MediaStore`'s
`this.gated(...)` — a WRITE gate wrapping the DELETE paths — was closing exactly
when space needed freeing. It cannot be: `MediaWriteGate.run` only ever
_throws_, `cascadeDeleteTracks` runs every leaf **before** the root, and
`runTrackCascadeBatch` counts a track only if nothing threw. A closed gate would
therefore have left the 8,461 track rows in place. They are gone. The gate is
innocent, and so is the cascade: driven over a real `SqliteSettingsBackend`
rather than the test fake, it removes every media row, every object event and
every blob (`cascade-over-real-sqlite.spec.ts`).

The cascade never ran on these tracks, because **they never had a row to
cascade from.** `TrackStore` persists a track exactly twice: at TTL expiry
(`expireStale`) and for synthetic rows. `pipeline-analytics` also called
`trackStore.dropActive(trackId)` — drop the in-RAM entry, write nothing — when a
track was promoted to a _stationary_ (parked) object. By then the track has
lived a full life and owns a full media set: `keyFrame`, `thumbnail`,
`firstFrame`, the rolling `lastFrame`, the snapshot filmstrip, its object events
and its CLIP vector, all keyed by trackId. The persisted row is the ONLY thing
`TrackStore.listIdsBefore` selects and the ONLY thing the cascade descends from,
so every promotion made that footprint permanently unreachable — not deleted
late, _never_. The stationary entry that replaced it retires on its own TTL and
takes none of it. Confirmed on the live hub over the tRPC API: tracks whose
object events are **six hours old** — far inside every device's retention window
— already have no track row and still return 5–9 media rows from
`listTrackMedia`, with the same kind-distribution as live track media.

Nobody saw it because the counter could not say so. `TrackScopedStore.
deleteByTracks` returned `void`, so `pruneTracksBefore` filled every leaf field
with a literal `0` and wrote `bytesReclaimed: 0` on every ops-log row it had
ever produced. A counter that can only ever be 0 reads as "there was nothing to
reclaim".

## Decision

**A track that has lived is CLOSED, never forgotten.** Any caller ending a live
track early calls `TrackStore.closeActive(trackId)` — persist the row, then drop
the RAM entry — and logs a failure loudly, because a swallowed persist here _is_
the leak. `dropActive` remains correct for exactly one case: a birth RETRACTED
before it lived, where nothing has been written under that id yet. It is never
correct for a track that ran.

**Every delete reports what it removed.** `deleteByTracks` returns
`TrackCascadeLeafCount[]` (`family`, `rows`, `bytes`); `cascadeDeleteTracks`
folds them into a `TrackCascadeTally`; `pruneTracksBefore` returns the real
per-family counts and the ops-log row carries the real `bytesReclaimed`. A
family that holds no blobs reports 0 bytes _because it holds no blobs_, which is
a different statement from 0 because nobody counted. **If a reclaiming path
cannot count its bytes, it does not ship.**

**Draining a backlog is an operator ACT, not a setting left switched on.** The
`retention.orphanAudit` custom action runs one bounded orphan-audit pass:
dry-run unless `mode: 'reclaim'` is typed, `restart` to walk from the top, the
engine's five existing bounds, a yield of the event loop between pages, and a
per-collection report of rows AND bytes.

## Consequences

- A parked object's approach now appears in track history instead of vanishing
  while its images stay on disk. That is a visible product change, and the right
  one: the operator was already paying for the bytes.
- Persisting is D58-safe — it destroys nothing and needs no second read, unlike
  the alternative of cascade-deleting at promotion, which would also have
  broken the stationary entry's `keyFrameMediaKey` thumbnail.
- Five leaf stores changed signature. Any future `TrackScopedStore` must report
  its family, and the type will not let it forget.
- `TrackCascadeCounts` is a cap OUTPUT shape, so the byte total rides
  `lastPruneBytes` into the ops log rather than widening the cap.
- The standing 18.9 GB is NOT cleaned by any of this. It is drained by running
  `retention.orphanAudit` in `reclaim` mode, repeatedly, until `totalOrphans`
  reaches 0 — deliberately manual.
- The orphan audit keeps its role as a BUG DETECTOR: once the backlog is drained,
  a non-zero orphan count for a track-owned family means a new hole.

## Enforcement

- `cascade-over-real-sqlite.spec.ts` drives the shipped registry over a real
  `SqliteSettingsBackend` — the fake had passed throughout the leak — and pins
  both the forgotten-vs-closed difference (via `listIdsBefore`, the query
  retention actually uses) and a non-zero `bytesReclaimed`.
- `orphan-audit-reclaim-action.spec.ts` pins the dry-run default, the per-page
  yield, the real byte total and the reclaim ceiling.
- `scripts/check-age-keyed-retention.ts` still governs: the audit selects on
  ownership and its `graceMs` can exclusively SAVE a row, so it remains not a
  second age-keyed sweep.
- Not enforced by a guard: that a future caller reaches for `closeActive` rather
  than `dropActive`. The doc comment on `dropActive` names the failure and the
  byte count, which is the next-best thing.
