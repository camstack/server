# Migrating `recordingsLow` and `eventMedia` to SSD — what the flow covers and what it does not

> Status: analysis of 2026-08-26. **Live cutover 29–31/08, occupancy 01/09.**
> `recordingsLow:ssd` and `eventMedia:ssd` are the write locations. The defaults
> on the root shared with the high ones were deleted after
> [D327](../decisions/adr-0327-occupancy-of-a-shared-root-is-the-class-subtree.md).
> Toshiba HDD `recordings-2` reformatted as btrfs on 01/09; `recordings:default`
> stays `/recordings` (high/mid).

> Original status: operator request before moving
> `low` and `events` from the recordings disk to an SSD, leaving `high`
> where it is. Read from the code, not from the documentation. Read it before touching
> `packages/system/src/builtins/storage-orchestrator/**`,
> `packages/addon-pipeline/src/recorder/relocate-engine.ts` or
> `packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts`.

## Why

The recordings live on `/mnt/disks/recordings-2`, i.e. `sdl1`, a **TOSHIBA
MQ04UBD200: 2.5", 5400 rpm, USB**. Measured on 2026-08-26 while the operator
was scrubbing:

    sdl    r_await 285.25 ms   w_await 466.44 ms   %util 109.67   at 64 kB/s
    sdb    w_await   0.89 ms                       %util   3.03   (SSD, 1.2 TB free)

The 285 ms are the same `readMsP50 = 301` that the `scrub-feeder:drag-end` census
reports: **the feeder's read is the disk wait.** The cause is not
rotation but head parking — `APM_level = 128` and
`Load_Cycle_Count = 573,947` out of ~600,000 specified. See
[`2026-08-26-scrub-architecture.md`](./2026-08-26-scrub-architecture.md).

> **UPDATE 2026-08-29 — read first
> [`2026-08-29-non-blocking-storage-migration.md`](./2026-08-29-non-blocking-storage-migration.md).**
> Two statements below no longer hold. (1) *"The path is the data, there is no
> table to rewrite"*: D287 made the `SegmentHourLedger` the first
> step of hydrating a closed hour, so a drain MUST re-point the
> durable hourly row — see D291. (2) The sequence without a pause that uses
> `config.readOnly` on the source removes those bytes from the disk's eviction
> domain (`storage-evictable-provider.ts:100`), and today `recordings` and
> `recordingsLow` share `/recordings`: re-pointing the default is sufficient
> and does not have that effect.

## What the flow COVERS (verified in the code)

**A real coordinated migration exists**, not a manual operation:
`storageMigration.plan / start / status / cancel` (cap `storage-migration`,
4 methods, admin), on top of
`storage-orchestrator/storage-migration-coordinator.ts` — a durable state machine
with phases, recovery at boot and lease fencing.

### The footage has no DB references to migrate

`recorder/recording-index.ts` declares it and the code respects it:

> *"In-memory footage index… The framework `storage` cap's `list()` is the
> ground truth… Because every row is derived from a segment path (which encodes
> start/dur/bytes), the index can never drift from disk. **No SQLite, no
> persistence of its own.**"*

The path **is** the data. There is no table to rewrite, and a crash halfway
heals itself because the index is rebuilt from disk at the next hydrate.

The mover (`relocate-engine.ts`, `moveFile` + `moveSegment`) does:
copy-if-absent → verify the size → delete the source → re-point the row
in RAM. The source is deleted **before** the re-point, but the window is
harmless: on restart `fs.stat(dst)` finds the copy with the right size,
skips the copy, `fs.rm(src, { force: true })` tolerates the already-absent source, and
the re-point happens. A source that vanished for other reasons (eviction, ENOSPC)
is removed from the index and skipped — a ghost file does not abort the drain.

### The DB references of the event media ARE handled, and in the safe order

`media-relocate-engine.ts` does the opposite of the recorder, on purpose:

> *"read blob from its CURRENT location → write to the target → stamp
> `row.locationId` → delete the old blob. The row update lands between the two
> blob operations, so a crash leaves the row pointing at a location that still
> holds valid bytes."*

The row is updated **before** deleting the source: a crash leaves at
most an orphan blob — recoverable garbage — never a dead reference. Rows
already at the destination are skipped, so a restart resumes.

### The rest of the chain

- **After the re-point** the recorder does `refreshLocations()`,
  `calendar.invalidateAll()` and `resetPlacementPlan()`, with this comment:
  *"restoring a cached plan here would re-point writers at the location the
  operator just migrated AWAY from."*
- **Cancellation is refused** once `repointed` is true: it cannot be
  undone safely, and the code says so instead of trying.
- **On coordinator restart** the persisted leases are not trusted: it mints
  a new one, re-drains every participant, and only then continues.

## What the flow does NOT cover — the four points that matter

### 1. The move happens INSIDE the pause

The state machine is:

    planning → pausing → **moving** → verifying → repointing → refreshing → resuming

`pauseParticipants` calls `pauseForStorageMigration` on the recorder, which does
`this.controller.pause()` — **the recorder stops entirely**, and stays stopped
for the whole byte copy.

On this disk that is the dominant problem. Empirical metric collected the same
day: a metadata-only `du` on ONE device took **3 minutes and 57
seconds**, and the scan of the 14 `low` ones was at 3/14 after half an hour. A full
copy of `low` + `events` with recording stopped is on the order of HOURS,
not minutes.

### 2. The footage has a no-pause path; the event media does not

| | background path | pause? | granularity |
| --- | --- | --- | --- |
| footage (`high`/`low`) | `recording.relocateFootage` | **no** | `deviceId`, `profiles`, `sinceMs`, `throttleMbps` |
| `eventMedia` | `pipelineAnalytics.relocateMedia` | **no** | `toLocationId`, `throttleMbps` (cluster-level: no `deviceId`) |

`recording.relocateFootage` is a public admin mutation, and is described as
*"a background chore that must never starve live writers"*.

**Corrected on 2026-08-26 (Track A implemented).** When this analysis was
written, on the analytics side only the participant primitive existed
(`StorageMigrationMediaMoveInput`), which requires a `leaseId` and is therefore
actionable only by the coordinator, inside the pause. Now `pipelineAnalytics.relocateMedia`
exposes the same engine WITHOUT a lease. The difference that remains is granularity: the
footage moves per camera and per profile, the event media at cluster level.

### 3. `/mnt/mixed` is not mounted in the container

The current mounts:

    /mnt/disks/recordings-2                        -> /recordings
    /mnt/cache/appdata/camstack                    -> /data
    /mnt/mixed/camstack/addons-data/sqlite-settings -> /data/addons-data/sqlite-settings

Of the SSD **only** the `sqlite-settings` subfolder gets in. A new location on
`mixed` requires a new bind mount, hence **recreating the container** and
modifying the Unraid template. Caution: the host's template contains
`CAMSTACK_JWT_SECRET`, `CAMSTACK_ADMIN_PASS` and the media paths — it must be edited,
not overwritten with the repo's one.

### 4. The three classes share the same `basePath` today

    recordingsLow:default  ->  /recordings
    eventMedia:default     ->  /recordings
    recordings:default     ->  /recordings   (maxUsedGb: 1000)

Practical consequence: `storageEvictable.getEvictableUsage` answers **1074 GB for
all three**, because it measures the `basePath`, not the profile. There is no API that
can say how much the `low` ones weigh alone — the only way is the filesystem, which
on this disk costs the hours mentioned above.

## The ordering mistake not to make

Sequence proposed by the operator: *add the volume → add the location →
deactivate the previous one and activate the new one → do the migration*. The third step
breaks it.

`plan()` derives the SOURCE from the current default:

```ts
const source = this.deps.locations.getDefaultLocation(storageClass)
…
if (source.id === target.id) {
  throw new Error(`Storage location "${targetId}" is already the "${storageClass}" default`)
}
```

If the new location is already the default, `plan` finds source and destination
equal and **throws**. The migration does not start and the old data stay orphaned on the
starting disk, with nobody knowing any more that they are there.

The default switch **is already inside the migration**, in the `repointing` phase
(`setDefaultLocations(targets)`), after the bytes have been moved and
verified. It must not be anticipated.

Two other constraints that `plan()` imposes and that are better known beforehand:

- **`target.type` must equal the class.** So TWO new locations are needed,
  one `type: 'recordingsLow'` and one `type: 'eventMedia'` — even if
  they point to the same path, exactly as today the three defaults share
  `/recordings`.
- **Do not create the location with `isDefault: true`**, for the same reason as
  step 3.

## How to work around the pause (the path the system is designed to take)

The global pause serves the COORDINATOR, not the move. For the footage
there is a path that stops nothing, and it is the one that `relocate-engine.ts`
describes in its header: *"mark the old location read-only (Phase 2), then
relocate its footage here, then delete the location."*

Why it works, verified:

- **The planner does not follow the default.** `placement-planner.ts` is weighted
  on capacity: it assigns each (camera, profile) pair to the location with the most
  `headroomBytes`, and is sticky on purpose — *"Nothing moves until a location
  is off its target share by more than the hysteresis band, or must be **vacated
  outright (read-only, gone, or out of headroom)**."*
- **`config.readOnly` is the lever.** `roots.ts` calls it *"Operator drain flag: the
  location is still READ"* — it stops receiving writes and keeps serving
  reads.
- **Reads survive the switch.** `hydrateDeviceFromStorage` walks
  `for (const [root, aliases] of aliasesByRoot(locations))`: ALL the locations,
  not only the default. The old footage stays visible where it is.
- **The cost is declared and local.** *"each move costs a writer restart and a
  recording gap"* — a few seconds PER CAMERA while the plan is re-derived, not
  hours of global downtime.

Sequence without a pause, for `recordingsLow`:

1. Mount + container recreation.
2. `storage.upsertLocation`: new location `type: 'recordingsLow'` on the SSD
   path. **Without `isDefault`** — it is just a second candidate with plenty of headroom.
3. `storage.upsertLocation` on the OLD one with `config.readOnly: true`.
4. The planner empties it by itself: each camera-profile moves to the SSD at the
   next pass, with its gap of seconds.
5. Optional, in the background and without a pause:
   `recording.relocateFootage { fromLocationId, toLocationId, footageClass: 'recordingsLow' }`
   to carry away the old bytes too.

**`eventMedia` has no planner** — it is a single default, and its only move
primitive requires the coordinator's lease. So for the events the options are two:
suffer the pause proportional to their size, or move only the default and leave
the old rows where they are. The rows carry `locationId`, so they keep resolving on the old disk: only the
benefit on the archive is lost, not the archive.

## Recommended sequence

The order is the content: doing point 1 last makes all the others slow.

1. **Remove the head parking BEFORE anything else.** `hdparm -B 254
   /dev/sdl`, made persistent by User Scripts (the plugin is installed) on *At
   First Array Start Only*. Without this every following step runs at 285 ms per
   I/O. Warning: many USB→SATA bridges ignore APM, and a touchy bridge can
   cause a bus reset — on an NVR that is recording it is a gap of a few
   seconds.
2. **Add the SSD's bind mount and recreate the container.**
3. **Create the new locations** (`storage.upsertLocation`) on the SSD path.
4. **Drain `low` in the background**, camera by camera, with
   `recording.relocateFootage { footageClass: 'recordingsLow', deviceId, toLocationId }`.
   **No recording pause.** Repeat until little remains.
5. **Only then** `storageMigration.start` for `recordingsLow`: the bulk is already
   moved, so the pause is short.
6. **`eventMedia` in a SEPARATE job.** It has no background path, so its
   pause is proportional to its whole size — keeping it distinct from that
   of the `low` ones means two short stops instead of one long one.

## What remains unknown

- **How much the `low` ones really weigh.** On the only device broken down in full (1438):
  `low` 45.8 MB · `high` 569 MB · `events` 848 MB, i.e. `low` is **3.1%**.
  If the ratio holds on the 1.2 TB it is ~35–40 GB, but it is a sample of one device
  out of 26 and the heaviest ones (104, 101, 102) had not yet been measured.
- **Whether `relocateFootage` sustains a long drain** on a disk that already has
  `aqu-sz 2.54`. The default throttle is 40 MB/s, but the limit here will be the
  disk, not the throttle.
- **Whether the USB bridge accepts the APM command.** It is the only thing that makes the rest
  practicable, and the first to try.

## An observation worth more than the migration

Moving `low` and `events` removes the scrub **read** from the sick disk, but
`high` stays there and recording keeps hammering it — and on device 1438
`events` alone was 58% of the footprint. That is exactly what is needed for
scrub, and it is not a solution for the disk. The head parking is the bug;
a 2.5" USB 5400 rpm under an NVR that writes 24/7 is the debt.
