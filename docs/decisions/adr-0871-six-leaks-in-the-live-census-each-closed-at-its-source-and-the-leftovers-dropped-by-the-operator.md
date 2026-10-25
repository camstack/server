---
id: D871
title: Six leaks found in the live census are closed at their source, and the leftovers they left on the hub are removed by the operator, never at boot
status: accepted (its two operator scripts, prune-liveness-orphans and rewrite-stats-5m, ran on the operator hubs and were deleted with D900; the rest stands)
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/device-removal.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/retention-scope.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/sweep-summary.ts
  - packages/system/src/builtins/device-manager/device-tombstone-store.ts
---

## Context

A census of the operator's hub (`camstack.db` 1.8 GB, 282 tables) found six places
where data was kept that nothing would ever remove or read:

| Finding | Numbers |
| --- | --- |
| `notification-center:liveness` ("never pruned") | 1 995 device rows, 912 for devices that no longer exist |
| `pipeline-analytics:audio-events` / `motion-events` | 2.1 M audio rows (83 k/day), 36 k audio and 70 k motion rows OLDER than the oldest track |
| `pipeline-analytics:ops-log` | 4.5 k rows a day: one per device per prune tick |
| `pipeline-analytics:stats-5m`, `pipeline-orchestrator:stats-5m` | 1.07 M rows, 85 MB, plus a 44 MB autoindex on a TEXT id repeating the row's columns |
| `vec_object_clip` (retired MobileCLIP vectors) | 34 k vectors, 92 MB |
| `device-manager:tombstones` | not declared on the hub (server 1.2.581, D865 shipped) |

Tried first and rejected: pruning the liveness ledger against the device
directory (a fallible read destroying work, D49 — the ledger's own comment
forbids it); a per-family retention window for audio and motion (ten disagreeing
clocks was the defect D61/D62 removed); converting `stats-5m` in place at boot
(D853: no migration code in the product).

## Decision

**Each leak is closed where it is produced, with no boot purge. What is already on
the hub is removed by an operator command, named below.**

1. **A deleted device's notification rows go with it.** The notification centre's
   share of the `device-removal-hook` (D865) deletes the device rows of liveness,
   device alerts, system state, snooze counters, occupancy, track groups and the
   artifact index, by `deleteWhere` on `deviceId` (node rows and snooze windows are
   not device rows and stay; artifact bytes stay on the shelf, whose own bounds sweep
   them). The hook is driven by the tombstone, so a failed read still destroys
   nothing. Rows of devices deleted BEFORE tombstones: `scripts/hub/prune-liveness-orphans.ts`. <!-- drift-ok -->
2. **Motion and audio events are swept on the device window, for every device that
   holds them.** They already took the track window in the same pass; what they did
   not get was a visit. The scope of a pass was "cameras today" plus "devices with a
   track", so a deleted camera that never persisted a track, or a microphone, kept its
   rows forever. The scope is now a union of three reads, the third being the devices
   that hold event rows (`EventStore.countByDevice`, read at most hourly and kept on a
   failed refresh).
3. **Retention writes one ops-log row per pass.** `RetentionSweepSummary` folds the
   track cascade and the trackless roots of every device into one cluster-level `prune`
   row whose `detail` is JSON with the per-device counts. The 30-day clock is unchanged.
   The recorder's ops-log is a bounded ring and is left as it is.
4. **The statistics tables key on their four columns.** `stats-5m-v2`: composite
   `primaryKey` (subject, series, scope, bucketStart), `WITHOUT ROWID`, no TEXT `id`,
   no `deviceId` index (nothing reads by it), written by one `upsertMany` per flush.
   The engine cannot change a primary key in place and the door has no drop, so the
   layout lives under a NEW collection name; the old table is not declared by any
   build and is read once by `scripts/hub/rewrite-stats-5m.ts`. <!-- drift-ok -->
5. **Nothing declares or reads the MobileCLIP index.** `object-clip` is no longer a
   valid `vectorIndex` (`CLIP_VECTOR_INDEX_PATTERN` requires a model suffix), the
   orphan audit walks only the per-model indexes (the legacy cursor and scope are
   gone), `mobileclip-s0` joins the removed model ids so a stored pin to it is reset
   like `s1`/`s2` (node-device, per-camera and cluster stores, D725), and the encoder
   logs when its own config names a model outside the catalog.
6. **device-manager declares `device-manager:tombstones` at init.** It was declared
   lazily by the first delete or the first implementer reconcile, so a hub with no
   deletion since D865 shipped, and implementers not yet redeployed, had no table.
   A declaration, not a purge; a failure is logged and the store declares on first use.

## Operator commands (nothing here runs by itself)

Order for the hub, all through the admin API (`scripts/hub/hub.mjs`), never against
the SQLite file (D679), `--server` is mandatory:

```bash
# 1. liveness rows of devices deleted before tombstones (dry run first)
npx tsx scripts/hub/prune-liveness-orphans.ts --server <hub>
npx tsx scripts/hub/prune-liveness-orphans.ts --server <hub> --apply

# 2. statistics: STOP pipeline-analytics and pipeline-orchestrator first
npx tsx scripts/hub/rewrite-stats-5m.ts --server <hub>            # counts only
npx tsx scripts/hub/rewrite-stats-5m.ts --server <hub> --apply    # old tables only READ
#    exit 0 means new row count == old row count; then start the new builds.
#    Interrupted? rerun with --resume. A missing series is reported: --series <name>.
```

Then, after the new builds run and the charts read (Node stress, occupancy), the
physical drops through `storageAdmin.dropCollection` (D870). Its input is
`{ collection, expectRows }`: read each row count from `storageAdmin.listTables` first and
state it, or the engine refuses. The three names are in
`STORAGE_ADMIN_MOVED_COLLECTIONS` (retired by exact name; without that entry the call
is refused, the owners being installed or the name unscoped):

```bash
node scripts/hub/hub.mjs --server <hub> POST storageAdmin.listTables '{}'    # rows per table
node scripts/hub/hub.mjs --server <hub> POST storageAdmin.dropCollection '{"collection":"pipeline-analytics:stats-5m","expectRows":<rows>}'
node scripts/hub/hub.mjs --server <hub> POST storageAdmin.dropCollection '{"collection":"pipeline-orchestrator:stats-5m","expectRows":<rows>}'
node scripts/hub/hub.mjs --server <hub> POST storageAdmin.dropCollection '{"collection":"vec_object_clip","expectRows":<rows>}'
```

Expected reclaim: ~130 MB from the statistics tables (85 MB rows + 44 MB autoindex, less
what the new layout needs), 92 MB from `vec_object_clip`. The one-shot scripts are removed
once the hub has run them.

## Consequences

- The release that carries item 4 and the conversion are one operator window
  (D853): until the script ran, the new addons read an empty `stats-5m-v2` (charts
  start empty), the old rows are intact. Item 4 holds for the hub; a fresh install is
  unaffected.
- A per-device ops-log query (`listOpsLog({ deviceId })`) no longer finds the retention
  rows: they are cluster-level now, with the device in the payload.
- The pass reads the device ids that hold events at most once an hour: a device that
  starts holding events is swept at the next refresh.

## Enforcement

- `notification-center/__tests__/device-removal.spec.ts` (every collection by
  `deviceId`, node rows kept, a failing collection does not stop the others and is
  rethrown; filtering on another id turns it red), `scripts/__tests__/prune-liveness-orphans.spec.ts` <!-- drift-ok -->
  (two disagreeing, empty or malformed reads, a failed tombstone read, and a ledger
  that knows none of the listed devices all delete nothing).
- `retention/__tests__/events-follow-the-track-window.spec.ts`: after a pass no audio or
  motion row is older than its device's window; without the event-holding devices in
  scope an untracked non-camera keeps its stale rows (the defect, asserted red).
  `sweep-summary.spec.ts`: 36 devices over 288 ticks make 288 rows.
- `durable/__tests__/lts-composite-key-over-real-sqlite.spec.ts`: the per-subject read is
  a `SEARCH ... USING PRIMARY KEY (subject=? AND series=? AND scope=? AND bucketStart>?
  AND bucketStart<?)` with no sort, the series read uses `idx_lts_series_bucket`, on
  the statement the store really prepares (D447); `rewrite-stats-5m.spec.ts`: the old
  table is only read, a short copy is a mismatch, a rerun resumes.
- `types/__tests__/clip-model-meta.spec.ts` (bare `object-clip` refused),
  `removed-model-pin-reset.spec.ts` (all three MobileCLIP tiers reset),
  `sweep-cursor-store.spec.ts`; `device-removal-hooks.spec.ts` (the tombstone table
  exists after init, before any delete or read; skipping the declaration turns it red).
- `scripts/check-durable-state-declared.ts` keeps the three `durable-ledger.ts` copies
  and the two `lts-aggregator.ts` copies identical.
