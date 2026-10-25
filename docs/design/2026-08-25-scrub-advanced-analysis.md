---
title: Scrub — where the time really goes, and the ordered plan
covers:
  - packages/addon-pipeline/src/stream-broker/recorded/**
  - packages/addon-pipeline/src/recorder/**
status: analysis + plan
date: 2026-08-25
---

# Scrub — where the time really goes, and the ordered plan

> Status: measured on the LIVE hub, 2026-08-25, after the audio-deadline fix
> (addon-pipeline 1.2.120, deployed 07:58 — verified in the loaded
> dist by the `seek-audio-dropped` string). Every number below carries its
> source. Companion docs, not restated:
> [`2026-07-29-recorded-read-path-strategy.md`](2026-07-29-recorded-read-path-strategy.md)
> (discovery/location/delivery layering),
> [`2026-08-07-viewer-scrub-drag-mapping-spec.md`](2026-08-07-viewer-scrub-drag-mapping-spec.md)
> and [`2026-08-07-viewer-scrub-instrumentation-spec.md`](2026-08-07-viewer-scrub-instrumentation-spec.md)
> (the UNSHIPPED viewer half — see §4).

## 0. The path, gesture → pixel

Viewer pan handler → throttled `scrubTo` (25/s, `camstack/src/recording/playback-machine.ts`)
→ WebRTC control datachannel → `RecordedFeeder` in the stream-broker runner
(latest-wins + 33 ms coalesce) → `recording.locateSegment` /
`recording.readSegmentBytes` over UDS RPC through hub-main to the recorder
runner → disk → off-thread mp4box demux (worker) → AU push over the
WebRTC session → browser native decode → paint → `scrubAck` (credit 2).

## 1. Where the time goes (measured)

Two sources agree: (a) the 48 h drag census (31 `scrub-feeder:drag-end` lines,
25 with ticks>0, 2026-08-23→25), (b) a 24-target bench over the REAL tRPC read
path (cold targets 16–40 h old across 6 cameras, then warm repeats —
`scrub-read-bench.mjs`, this session).

| Leg | p50 | p90/p95 | max | Source |
| --- | --- | --- | --- | --- |
| locate (RAM index) | 6–9 ms | 300 ms | 618 ms | census `locateMsMax`, bench `locMs` |
| **read, COLD** (disk) | **531 ms** | **1.4–2 s** | **9.2 s** | bench `readMs`; census `readMsMax` p90 2 042 ms |
| read, WARM (page cache, same wire) | 28 ms | 110 ms | 110 ms | bench `warmMs` |
| demux (off-thread) | 2 ms | 5 ms | 202 ms | census `demuxMsMax` |
| client leg (push→ack) | 25 ms | 37 ms | 1.1 s* | census `ackMsMax` (*outlier during park) |
| per-drag first frame | 290 ms | 1.3 s | 3.8 s | census `firstPushMs` |
| audio wait on seek commit | — | — | was 8 s, now ≤1.5 s |; re-measure below |

Cold vs warm on the SAME wire and bytes is the decomposition: transport +
serialization + demux + RPC ≈ 25–40 ms for a ~150 KB low segment; everything
else is the disk. `tickMsP50` tracks `readMsP50` almost exactly (182 vs
151 ms): **a drag tick costs what the disk read costs.**

Cold/warm distinction: with the ±15 min warm window filled, ticks run at
2–6 ms (`readMs=2`, cache hits). But the warm never runs (§4), so nearly every
real tick is cold.

## 2. The bottleneck, named: the disk — and precisely which disk

All recordings, low, high AND event media live on ONE device:
`/mnt/disks/recordings-2` → `/dev/sdl1` → **Toshiba MQ04UBD200 — a 2 TB 2.5"
5400 rpm SMR laptop drive on a USB bridge**, btrfs. Not the parity array, not
FUSE — the premise "recordings sit on the parity array" is FALSE; it is worse.

Steady-state load (iostat, quiet vs normal):

- writes: 45–65 w/s, 7–12 MB/s — ~10 continuously recording cameras × 2
  profiles (high Σ≈56 Mbps measured from segment filenames) + event media;
- reads: 40–55 r/s, up to 10 MB/s in ~200 KB requests whenever an event
  capture or export runs (verified: a recorder export ffmpeg reading 2.4 MB/s
  was live during measurement — this is the NORMAL condition, not an anomaly);
- **%util 60 % from writes alone, 99–100 % whenever anything reads**;
  r_await 20–30 ms; **f_await 789 ms** (a flush costs ~0.8 s on this drive).

Why a 3-IO read costs 500 ms: not fragmentation (`filefrag`: every sampled
segment, low and high, is 1 extent) and not file size — it is queueing on a
saturated 5400 rpm SMR spindle plus btrfs commit/flush stalls. The 9.2 s
outlier is a read that landed behind a flush/SMR-GC window.

What the bottleneck is NOT, with the number that excludes it:

- not the transport/RPC hops (28 ms warm, whole path);
- not the demux (p50 2 ms since the off-thread worker; 99.8 % JS path);
- not the client (ack p50 25 ms; browser decode keeps up);
- not discovery (locate p50 6–9 ms out of the RAM index);
- not the fMP4 format or GOP length: jump mode pushes ONE keyframe; the mfra
  GOP-range read exists; the whole-segment `low` read (~100–300 KB) is the
  RIGHT unit on a spindle and leaves 10 s of AUs in cache
  (`SCRUB_WHOLE_SEGMENT_PROFILE`, census `gopReads=0 wholeReads=135` is by
  design, not a bug.)

Capacity context: 1.3 TB/1.9 TB used ≈ 2.5–3 days of retention
(`recordings:default` maxUsedGb=1000); high Σ≈600 GB/day.

## 3. The one-line structural fix the codebase already contains

`roots.ts` routes the `low` profile to a **`recordingsLow` storage location**
when one is declared (`preferType = profile === 'low' ? 'recordingsLow' :
'recordings'`). The hub HAS that location — `recordingsLow:default` — but its
`basePath` is `/recordings`, the same USB spindle. Every mechanism a low-tier
split needs already exists and is tested: location types + placement routing
(`roots.ts`), per-(camera, profile) relocation with copy→verify→delete→
re-point and resume (`relocate-engine.ts`, D116), per-physical-root eviction
domains, `maxUsedGb` caps, aliased-root hydration attribution.

Sizing on this fleet: measured low bitrates sum to ≈3.3 Mbps ≈ **36 GB/day for
every continuous camera together** — SSD-sized, while high (600 GB/day) is not.

Candidate targets (operator's call):

| Target | Free | Container change | Notes |
| --- | --- | --- | --- |
| `/data/recordings-low` (hub NVMe, `/mnt/cache`) | 144 G | **none** — already mounted | ~3–4 days of low at a `maxUsedGb` ~100–120 bound; shares the appdata/DB NVMe (write load added: 0.4 MB/s — trivial) |
| `/mnt/mixed` (Samsung 870 QVO 2 TB SATA) | 1.2 T | new bind mount → container recreate | ~1 month of low; shared with the reference NVR assets |
| P3-512 (`/dev/sdc1`, btrfs, unmounted) | ~476 G | mount + bind → recreate | dedicated; needs operator to mount |

Expected effect, from the measured decomposition: cold read 531 ms → **~5–15 ms**
(NVMe/SATA SSD random read of 200 KB), so a cold scrub tick ≈ locate 9 +
read 15 + demux 2 + client 25 ≈ **~50 ms p50, p95 under 200 ms** — and the
prefetch/warm machinery stops being suppressed (`SCRUB_SLOW_READ_MS=600`
median gate lifts by itself), so the cache starts doing its job. Old low
footage stays readable on the spindle until relocated or evicted; the relocate
engine can drain the recent window to the SSD at a throttled 40 MB/s.

## 4. Velocity adaptation — the half that exists is starved by the half that doesn't

The operator's explicit requirement is *adapt to drag velocity: fluid when
fast, precise when slow*. The server half is built and live: jump vs sweep
(±4 s window, both directions), whole-segment demux cache (48 MB/session,
±15 min), directional prefetch, ack-credit pacing, `timelineWarm` bridge. The
CLIENT half — the two 2026-08-07 viewer specs — **was never shipped**, and the
live census proves the cost:

- `mapFine=0 mapCoarse=0 mapUnknown=167/167` — the viewer sends no hint;
  `velPxPerS` null on every drag (`scrubTo(epochMs)` in
  `camstack/src/recording/playback-machine.ts` still has no second argument);
- **282 jumps vs 3 sweeps in 48 h** — at default zoom ~8.8 s/px, every careful
  3 px move is still a ~26 s jump, outside the 4 s sweep window, so the
  continuous-flow path never engages (the 48 h baseline the spec set out to
  beat — 102:3 — is unchanged);
- `recorded:warmed` count over 20 h: **0** — `timelineWarm` is never called;
  every first drag pays the cold chain (`firstPushMs` p90 1.3 s);
- consequence: `coverCache` 22 vs `coverMiss` 144 (13 % hit), prefetch 134
  reads → 18 hits, wasted on a saturated spindle.

No amount of server-side work changes fast-drag behaviour while the client
maps every pixel to absolute time and stays silent about velocity. The specs
are written to be ported verbatim (`embed/src/scrub/drag-mapping.ts` is pure
TS with a passing spec); this is viewer work, currently blocked only by the
in-flight viewer ship in the shared tree.

## 5. The storage format, honestly evaluated

The operator put the format on the table. Verdict: **no format migration is
justified by any measured cost.** Per alternative, with this fleet's numbers:

- **Move `low` (+ optionally event media) to SSD** — not a format change but
  the placement change §3; ~36 GB/day; gain measured-adjacent (531→~15 ms per
  cold read); zero effect on the recording write path beyond routing NEW
  segments; reversible by relocating back. **Do this first.**
- **Record `low` on the ~15 cameras that lack it.** 3628/3629/3825/… record
  high-only; scrub there falls back through `pickProfileWithFootage` to `high`
  segments (5–12 MB — above `SCRUB_WHOLE_SEGMENT_MAX_BYTES`, so per-GOP range
  reads of 2–4 MB on the spindle). Enabling the substream recording is
  config + camera capability, adds ~exactly what `low` costs (~100–500 kbps
  each), and is the difference between scrub working and not on those cameras.
- **Shorter GOP** (camera-side I-frame interval on the substream, 4 s → 1–2 s):
  finer jump granularity and cheaper paused-precision (fewer delta frames to
  decode to reach an instant). Costs ~+20–40 % on `low` bitrate (still
  negligible), zero migration (applies to new footage), zero CamStack code.
  Worth doing AFTER the SSD move if paused stepping still feels coarse; it
  does nothing for the current latency, which is I/O-bound, not decode-bound.
- **Shorter segments** — rejected: more files and more metadata churn on the
  component that is already the bottleneck; the mfra GOP-range read already
  provides sub-segment granularity without it.
- **A second dedicated scrub rendition** — already exists: it is `low`. A
  third, smaller one would buy bytes we do not pay for (bytes are 28 ms warm;
  the cost is the seek).
- **Thumbnail strips / sprite packs** — tried, produced zero served frames in
  production, deleted (D41 amendment). The failure mode was structural
  (velocity tier never engaged — the same unshipped client mapping of §4).
  Revisit ONLY if, with SSD + the viewer specs live, a full-day fling still
  starves; the strip would then ride the same velocity signal the specs add.
- **Persisted keyframe/index sidecars** — rejected before
  (2026-07-29 doc §Rejected) and nothing changed: locate answers in 6–9 ms
  from RAM; a sidecar duplicates a drift-free index into files that can drift.
- **Different container (TS/MKV/…)** — no measured cost is attributable to
  fMP4: demux 2 ms, one-extent files, byte-range-addressable GOPs with an
  in-file index (`mfra`) the recorder already exploits. A migration would be
  irreversible for existing footage and buy nothing measured.

## 6. What touches the RECORDING, and how the risk is bounded

The recording write path is the one place an error loses footage that never
comes back. Of everything above:

- §3 changes WHERE new low segments are placed (existing routing, one
  location repoint) and WHERE finalized files are moved (relocate engine:
  throttled copy → size-verify → delete source → index re-point, resumable).
  Staging: (1) repoint `recordingsLow` and verify new segments land on the SSD
  (`recorded:*` census + `ls` the new root) while old footage stays readable
  in place; (2) only then arm relocation of the recent window; (3) eviction
  bounds via `maxUsedGb` BEFORE first write. Rollback = repoint back +
  relocate back. High-profile recording is untouched throughout.
- §4 (viewer) and §5 GOP/substream items never touch the recorder.
- Nothing proposed is irreversible except normal retention eviction.

## 7. Ordered plan

1. **P0 — repoint `recordingsLow` to an SSD root and enable `low` everywhere.**
   Highest measured leverage (the entire 500 ms–9 s tail is this disk), no
   code, existing machinery, staged + reversible (§6). Operator decisions
   needed: which SSD (table §3) and the `maxUsedGb` bound. Verify: census
   `readMsP50` ≤ 30 ms cold, `firstPushMs` p90 < 300 ms, prefetch hit rate up,
   `prefetchSuppressed` → 0.
2. **P1 — ship the two 2026-08-07 viewer specs** (drag mapping + hint +
   `timelineWarm` + `scrub:drag-timeline`). This is the "adapt to velocity"
   requirement itself. Blocked on the in-flight viewer ship; nothing server-
   side is missing. Verify: `mapFine>0`, sweeps ≫ jumps on careful drags,
   `recorded:warmed` present on timeline open, and the client-leg numbers the
   hub cannot see (`firstFrameMs` vs `firstPushMs`).
3. **P2 — re-measure the seek tail post-1.2.120.** The pre-fix 8 s audio
   signature (`loadMs−firstFrameMs = 8000±1`, `readMs=0 demuxMs=0
   reusedWhole=true`) appears in lines up to 07:27; the fix deployed 07:58 and
   no scrub has run since. Expect: bound ≤ 1 500 ms and `seek-audio-dropped`
   lines when audio overruns. If the ≤1.5 s freeze after a scrub commit still
   reads as a stall, the follow-up is moving the audio join fully off the
   critical path (start paced video immediately, attach audio when demuxed) —
   small feeder change, design-reviewed, not urgent.
4. **P3 — optional, after P0+P1 data:** shorter substream GOP (camera config);
   event-media location to SSD if event playback latency shows the same
   signature; thumbnail strip ONLY if a measured fling still starves.

## 8. Measurement appendix (repro)

- Drag census: `docker logs CamStack | grep scrub-feeder:drag-end` — fields
  per D69. Seek: `recorded:seek-ready` (+ `recorded:seek-audio-dropped`,
  `recorded:play-census`, `recorded:play-stall` since).
- Read-path bench: `scrub-read-bench.mjs` (session scratchpad) — locate +
  readSegmentBytes over tRPC, cold targets then warm repeats.
- Disk: `iostat -x 10 3 | grep sdl`; per-process attribution via `iotop -a` /
  `/proc/<pid>/io` deltas (the sustained reader during measurement was a
  recorder export ffmpeg, device 1441).
- Layout: `lsblk -o NAME,MODEL,ROTA,TRAN`; `filefrag <segment>`;
  `storage.listLocations` for the location table.

---

## 9. Day-2 addendum (operator: "ottimizziamo per il disco attuale") — measured follow-ups and what shipped

The operator froze P0 (the SSD move stays an option in §3, not an action).
Follow-up work, same day, all against the USB spindle as the given constraint:

**The "~15 high-only cameras" premise shrank under measurement.** Recording
configs, all 26 devices: 9 cameras are `enabled: false` (no recording at all —
their leftover trees misled the disk survey), the 8 continuous cameras ALL
record `low`, and the real low-less population is **three events-mode
cameras**: 3628 (Reolink Argus 3E, battery), 3629 (Argus PT Ultra, battery),
3838 (`mid`-only). Their footage is sparse (locate probes over 15 h found
segments only on 3628) and a cold high-GOP read measured 2 642 ms (522 KB GOP,
warm repeats ~95 ms). Enabling `low` there is worth ~nothing until their event
volume grows; on battery cameras it also costs wake time. **Deprioritized with
numbers** — not the lever.

**The disk's daily read storm has a name and a schedule.** Two 10-hour
TIMELAPSE exports are enqueued at 07:06 every morning (cameras 1441 + 101,
`recordingExport.listExports`; several 08-20/22 attempts `failed`). Each reads
its whole 10 h of `high` (~60 + ~35 GB) at disk speed through the export
concat — the export running during this session's measurements WAS the ~10 MB/s
reader, and the pair keeps the spindle at ~100 % util for ~2–3 h exactly when
the household is awake. Every cold-read number in §1 was measured INSIDE that
window (the honest baseline for daytime scrub; nights are better). Options,
operator's choice — none implemented:

1. **Move the 07:06 automation into the night** (e.g. 03:00) — zero code,
   removes the whole morning window.
2. `-readrate` cap on export inputs (ffmpeg 6.1 supports it) — lowers the
   export's instantaneous pressure but LENGTHENS the window (same bytes);
   a trade, not a win, on a disk-limited render.
3. `bfq` on `sdl` + idle-class ionice for export ffmpeg — the only true
   prioritization: today the queue is `mq-deadline`, where io-priorities are
   inert, so this needs a host-level scheduler switch (reversible, one sysfs
   write) plus a small spawn change.

**Idle warm shipped (addon-pipeline 1.2.122, hub, 09:55).** The 19× cold/warm
ratio made the warm strategy the main cure on this disk, and the measured gap
was that the fill only ran while `scrubbing` — starved by the drag's own reads
and killed at commit (census: 135 whole reads / 144 cover misses; warm-start 91
times in 48 h with nearly nothing fetched). `RecordedFeeder` now starts a
**paced idle fill after every completed seek** (a tap or a scrub commit):
±15 min around the landing, backward first, one segment per
`IDLE_WARM_READ_GAP_MS` (250 ms), yielding to any in-flight seek and to finger
ticks, `low`-only. **Declared budget: the pre-existing 48 MB per-session
fragment cache (LRU) and the pre-existing per-window segment cap — the feature
adds no store and no new ceiling**; disk cost ≤ ~1 read/s while filling, ~40 MB
per window, stopping by itself when the window is covered
(`scrub-feeder:warm-done {fetched}`). The fill-loop respawn race (a walker
draining while a new drag began stranded the new drag's warm) is fixed in the
same commit. Expected effect: the drag AFTER a landing runs on RAM
(`coverCache` up, `readMsP50` on hits ~2 ms); first-ever drags of a session
still pay cold until the viewer half lands (below).

**The viewer half (specs 2026-08-07) is implemented and parked on a branch.**
The viewer submodule ship in flight blocks the working tree, so the port lives
on `feat/scrub-velocity-mapping` (submodule worktree, commit amended clean):
jog-dial mapping over the SCROLL timeline (the spec assumed a pan handler; the
adaptation integrates every scroll sample, detaches the cursor at 1 px = 1 s
when careful, commits the CURSOR and realigns the strip), `m`/`v` hints on
`scrubTo` through both transports (injected-JS and postMessage), the embed
bridge additions (`scrubTo(epoch, m, v)`, `timelineWarm`), warm-on-open from
`CameraDetailScreen`, and the per-drag census line (`theater:scrub`, added to
`ALWAYS_SHIP_SCOPES`). 937 viewer + 592 embed tests green, `ts-check` clean
standalone. **To ship when the tree frees:** merge the branch, then the full
chain — OTA (`update:patch`) + `sync:embed` + `build:orchestrator` + orchestrator
deploy — since the embed page changed too.

**Post-audio-fix seek tail: still unmeasured on real gestures.** No scrub or
recorded seek has run on the hub since 1.2.120 landed (07:58) — the census
count since 08:00 is zero. The first real drags will say whether the 8 s
signature is gone (`loadMs − firstFrameMs ≤ ~1500`, `seek-audio-dropped` lines
when audio overruns) and what idle warm changes (`warm-done` fetch counts,
`coverCache` vs `coverMiss`).
