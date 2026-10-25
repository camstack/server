---
id: D781
title: The retrain dataset is the fourth tenant of the artifacts class, never footage media
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/__tests__/retrain-durable-storage.spec.ts
---

## Context

The retrain copies (copy-on-select, D86) were written under
`RETRAIN_MEDIA_LOCATION = 'eventMedia'`, at `retrain/<deviceId>/<trackId>/…`
of the event-media root. `eventMedia` is a footage class: it `defaultsTo:
'recordings'`, it is drained and relocated as a class, and the operator can
wipe or swap its disk. On 2026-08-17 the recordings volume was wiped and the
whole retrain dataset went with it (D197 names the residue and leaves it
open). Its occupancy was not counted either: `eventMedia` occupancy is the
`<camera>/events` subtree (D327), and `retrain/` is not under a camera.

The cloud-training plan (Phase 0, P1) freezes dataset versions that point at
these frames, so a frame that a sweep, a drain or a disk swap can remove
would corrupt a version after the fact.

The plan asked for "a dedicated `retrain` location". A new declared storage
class was considered and rejected:

- **A new `retrain` class** (single, `defaultsTo: 'artifacts'` or its own
  root). D341 records the operator's rule for exactly this kind of media
  (curation work with no retention, operator-created): *one generic class,
  not one per producer*, and "a separate class remains rejected" for the
  gallery, the identical case. It would also add a fourth location to place
  and repoint; and if it shared the artifacts root, the unmapped-type
  occupancy rule ("any non-dot entry at the root") would make each class look
  occupied by the other's bytes.
- **The addon data dir.** D341: addon dirs carry no media.

## Decision

**Retrain copies are the FOURTH tenant of the `artifacts` class, in its
top-level `retrain/` subtree, addressed through the PERMANENT row ref
`retrainMedia`.** The media-storage wiring maps `retrainMedia` to the
artifacts root; the rows' relative paths keep the `retrain/` prefix, so one
path derivation serves old and new copies. Like `galleryMedia`, the ref is
never restamped for a root move: the singleton repoint already carries the
whole artifacts tree, `retrain/` included.

- Every NEW copy is written to `retrainMedia` and its row says so. No
  `eventMedia` resolver is consulted.
- Copies taken before this decision (NULL `locationId`, or a concrete
  `eventMedia:*` id) are moved by a boot reconcile,
  `RetrainFrameStore.relocateLegacyCopies`: copy → read back → restamp →
  delete the source. A copy whose bytes are already gone is reported and its
  row is KEPT, because its annotations are the operator's work.
- An `eventMedia` relocate pass never selects a `retrainMedia` row; it still
  moves a legacy copy that has not been reconciled yet. The seal and the
  location discard select by `locationId`, so they never reach the tenant.
- Retention: none, as before. The table is bounded only by operator
  selection. No media-class retention, mover or eviction may be mapped to the
  tenant (D341).
- Backup: like the gallery, the dataset is NOT in the system backup (D341's
  operator decision for media classes).

## Consequences

- Occupancy: the artifacts class is unmapped in `STORAGE_CLASS_SUBTREES`, so
  `retrain/` counts toward it without any change.
- A hub without a resolvable `artifacts` location refuses new copies
  (`write-failed`, logged) and leaves legacy copies where they are; the next
  boot retries the reconcile. It never falls back to the footage volume.
- On the live hub on 2026-10-08 there were 0 retrain copies, so the
  reconcile has nothing to move there.

## Enforcement

`retrain-durable-storage.spec.ts`: a new copy is stamped and written to
`retrainMedia`; a selected frame survives a wipe of every `eventMedia*` key;
the reconcile moves NULL and concrete rows, keeps a row whose bytes are gone,
and converges; an `eventMedia` move pass leaves a durable copy alone. With
the old `eventMedia` write location the wipe and migration tests fail.
