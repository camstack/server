---
title: Non-blocking storage migration — repoint first, drain second
last-verified: 2026-09-01
covers:
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/types/src/interfaces/relocate.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/addon-admin-ui/src/components/recordings/migration/StorageMigrationSection.tsx
  - packages/addon-admin-ui/src/components/recordings/migration/mover-progress.ts
---

# Non-blocking storage migration

> **The question.** `storageMigration` moves the bytes *inside* a global pause.
> The destination class of disk does 7–14 MB/s at 95 % util and `recordings` is
> 1.09 TB, so the existing shape means **thirty hours of stopped recording**.
> Can the write path be cut over first and the archive drained behind it?
>
> **Answer: yes, and almost nothing new is needed — but two defects in the
> DRAIN half have to be fixed first, and they break the existing blocking
> migration too.** Both are now fixed: the durable hour-row re-point (D291) and
> the `eventMedia` NULL-row seal plus its plan-time gate (D292). §8 tracks what
> shipped and what is still only specified.

Supersedes the "sequenza senza pausa" [sequence without a pause] in
[`2026-08-26-low-events-storage-migration-to-ssd.md`](./2026-08-26-low-events-storage-migration-to-ssd.md)
§"How to work around the pause", whose central safety claim ("the path is the data,
there is no table to rewrite") stopped being true three days after it was
written — see D287 and D291 — and whose `config.readOnly` lever has a
disk-pressure side effect described in §5 below.

---

## 1 · Can the write path be repointed without a restart?

**Yes.** Nothing about a location is boot-resolved-and-frozen; what is missing
is a *notification*, not a mechanism.

| Step | Where |
| --- | --- |
| Change the default | `StorageOrchestratorService.setDefaultLocations`, `packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts:406` — **service-internal, on no cap**, reachable only from the migration coordinator |
| Recorder re-resolves | `refreshLocations()`, `packages/addon-pipeline/src/recorder/addon/index.ts:1855` |
| Stored per-camera placement dropped | `resetPlacementPlan()`, called from `refreshStorageLocationsForMigration`, `packages/addon-pipeline/src/recorder/addon/index.ts:2137` |
| Writers pick the new root | at an ATTACH boundary, `packages/addon-pipeline/src/recorder/addon/recording-controller.ts:1629` |
| Analytics re-resolves | `invalidateRoots()` + `eventMediaWriteLocationCache = null`, `packages/addon-post-analysis/src/pipeline-analytics/index.ts:12865` |

Two facts decide the shape:

- **Nothing pushes a location change.** `setDefaultLocations` emits no event and
  calls no consumer (`storage-orchestrator.service.ts:406`); a plain
  `upsertLocation` is invisible to the recorder until boot or an operator
  `rescanStorage`. The coordinator is the only thing that pushes — which is
  precisely why the cutover belongs *inside* the coordinator and not in an
  operator runbook.
- **A continuously-recording writer never reaches an attach boundary on its
  own.** So the cutover has to *make* one.

`RecordingController.pause()` / `resume()`
(`packages/addon-pipeline/src/recorder/addon/recording-controller.ts:2076`,
`:2094`) is exactly that: detach every device in parallel, then re-evaluate
every configured device from its current config. It is already the migration's
pause primitive. **The non-blocking mode does not need a new primitive — it
needs the existing phases in a different order.**

---

## 2 · The design

Today:

```
planning → pausing → moving(30 h) → verifying → repointing → refreshing → resuming → done
```

Non-blocking:

```
planning → sealing → pausing → repointing → refreshing → resuming → draining → verifying → done
                     └────────── the cutover: seconds ──────────┘   └── hours, everything running ──┘
```

The past is immutable, so it needs no pause. What it needs is for every reader
and every gate to work while one storage class spans two locations — §3.

`draining` drives the movers that **already exist and already do not pause
anything**: `recording.relocateFootage` (per camera, per profile, throttled) and
`pipelineAnalytics.relocateMedia` (unleased since 2026-08-26,
`packages/types/src/capabilities/pipeline-analytics.cap.ts:1811`). No second
mover. The coordinator keeps its durable job record as the state of record;
progress is read from `getMove`, never from an event (D8/D11).

`blocking` stays the default and stays reachable: it is the right mode for a
small class or a cold system, and `StorageMigrationJob.mode` tells an operator
which one a job is running.

---

## 3 · What breaks while a class spans two locations

Every call site of `docs/design/2026-08-29-recorder-index-at-scale.md` §3, plus
the placement/eviction paths.

| Consumer | Site | Two locations? |
| --- | --- | --- |
| Playback manifest | `recording-provider.ts:507` | **OK** — `collectRangeSegments` builds `rootById` from `deps.locations()`, which lists *every* location, not the default. Union by construction. |
| Scrub/seek locate | `recording-provider.ts:905` | **OK** — per-row `locationId`. |
| Segment/GOP byte reads | `recording-provider.ts:639` | **OK** — per-row. |
| Timeline / calendar | `calendar-index.ts:511` | **OK** — location-blind; derived from index rows. Invalidated on relocate (`recorder/addon/index.ts:847`). |
| Days with footage | `recording-provider.ts:818` | **OK** — index rows. |
| Export | `recorder/addon/index.ts:1034` | **OK** — same collector, `'absolute'` mode stats every file. |
| Retention sweep | `recording-provider.ts:1104` | **OK** — oldest-first over the device's rows regardless of location; each victim is deleted under its own `locationId`. |
| Redundancy sweep | `recorder/addon/redundancy-sweep.ts:168` | **OK** — groups victims by `row.locationId`. |
| Disk-pressure eviction | `storage-evictable-provider.ts:116` | **OK, with a caveat** — see §5. Domain is the physical-root group, so two locations on two disks are two independent domains. |
| `getStorageUsage` | `recording-provider.ts:837` | **Per-volume half depends on D291.** The volume rows come from `archiveAccounting` = the hour ledger (`recording-provider.ts:886`). Before D291 a drain reported the destination at 0 B forever. |
| Placement / rebalance | `placement-service.ts:195` | **WAS BROKEN — fixed (D298/D299).** This row read "OK — a stored assignment naming a location that is no longer in the pool resolves fresh; `resetPlacementPlan` forces this at the cutover", and both clauses were true and neither covered the cutover. A repoint-first migration must leave the SOURCE enabled and writable (it holds the history, and §5 forbids the `readOnly` lever), so "no longer in the pool" never fires. `resetPlacementPlan` does fire — but only through the coordinator's lease, and clearing to empty hands each key back to the planner as a free choice its tie-break can award straight back to the source. On 2026-08-29 that left cameras 1439 and 3839 on `recordingsLow:default` after the other eleven moved, silently. The class authority is now stamped in the placement blob, a change of it REWRITES every assignment of that class onto the new authority per camera, and any residual disagreement is reported per camera with its denominator. |
| **Cold hydrate of a drained hour** | `roots.ts:430` | **BROKEN before D291.** The ledger is the first stop and the disk is not consulted; a moved hour came back at the old root. Fixed. |
| **`eventMedia` rows with `locationId: NULL`** | `media-store.ts:308` | **BROKEN — not yet fixed.** See §4. |

Two standing hazards that are not caused by this design but bound it:

- **`deleteLocation` now refuses a location it has not verified empty** (D293,
  measurement narrowed by [D327](../decisions/adr-0327-occupancy-of-a-shared-root-is-the-class-subtree.md)) —
  it used to check only existence, `isSystem` and last-default-of-type. The probe
  is the **class subtree** (`events/` / `low/` / `high|mid`), still shallow, so a
  drained events location that shares `/recordings` with live high footage is
  `'empty'` when that subtree is empty. `'unknown'` (another node, a remote
  provider, an unmounted root) refuses alongside `'occupied'`, and `force: true`
  is the operator's override. **A migration still must not delete the source**;
  that is a separate, later, verified step.
- **`config.readOnly`, `minFreePercent` and `maxUsedGb` are in no schema** — they
  are untyped `config` keys read tolerantly by the recorder
  (`roots.ts:178`, `:151`). A typo silently means "not read-only".

---

## 4 · `eventMedia` — the one class the cutover cannot serve yet

Reads resolve **per row**: `mediaRowLocation(data)`
(`packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts:308`)
is passed to every read, so a row stamped `eventMedia:hdd` keeps reading from
the HDD after the default moves. That is what makes repoint-first safe — for
rows that carry a concrete id.

It is **not** safe for rows whose `locationId` is `NULL`. `NULL` means
"wherever `eventMedia` points today" (`media-store.ts:396`). Before
`invalidateRoots()` a bare ref hits the boot-time base bypass; after it, it goes
through `storage.resolve` to the **current default**
(`location-aware-media-storage.ts:44`). So the instant the cutover refreshes,
every NULL row starts reading from the new disk while its bytes are on the old
one — the archive goes dark until the drain happens to stamp that row. Three
populations are NULL: rows written before the resolver existed, rows written
during a `listLocations` failure (`pipeline-analytics/index.ts:2762`), and
**every retrain frame**, which always writes the literal `eventMedia` ref and
`locationId: null` (`retrain-frame-store.ts:315`).

**Required before a non-blocking `eventMedia` cutover — all three now built
(D292):**

1. A **seal** pass that stamps `locationId = <the source location's id>` on every
   NULL media and retrain row. It is a row-only pass — no bytes, no array I/O —
   and it lives in `MediaRelocateEngine` as `mode: 'seal'`, not in a second
   engine: that engine already walks exactly these two collections with a
   timestamp cursor and already had a stamp-without-copy path. It stamps the
   **source**, never the destination: those bytes have not moved, and the seal's
   only job is to stop the row meaning "wherever `eventMedia` points now".
2. A **gate in `plan()`**: `mode: 'nonBlocking'` with `eventMedia` selected is
   refused unless `countUnstampedEventMedia` reports zero. The operator runs
   `relocateMedia({ mode: 'seal', toLocationId: <current default> })` first. The
   job's own `sealing` phase then re-runs the seal and **re-counts**, catching
   rows that raced between the plan and the start — and the re-count, not the
   seal job's terminal state, is what decides: a seal that failed some rows
   still finishes.
3. Retrain-frame writes now resolve through `resolveEventMediaLocation` like
   media writes do, and the blob is written to the id the row NAMES. A resolver
   that degrades to the bare `eventMedia` ref still writes NULL, loudly — the
   seal is what the planner counts.

Also note `refreshStorageLocationsForMigration` on the analytics side is
lease-gated and the **only** setter of that lease is
`pauseForStorageMigration` (`pipeline-analytics/index.ts:12862`, `:12839`).
There is no unleased way to drop the write-location cache. That is fine — the
cutover pauses anyway (§5) — but it means the cutover for `eventMedia` cannot
be done "without touching the writer" even in non-blocking mode.

---

## 5 · What must pause, and for how long

**Not "nothing".** Three things need an exclusive instant, and all three are
bounded by an attach round, not by bytes:

| Participant | What the pause is | Bound |
| --- | --- | --- |
| recorder | `controller.pause()` → detach every device (parallel, deadline-bounded per profile) → `setDefaultLocations` → `refreshLocations` + `resetPlacementPlan` → `resume()` re-attaches every device | one teardown + one attach per camera, in parallel — **seconds**, and it is the same gap a placement rebalance already costs per camera |
| analytics | `mediaWriteGate.pause()` → refresh → resume. Reads are never gated. | **milliseconds** — it closes admission and waits for in-flight writes |
| pipeline | lease pause as today | unchanged |

The gap is a *recording* gap, not an outage: the writers come back on the new
root and the archive stays readable throughout (§3). Compare with the number
this design exists to avoid: **30 h → seconds.**

**Do not use `config.readOnly` on the source to force the cutover** — the route
the 2026-08-26 note recommends. `StorageEvictableProvider.domainOf` subtracts
read-only members from the physical-root domain
(`storage-evictable-provider.ts:100`), and today `recordings:default` and
`recordingsLow:default` **share `/recordings`**. Marking `recordingsLow:default`
read-only therefore removes low footage from the eviction domain of a disk that
is under continuous quota pressure right now: the sweep reports fewer evictable
bytes than the disk holds and takes the difference out of `high`. Repointing the
default is enough to move new writes and keeps the source fully first-class for
reads, retention and eviction for the whole drain.

---

## 6 · Failure and cancel semantics

The invariant: **footage is never lost and never becomes unreachable; a
half-drained class degrades to "readable from both", never to "invisible on
one".**

| Event | Result |
| --- | --- |
| Cancel during `draining` | Movers stop after the current hour. Everything not yet moved is readable at the source; everything moved is readable at the destination. The class stays split until the operator re-drains — which is a supported steady state, not a broken one. |
| Cancel before `repointing` | As today: nothing changed. |
| Cancel after `repointing` | Refused, as today (`storage-migration-coordinator.ts:158`) — the defaults already moved and cancellation cannot undo them. In non-blocking mode this is *no longer costly*, because after `repointing` the system is fully running. |
| Crash mid-drain | The mover's job state is RAM; the coordinator's is durable. Boot recovery restarts the same copy-if-absent move; verified copies at the target are adopted. Per D291 the durable index never names a location without the bytes. |
| Ledger point-read failure | The hour is refused, nothing is deleted, it is logged with `tags: { deviceId }` (D291). |
| **Destination fills** | **Handled.** The mover asks before it starts and again between hours, and refuses below the destination's `config.minFreePercent` (default 10 — the same default placement applies, `placement-service.ts:472`). The job fails with a message prefixed `destination full`, so `move.error` says which disk and by how much. Three deliberate non-refusals, each of which would otherwise block a legitimate drain: a **same-physical-root** move consumes no net space and is the one relocation that RELIEVES a full disk; **unreadable** free space is not "no room", and its fallback — ENOSPC — is already safe because D291 copies and verifies before any durable re-point, so it proceeds and logs; and `maxUsedGb` is a cap on occupied bytes arbitrated against the ledger, not a question one `statfs` answers. |

---

## 7 · The five classes

`storageMigration` addresses three; `storage.listLocationDeclarations` reports
five. The two missing ones are not symmetric with the others.

| Class | Declared in | Cardinality | Mover exists? |
| --- | --- | --- | --- |
| `recordings` | `packages/addon-pipeline/package.json` | multi | yes — `relocateFootage` |
| `recordingsLow` | `packages/addon-pipeline/package.json` | multi | yes — `relocateFootage` |
| `eventMedia` | `packages/addon-post-analysis/package.json` | multi | yes — `relocateMedia` |
| `backups` | `packages/system/package.json` | multi | **no — still none.** The planner accepts the class and REFUSES it with "No mover owns backups", instead of a Zod enum error or, worse, a migration that pauses every writer, repoints the default and moves nothing. |
| `galleryMedia` | `packages/addon-post-analysis/package.json` | **single** | **yes, now** — `relocateMedia({ mode: 'gallery' })`, the inverse selection of the `move` pass rather than a second engine. |

**`galleryMedia` is `cardinality: 'single'`**, which the orchestrator enforces
by refusing a second instance of the type
(`storage-orchestrator.service.ts:488`). So the two-locations-at-once transient
this whole design rests on is **not legal for this class**: it can only ever be
a stop-the-world move. That is fine — it is a few KB per enrolled sample — and
it must be said rather than discovered. It now is, twice: `plan()` REFUSES
`mode: 'nonBlocking'` for it outright, and every plan that includes it carries a
`blockingOnly` finding in its output. Its mover is `mode: 'gallery'` on the
existing media engine — the exact inverse of the `move` pass's exempt-owner-kind
skip, so the two selections can never drift apart.

It shares the media lane with `eventMedia` in the coordinator, and that is not
cosmetic: both go through the one `MediaRelocateEngine`, which refuses a second
running job. Arming them together would have failed the second one instantly.

**`galleryMedia` must never be co-located with recordings.** Its declaration is
the constraint verbatim: *"Deliberately NOT on the recordings volume: these
images survive every retention sweep, so they must also survive a footage wipe,
a quota eviction and a recordings disk swap."* A planner that accepted
`galleryMedia → the recordings volume` would let an operator destroy the
enrolment gallery on the next disk swap.

**Where that rule lives, and whether it can be enforced.** "Same device" *is*
computable, and this repo already computes it twice:
`physicalRootKey(root)` = `realpath` of the resolved path
(`packages/addon-pipeline/src/recorder/addon/eviction-domain.ts:32`), and the
orchestrator's own `getLocationDeviceKey` does the same
(`storage-orchestrator.addon.ts:634`). It collapses symlinks and bind mounts and
fails safe: an unstattable root falls back to the lexical path, which can only
ever *over*-partition. Two caveats to state rather than paper over: it is
path-identity, not `st_dev`, so two distinct directories on one filesystem are
**not** detected as the same device; and a location can carry a `nodeId`
(`storage-location.ts:61`), so the realpath must be taken **on that node** or
the answer is meaningless.

**Where it landed.** `StorageMigrationCoordinator.refuseGalleryOntoRecordingsVolume`
— a HARD refusal, and the only same-device case that is one, because its
consequence is silent and arrives months later: the gallery is wiped by the next
footage wipe, quota eviction or recordings disk swap, and nothing at that moment
points back at the migration. Everything else the check notices is a **named
finding in the plan output**, where an operator reads it:
`sharesDeviceWithSource` (the "move" is a row re-stamp and buys no redundancy)
and `deviceIdentityUnknown`.

**What it cannot detect, stated plainly rather than papered over:**

- **Two distinct directories on one filesystem.** The key is a `realpath`, so it
  catches a symlink, a bind mount and a literally-shared directory — and misses
  `/mnt/disk1/gallery` beside `/mnt/disk1/recordings`. That is not `st_dev`, and
  nothing in this change makes it so.
- **Any location carrying a `nodeId` other than this one**, whose realpath would
  have to be taken there. It answers `null`.

Both produce `deviceIdentityUnknown` rather than silence. A check that silently
never fires is worse than none.

Extending `plan`/`start` to five classes was otherwise mechanical — widening
`StorageMigrationClassSchema` and `StorageMigrationDestinationsSchema`. The
movers were the work, and `backups` still has none.

---

## 8 · Status

| Piece | State |
| --- | --- |
| Durable hour-row re-point in the footage mover (D291) | **implemented**, `packages/addon-pipeline/src/recorder/relocate-engine.ts`, `.../segment-hour-ledger.ts` |
| `mode: 'blocking' \| 'nonBlocking'` + `sealing`/`draining` phases | **implemented**, `packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts` |
| `eventMedia` NULL-row seal + the plan-time gate | **implemented** (D292), `packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts` |
| The gate's COUNT is answerable at 1.25 M rows | **implemented** (D312) — it timed out at 60 s on every call it ever made; see §8.2 |
| Destination-full handling in the drain | **implemented**, `packages/addon-pipeline/src/recorder/relocate-engine.ts` |
| Five-class planner + the `galleryMedia` co-location refusal | **implemented**, `storage-migration-coordinator.ts` |
| The drain's work list is the LEDGER, not the resident index | **implemented** (D295) |
| Mover progress on the job record + `storageMigration.movers` | **implemented** (D296) |
| `storageMigration.residue` + `storageMigration.drain` | **implemented** (D296) |
| A denominator for the media lane | **implemented** (D296) — `MediaRelocateEngine.countSelectable`, the same predicate the pass uses |
| The drain verifies against the SOURCE, and reconciles a row that disagrees | **implemented** (D307) — see §8.2 |

### 8.2 · The gate that could never open

`countUnstampedEventMedia` is what §4 makes the whole non-blocking `eventMedia`
cutover depend on, and **it timed out at exactly 60 s on the live hub every time
it ran, from the day it shipped**. It paged both collections at 200 rows per RPC
ordered by an unindexed `timestamp` — ~6 300 round trips over 1 254 576 rows,
each with its own sort.

It paged because the engine believed `WHERE locationId IS NULL` was not
expressible through the store's filter. It was expressible, and what it did was
worse than being refused: `where: { locationId: null }` compiled to
`"locationId" = ?` with NULL bound, which matches nothing under SQL
three-valued logic — a `0`, which is the single value this gate reads as
*"safe to cut over"*. `whereNot: { f: null }` carried the mirror defect and
selected exactly the rows it was asked to exclude.

D305 fixes the filter layer (`IS NULL` / `IS NOT NULL`, and `count` /
`aggregate` / `histogram` now REFUSE a predicate they cannot apply rather than
dropping it), adds an index on `locationId` to both collections through
`declareCollection`, and reshapes the answer: one existence probe (`limit: 1`,
one indexed seek) decides the gate, one indexed `COUNT(*)` decorates the
refusal, and `UnstampedEventMediaCount` is nullable so "not measurable" refuses
instead of reading as sealed. Two round trips per collection, whatever the
collection holds.

The consequence for §5's order: the plan gate now answers, so step (3) of the
inventory doc's sequence is done. Deploying it is still gated on the running
drain — the first declare builds an index over 1.25 M rows on the saturated
volume.

### 8.1 · The half nobody could watch, and the half nobody could resume

Two gaps outlived every item above, and both were found on the live hub rather
than in review (D296).

**The drain reported to Loki and to nothing else.** `filesMoved` / `filesTotal`
/ `bytesMoved` were on the engine's job and never left the addon; the operator
saw `phase: draining` for five hours. The fix is a fold, not a feed: the
coordinator's `waitForMoves` already fetches the whole `RelocateJob` every tick
to read `state`, so the counters ride that poll onto
`StorageMigrationMove.progress`. **No progress event** — a dropped event
(D8/D11) is indistinguishable from a stalled mover, which is the failure being
fixed. `storageMigration.movers` covers the case a fold cannot: a mover armed
directly against `recording.relocateFootage`, which has no job to fold into.

**And `start` correctly refused the one thing left to do.** Once a class is
repointed, `start` refuses its destination — there is nothing to repoint — but
the drain may still be unfinished. `storageMigration.drain` is the second verb:
its job begins at `phase: 'draining'` with `repointed: true`, mints no lease,
pauses nobody, and can never reach `repointing`. `start`'s refusal is therefore
untouched and still means what it meant. What makes the action honest rather
than hopeful is `storageMigration.residue` — a `SegmentHourLedger.census` per
non-default location, through the same `relocateScope` the mover uses — so a
class with an empty source produces no entry and no button. An *unmeasurable*
residue is still offered and labelled unknown: `null` is not zero (D295).

**Before any of it: `start` could not persist at all.** The coordinator's durable
job goes through `BaseAddon.state` → `ctx.settings`, and
`ConfigManager.createSettingsView` used to bind its backend when the view was
built. `storage-orchestrator` OWNS the `settings-store` door, so its own view is
always built first and got the sync-`ISettingsStore` backend — which stopped
being wired on hub-main the day `sqlite-settings` was isolated (D181). Every
`storageMigration.start` threw `SettingsStore not initialized` on its first
write, in EVERY mode, and `status` answered `null` because the same seam read
`{}` in silence. Fixed by D294; nothing in this design was reachable before it.

### 8.2 · The drain that died on one row, and what it revealed about the ledger

On 2026-08-30 the `recordingsLow` drain reached `state: failed` at 12 439 of
110 749 files with `relocate verify failed: … is 783801B, expected 274432B`. Both
files measured 783 801 B on the hub: the copy was faithful and the NAME was
wrong. `copyVerified` had been comparing the destination against `row.bytes` —
a number the ledger derives from the segment's own filename — and `fs.copyFile`
truncates and replaces, so that comparison can only ever fail when the LEDGER is
wrong. Worse, the copy was skipped only when the destination matched the
*recorded* size, so every restart re-copied and re-failed the same file: a fixed
point, not a stall.

The interesting half is the third defect. **A footage segment records its byte
count only in its name** (`segmentRelPath`), and `hourAggregate` re-derives the
hour row's `bytes` from those names — so a rescan cannot repair a wrong number,
and the ledger's per-location sums, which `StorageEvictableProvider` reads for
quota and disk-pressure eviction (`recorder/addon/index.ts:1007`), understate the
disk by the difference until the file is RENAMED. The drain is the one pass that
already holds the file, so it is where the reconcile belongs (D307). Magnitude,
from the single observed case: ~9 rows across the whole archive and tens of MB —
the accounting error is negligible, the dead drain was not.

The order matters. D291 is a prerequisite for the drain in **both** modes and is
worth deploying on its own: it also repairs the per-volume numbers in
`getStorageUsage`, which is the operator's only view of a migration's progress.
