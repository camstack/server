---
title: The motion still — why there are 1.14 M of them, the reclaim, and addressing media by artifact
last-verified: 2026-08-30
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-marker-policy.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-event-snapshot.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/media-reclaim.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/media-reclaim-actions.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/periodic-media-plan.ts
---

# The motion still

> **Starting point.** The inventory is
> [2026-08-30-event-media-inventory-and-debug-flag.md](./2026-08-30-event-media-inventory-and-debug-flag.md)
> and is not re-derived here: `pipeline-analytics:media` is 1 257 140 rows /
> 152.59 GB, of which **1 136 601 rows / 111.08 GB (73 %)** are one ~95 KiB
> JPEG per motion off→on transition, with one named consumer.
>
> **The operator's refinement, which reshaped the answer.** *"Dovremmo avere
> delle tracce sintetiche di motion semplice, se non avviene alcuna detection
> per molto tempo, ma così tante sono veramente tante."* [We should have simple synthetic motion tracks, if no detection happens for a long time, but this many is really a lot.] The fallback has a
> purpose and survives; what does not survive is one 95 KiB JPEG per edge. The
> condition he states — *a long stretch with no detection* — is not the
> condition the code tests, and that gap is the whole 111 GB.

---

## 1 · Why 16 656 transitions a day on one camera

**It is not the scene, and it is not a debounce that fails to settle. It is two
motion sources writing one shared edge variable with opposite conventions.**

### The measurement that decides it

Read from the live hub 2026-08-30, bounded windows, `filter.where`-scoped. The
`(deviceId, timestamp)` index makes the still timestamps themselves the record
of every transition, so the inter-arrival distribution is exact:

| camera | window | stills | gap p25 | **gap median** | gap p75 | tracks in window |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 103 porch | 1 h, 09:20 | 1 348 | 1 008 | **1 010** | 1 014 | 5 |
| 103 porch | 1 h, 21:20 | 2 218 | 1 008 | **1 010** | 1 012 | **0** |
| 1443 sala | 1 h, 09:20 | 3 227 | 1 007 | **1 010** | 1 012 | 62 |
| 1443 sala | 1 h, 21:20 | 1 383 | 1 008 | **1 011** | 2 018 | 0 |
| 102 parking | 1 h, 09:20 | 1 758 | 1 007 | **1 010** | 1 014 | 9 |
| 101 front door | 1 h, 09:20 | 159 | 1 007 | **1 011** | 1 460 | 8 |

**The median inter-transition gap is 1 010 ms on every camera** — p25 1 007,
p75 1 014, a 7 ms band — on a busy indoor camera and a dead-quiet outdoor one,
at 09:20 and at 21:20, with 62 tracks and with zero. A scene statistic cannot
be that. **1 010 ms is a clock.**

Corroborating counts over 24 h (`settingsStore.count`, one call each):

| camera | motion rows | of which `frameWidth: 0` (onboard shape) | stills | tracks | **stills per track** |
| --- | ---: | ---: | ---: | ---: | ---: |
| 103 porch | 27 884 | 27 713 (99.4 %) | 26 558 | 102 | 260 |
| 1443 sala | 47 397 | 44 365 (93.6 %) | 44 257 | 672 | 66 |
| 104 hall | 41 363 | 35 859 (86.7 %) | 38 625 | 1 322 | 29 |
| 637 cortile | 30 290 | 30 232 (99.8 %) | 29 135 | 55 | 530 |
| 3835 capanno | 20 967 | 20 902 (99.7 %) | 19 951 | 15 | 1 330 |
| **3829 garage** | 23 805 | 23 678 (99.5 %) | 22 827 | **5** | **4 565** |
| 101 front door | 6 040 | 5 822 (96.4 %) | 5 189 | 144 | 36 |

Two facts fall out. **Stills ≈ motion rows on every camera** (94–98 %), so
almost every motion row is a *rising edge*, not a heartbeat — on 103 at night,
2 218 of 2 269 rows. And the rows carry the **onboard** shape: `frameWidth: 0`,
`regions: []`, which only `handleOnboardMotion` writes
(`index.ts:9366` sets `frameWidth: 0` explicitly; the analyzer path carries the
real frame dimensions and a populated `regions`). A sample of 40 consecutive
rows on 103 at 21:00 confirms it directly — every one `n=0 fw=0 px=[]`, spaced
1 006–1 015 ms.

### The mechanism, traced

Three pieces, each correct alone:

1. **The provider emits a LEVEL KEEPALIVE, never an edge.** Reolink's
   `handleSimpleEvent` emits `MotionOnMotionChanged { detected: true }` on every
   firmware push (`reolink-camera.ts:9744` for bare motion, `:9796` for AI
   pushes) and **never emits `detected: false`** from that path at all.
   Hikvision does the same and says why in the code:
   > *"Emit the motion heartbeat on EVERY VMD tick, not just the rising edge …
   > Hikvision fires VMD ~every 1s during sustained motion, so re-emitting per
   > tick keeps the gate open — mirroring Reolink's per-push emit."*
   > (`hikvision-camera.ts:3434`)

   That ~1 Hz is deliberate: the pipeline-runner's phase machine is
   keepalive-driven, and each `detected:true` re-arms `motionCooldownMs`. **The
   1 010 ms is that keepalive.**

2. **The analyzer emits a per-frame SAMPLE.** `runMotionAnalysis`
   (`addon-pipeline/src/pipeline-runner/index.ts:4356`) emits
   `EventCategory.MotionAnalysis` on **every** analyzer pass at `motionFps`
   (default 4) with `detected = result.regions.length > 0` — a raw frame
   difference, no hysteresis, no minimum-off.

3. **Both handlers write ONE map.** `handleMotionAnalysis` (`index.ts:9277`)
   and `handleOnboardMotion` (`index.ts:9366`) share
   `lastMotionInsertByDevice`, and the second one's docblock asserts they
   cannot both be live:
   > *"both paths are mutually exclusive at the event-emit layer … so there's
   > no double-count risk."*

   **That claim is false by default.** `onboardMotionDrivesAnalyzer` defaults to
   `true` — an onboard push is exactly what *starts* the analyzer — so on every
   camera in this fleet both sources run at once.

The composition: each analyzer frame that sees no pixel change stamps
`{ detected: false }` into the shared map (`index.ts:9296`), and the next
provider keepalive reads `last.detected === false` and calls itself a rising
edge. `transitionedOn` is therefore true on ~95 % of inserts, and each one
writes a 95 KiB JPEG through `motion-event-snapshot.ts`. The camera is also
asked for a fresh frame each time, at the provider's beat.

That also explains the 1.29 M motion rows: they are the same edges.

### What fraction were genuinely quiet?

Half are not fallbacks at any reading. Over one hour: on 103, 502 of 1 348
stills landed while a track was open; on 1443, 1 616 of 3 227 — **37–50 % fire
while the detector is actively producing tracks**, which is the one case where
a motion still adds nothing at all. The rest fire during quiet, but at one per
second, which is not what "molto tempo" [a long time] means under any reading.

### What the correct edge looks like

A level keepalive has **no falling edge**. The falling edge must be synthesised
by *expiry of that source's own assertion*, never sampled from a different
source. Three rules, in increasing order of how much they change:

1. **Two sources, two states.** `lastMotionInsertByDevice` must be keyed
   `(deviceId, source)`. As it stands, one source's "I have nothing this frame"
   is read as the other's "motion ended".
2. **`detected: false` from a per-frame sampler is not "motion ended"** — it is
   "this sampler has nothing right now". Motion is ON while any source asserted
   it within a keepalive TTL (Hikvision already keeps its own,
   `MOTION_INACTIVE_AFTER_MS`).
3. **The unit is a VISIT, not an edge.** `transitionedOn` should mean
   `detected && now - lastAssertedAt >= visitGapMs`, with `visitGapMs` the
   runner's own definition of a visit ending (`motionCooldownMs`, 30 s
   default). Collapsing the observed timestamps at that gap gives 364/day on
   103 instead of 26 558 — a 73× reduction in motion ROWS as well as stills.

**Rules 1–3 are the real fix and they live in `handleMotionAnalysis` /
`handleOnboardMotion` and the provider contract — not in the media path.** They
are written down here and deliberately **not** implemented in this slice: they
change what a motion ROW means, which is the timeline's own vocabulary, and
that deserves its own change on its own evidence. What ships here is the media
gate, which is where the 111 GB is, and which is correct regardless of whether
the edge is ever fixed — because it is not a function of the edge.

---

## 2 · The gate — a marker per drought, not a still per edge

### Choosing N from the distribution

The operator's condition is *"se non avviene alcuna detection per molto tempo"* [if no detection happens for a long time].
That is measured against **detections**, not motion. Over 24 h across the ten
busiest cameras there were **1 445 detection-free stretches**:

| | median | p75 | **p90** | max |
| --- | ---: | ---: | ---: | ---: |
| fleet drought length | 42 s | 201 s | **770 s** | 50 335 s |

Per camera the spread is the whole point: 104 hall's median drought is 20 s,
3829 garage's is 12 191 s (3.4 h) and it was idle 100 % of the day. "Molto
tempo" is the tail, so **N = 900 s (15 min)**, just past the fleet p90. Nine
stretches in ten are shorter than one window and produce **no marker at all** —
correct, because they are not droughts.

**A drought longer than N produces one marker per N, not one and then
silence.** 3829's 3.4-hour median drought must not leave 3.4 hours blank; that
is the same complaint as the empty timeline, inverted. Sizing the repeating
rule against the observed droughts:

| N | markers/day, fleet | bytes/day | bytes/year |
| ---: | ---: | ---: | ---: |
| 600 s | 1 089 | 101 MB | 36 GB |
| **900 s** | **688** | **64 MB** | **22.8 GB** |
| 1 800 s | 302 | 28 MB | 10 GB |
| 3 600 s | 127 | 12 MB | 4.2 GB |

Against today's 92 400 stills/day ≈ **9.0 GB/day (3.3 TB/yr)**: at N = 900 s the
fallback survives in full at **1/134th** of the volume.

### The switch, and what it does and does not gate

`MediaSettingsSchema` (`media-settings.ts`) — the authority that already owns
per-camera media production (D62/D113), on the form that already exists
("Snapshots & media", `settings-schema.ts`):

```ts
debugMediaEnabled: z.boolean().default(false)
motionMarkerQuietMs: z.number().int().min(60_000).max(6 * 60 * 60_000).default(900_000)
```

`debugMediaEnabled` **replaces** `saveThumbnails` rather than sitting beside it
— two knobs overlapping on one function is the exact D62 failure, so one
absorbs the other. Three consequences, each deliberate:

- **The default flips.** `saveThumbnails` defaulted true; `debugMediaEnabled`
  defaults false. That flip *is* the operator's request and takes effect
  fleet-wide with no per-camera migration. A camera where he had explicitly set
  `saveThumbnails: false` lands on `debugMediaEnabled: false` — the same
  behaviour plus the motion gate.
- **The rolling `lastFrame` moves out from under it.** `saveThumbnails` gated
  the filmstrip *and* `lastFrame` (`periodic-media-plan.ts:94`). `lastFrame` is
  in the keep-set — trajectory end, the close-time promotion target, the
  audit's `MISSING_LASTFRAME` — and a *debug* switch may not take away a kept
  artefact. `planPeriodicMedia` now gates only `appendSnapshot`.
- **The quiet-period marker is NOT gated.** It is the operator's fallback and
  it is the healthy default state of every camera. Gating it off would blank
  the timeline on a quiet camera, which is the "disabled must never look like
  broken" failure D62 exists to prevent.

| output | gate before | gate now |
| --- | --- | --- |
| track filmstrip `snapshot` | `saveThumbnails` (default **true**) | `debugMediaEnabled` (default **false**) |
| rolling `lastFrame` | `saveThumbnails` | **never gated** |
| motion still, per edge | **none** | `debugMediaEnabled` |
| motion marker, per drought | did not exist | **never gated** (this is the fallback) |
| everything else in §2 of the inventory | unchanged | unchanged |

### Where the decision lives, and why it is in front of the fetch

`decideMotionStill` (`services/motion-marker-policy.ts`) is pure — no clock, no
store read, no await. It is called from **inside**
`MotionEventSnapshotCapturer.capture`, before `getSnapshot`:

> A gate that fetches a frame, downscales it and then discards it has stopped
> nothing. It has moved the cost from the disk to the camera and the CPU, and
> on a battery camera it still wakes it 92 400 times a day.

The spec asserts `getSnapshot` is never **called** — an assertion a
discard-after-fetch implementation fails.

Both clocks the decision reads are in-RAM mirrors refreshed off the event path
(D49): `lastTrackActivityMs` on the addon (already the `isMotionActive` half)
and `lastMarkerAt` on the capturer. A stale mirror **suppresses** a marker; it
never invents one, and there is no fallible read on the decision path.

The drop is reported, once per window: the marker's own log line carries
`suppressedSinceLastMarker`, `tags: { deviceId }`. At 92 400 suppressions a day
a line each would be the flood the logging rules exist to prevent; silence
would read as "never happened".

---

## 3 · The reclaim — `retention.mediaReclaim`

An operator-armed action (`retention/media-reclaim-actions.ts`, `auth: 'admin'`),
modelled on `retention.orphanAudit`, which earned the shape. **It ships armed
with nothing.**

**Selection.** Two named scopes, not a free `(ownerKind, kind)` pair — a caller
who could name an arbitrary pair could name `keyFrame`:

- `motion-still` — `ownerKind: 'event', kind: 'snapshot'` (the 111 GB);
- `track-filmstrip` — `ownerKind: 'track', kind: 'snapshot'` (3.4 GB).

**Paging.** Device-scoped and timestamp-cursored via
`MediaStore.pageByKindForDevice`, because `(deviceId, timestamp)` is
`idx_media_device_ts` and there is **no index on `kind`** — a fleet-wide
`kind = 'snapshot'` predicate table-scans 1.26 M rows on hub-main's single
synchronous SQLite thread. `breathe()` yields the macrotask queue between pages
for the same reason.

**Pacing.** `pace(bytes / throttleBytesPerSec)` after each page's deletes,
default 2 MB/s against a volume that sustains ~4. Four independent ceilings:
rows examined per camera, rows reclaimed per camera, bytes per run, wall-clock
budget.

**Resumability.** Each `(device, scope)` returns `nextCursor`, and the cursor
only ever advances past a row the pass has **finished with**. A run cut short
leaves rows and blobs consistent and says where it stopped (`stoppedBy`,
`nextCursor` per device). `complete` is true only when every pair reported
`exhausted`.

### What it refuses

Four refusals, each with a disarm test on a fixture whose two outcomes differ
by a *count*:

1. **A row whose blob delete fails, or whose blob is still there afterwards, is
   not forgotten.** `MediaStore.deleteConfirmed` is the only delete path used:
   unlink → re-probe `storage.exists` → *then* delete the row, and throw
   otherwise. Every other delete on `MediaStore` swallows the unlink error
   (`deleteByKeyUnchecked`, `deleteForOwnerUnchecked`), and `fs.rm(force:true)`
   cannot tell "removed it" from "there was nothing there" — tolerable for a
   cascade whose whole subtree is going, and the orphan factory for a 1.14 M-row
   pass. The pass counts it `refused`, keeps the row, does not advance the
   cursor past it, and ends that camera's scope.
2. **A selected row whose owner is not a motion event is not deleted.** The
   selection shape is not the guarantee: nothing structurally stops another
   writer landing an event-owned snapshot on an object or audio row. The
   guarantee is a per-page indexed `whereIn` against the motion-event table
   (`EventStore.existingMotionEventIds`) — cheap where the mistake is not.
3. **A pinned track's filmstrip is never deleted.** `TrackStore.pinnedTrackIds`
   returns `retrainStatus: 'staging'` ∪ `favourited: true` ∪ **the in-RAM
   active tracks**: a running track has no persisted row, so an unanswerable id
   is treated as *protected*. Unknown means protected here — the inverse of
   `existingTrackIds`, where unknown means alive, and the same safe direction.
4. **A liveness probe that throws abandons the camera.** It is never read as
   "nothing is protected".

**Reporting.** One `media reclaim window` line per camera per scope with
`tags: { deviceId }` — examined / eligible / reclaimed / bytes / held /
unresolved / withinGrace / refused / stoppedBy / nextCursor — never a line per
row. On a `reclaim` run that removed anything, one ops-log row
(`op: 'prune', reason: 'operator'`) with real rows and bytes.

**Arming it** (the operator's call, after the current drain finishes — the disk
is the contended resource). The pass is tens of minutes; it is a **detached
cap method**, same shape as `rebuildObjectEmbeddings`. The start returns
`{ started, alreadyRunning }` immediately. Progress is `getMediaReclaimStatus`.
Awaiting the walk is a timeout, not a verdict.

```
pipelineAnalytics.reclaimDebugMedia { mode: 'reclaim', restart: true }
pipelineAnalytics.getMediaReclaimStatus {}
```

The settings / `addons.custom` door is the same start: `retention.mediaReclaim`
returns `{ started }` and `retention.mediaReclaimStatus` is the poll. Dry-run
unless `mode: 'reclaim'`. Repeat until `complete: true`. Expect ~1.14 M rows /
111 GB across many runs at 2 MB/s.

---

## 4 · Proposal — media addressed by the artifact it belongs to

This is the part that stops it recurring, and it is a proposal, not this slice.

### The defect, stated precisely

A motion still is written **unconditionally**, and its only consumer reaches it
as an unnamed catch-all. Verified 2026-08-30, every reader:

| reader | how it addresses the still |
| --- | --- |
| `event-thumbnail-resolver.ts:20` | `files.find(crop) ?? files.find(fullFrameBoxed) ?? **files[0]**` |
| `videoclips-provider.ts:173` → `media-store.ts:721` | `ownersWithMedia(ownerKind, ownerIds, deviceId)` — **presence only, `kind` is never in the query** |
| `videoclip-visits.ts:139` | the same `vouched` set, again by owner presence |

**Not one reader names `kind: 'snapshot'` on an event owner.** The 111 GB
exists to satisfy a boolean — *does this event own any media* — and is reached
positionally. That is the shape that makes overproduction invisible: nothing
can be counted against a name it does not have, and a producer with no named
consumer looks exactly like a producer with one.

### The rule

> **Media is addressed by the ARTIFACT it belongs to, and an artifact declares
> the media kinds it is composed of. A write whose kind is not named by its
> artifact's composition is refused, and a read never reaches media
> positionally.**

Concretely, three changes that can land independently:

**(a) Name the read.** `ownersWithMedia` takes the `kind` it is vouching for,
and `pickEventOwnedMedia`'s `files[0]` becomes
`files.find(f => f.kind === 'snapshot')`. Cheap, purely local, and it converts
"this event has bytes" into "this event has the artifact the clip tile needs" —
which is the question the clip licence was always asking. **This is small and
obviously right; it is the one piece worth doing next.**

**(b) Declare the composition.** One table, beside `MediaFileKindEnum`, mapping
each `(ownerKind, artifact)` to the kinds it may own and, for each, whether it
is `required` (a later pass depends on it — D58) or `derived` (regenerable, and
therefore evictable on its own). `MediaStore.put` refuses an undeclared pair.
A guard walks the table and fails the build on a kind with **no named reader**,
which is exactly the check that would have caught this population on the day it
shipped — and would today still flag `fullFrameBoxed` under `ownerKind: 'group'`
(a live write into a feature that is gated off, publishing nothing).

**(c) Derive under the source's key.** This is the reference NVR lesson and D295
read together: *the ledger is the archive's authority; the RAM index answers
only about residency*, and *a derived artefact should be addressed under the
same key as the source it derives from, so the retention decision that removes
the source removes it too.* Today a thumbnail, its small variant, its keyFrame
and its keyFrameSmall are four independent rows with four independent
lifetimes, each reachable only through the owner index. Under (c) a derived row
carries `derivedFrom: <sourceKey>` and is removed by the same statement that
removes its source. **Every derived cache with an independent lifetime is a
future orphan sweep**, and this repo has run three of them this week.

### What this would have prevented

The motion still fails (a) — no reader names it. It fails (b) — nothing
declares that a motion event is *composed of* a snapshot, so the write was
never checked against anything. It does not fail (c): it has no source, which
is itself the tell. **A media population with no artifact and no named reader
should not be writable at all**, and that is the rule this proposal is for.

## What I could not determine

- Whether fixing the edge (§1, rules 1–3) changes the drought distribution the
  N was chosen from. It should not — the drought measure is over *tracks*, not
  motion — but N is a setting and the honest answer is to re-measure after.
- Whether any external consumer (HomeKit/HA export, third-party webhook) reads
  motion stills through the data plane. Nothing in this repo does beyond the
  clip tile, but artifact-plane URLs are HMAC-public once minted.
- The steady-state follow-recordings window once quota eviction starts
  advancing the oldest segment — inherited unresolved from the inventory doc.
