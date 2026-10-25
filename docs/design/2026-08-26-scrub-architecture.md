---
title: Scrub and recorded playback — the right shape, not the next tune
covers:
  - packages/addon-pipeline/src/stream-broker/recorded/**
  - packages/addon-pipeline/src/recorder/**
status: design
date: 2026-08-26
---

# Scrub and recorded playback — the right shape for this system

> Question answered here: after two days of tuning with visibly diminishing
> returns, is the ARCHITECTURE right — and if not, what replaces it, in what
> order? Facts are built on, not re-derived:
> [`2026-08-25-reference-scrub-teardown-and-plan.md`](2026-08-25-reference-scrub-teardown-and-plan.md)
> (the reference design, measured on both sides),
> [`2026-08-25-scrub-advanced-analysis.md`](2026-08-25-scrub-advanced-analysis.md)
> (where our time goes), the 2026-08-26 first-pass-stall entry in
> `../history/sessions.md` (planning repo: sessions/sessions.md), and
> [`../architecture/data-planes.md`](../architecture/data-planes.md) +
> [`decode-path.md`](decode-path.md).

## 0. The facts this stands on

Everything below is measured and sourced in the companion docs; restated once
so the argument is self-contained.

| Fact | Number | Where |
| --- | --- | --- |
| Cold `low` segment read (5400 rpm SMR USB spindle) | **531 ms p50, 1.4–2 s p95, 9.2 s max** | advanced §1 |
| Same read warm (same wire) | 28 ms | advanced §1 |
| `recording.locateSegment` (cross-process RPC) | p50 6–9 ms, **p90 300 ms, max 618 ms; 1–8 s saturated** | teardown §2 |
| Demux (off-thread) | 2 ms p50 | advanced §1 |
| Client leg push→ack, and paint | 25 ms p50; paint tracks the wire within ~25 ms | sessions 08-26 |
| hub-main event loop | one queue for the cluster; reclaim stall every ~2.3 min, loopMax ~740 ms during it | sessions 08-25 |
| The dominant gesture | **26 of 29 drag jumps BACKWARD** | operator drags 08-26 |
| Speculation on those drags | 25 reads for 3 hits — ~60 % of disk work, **88 % waste** | operator drags 08-26 |
| Fixed in the last hours, live | detached-Buffer 1 500 ms/cold-seek gone; byte-budget read unit; 30 s lead ceiling (`readMsP50` 246 → 27–79) | — |
| Shipped client half | velocity mapping (viewer v1.0.402), `onScrubDrawn` paint census |, `88e9976` |
| Reference product's trick | **no prediction at all** — 8 MB `highWaterMark` on an open fd, fast-forward for short moves, 33-step deadline-bounded animation otherwise | teardown §1 |

### 0b. The 2026-08-26 cold-access experiment — the "SSD" premise is false on this host

The teardown assumed the reference product's floor was "one sequential ≤1 GOP
read from SSD". Measured on the live host (operator's suggestion, this
session), it is not SSD at all — and that re-scopes the hardware question:

- The reference NVR's NVR share — main video AND `low-resolution`; there is no
  `fastDisks` split on this host — sits on a **ZFS stripe of four 7200 rpm
  CMR SATA spindles** (`nvr` pool: sdg/sdh/sdi/sdj).
- Cold access there, on files from **2026-07-11/12** (six weeks old; ARC is
  3.2 GiB — these were real disk reads), while the pool absorbed the reference NVR's
  live recording writes: **256 KB mid-file pread 29–56 ms; segment JSON
  10–14 ms.** A whole cold seek ≈ **~50 ms on spinning rust.**
- The same instant, 10 s averages: the reference NVR's write load (~11.7 MB/s
  aggregate) holds each pool member at **~5–7 % util** (ZFS txg batching,
  160 KB avg requests, four arms). CamStack's comparable write load
  (9.3 MB/s, 64 w/s) holds the single sdl at **94.6 % util with
  f_await 1 814 ms**.
- CamStack cold reads sampled in the same minute: 57–71 ms — when they land
  in a gap. The field p50 of 531 ms and the 9.2 s max are the same reads
  landing behind a write burst or an SMR/btrfs flush on the one arm that
  takes everything.

**Conclusion: the floor is not "spindle vs SSD"; it is ONE oversubscribed
5400 rpm SMR USB arm versus any medium with headroom.** Four idle CMR arms
deliver reference-class cold seeks. And the `nvr` pool is **4.4 TB and
essentially empty (128 K used)** — the reference-class medium already exists
on this host, mounted, with measured headroom.

Decided elsewhere and **not re-proposed here**: 60-second segments (the
un-finalized tail grows with segment length and a trigger landing in it can
lose 100 % of its output — camera 1439), the `.rtsp` container, per-device
`segmentSeconds` (removed — segment length is architectural).

## 1. Verdict: the model is right; three PLACEMENTS and one direction are wrong

**On-demand demux-from-storage is the correct model for this system, and the
last two days did not fail because of it.** The mechanism-level case:

- The reference product does exactly the same thing — no precomputed scrub
  artifact exists on either side (teardown §0). The architecture question was
  never "precomputed vs on demand"; it is what one frame costs.
- The container is not a cost anywhere in the measured decomposition: demux is
  2 ms, segments are one extent, byte-range addressable, with an in-file
  keyframe index the recorder already exploits. Every alternative container
  was evaluated and rejected with numbers (advanced §5, teardown §4).
- The gesture contract now matches the reference where it matters: latest-wins
  retargeting, single-flight with a ride window, a per-frame deadline that
  drops instead of waits (`SCRUB_TICK_DEADLINE_MS` docblock's four rules), a
  receiver credit that cannot park a slowed drag. Those were the algorithmic
  gaps, and they are closed.

What is wrong is not the model but **where three pieces of the work run, and
which direction the read unit optimizes for**:

1. **Discovery runs as a per-tick cross-process RPC through the busiest event
   loop in the cluster.** `locateSegment` transits broker runner → hub-main →
   recorder runner. Its p50 is fine; its tail is hub-main's tail — the ~740 ms
   reclaim stalls and the boot storms land exactly on the gesture (§3.2).
2. **Media bytes ride the same loop.** Every 230 KB segment read is
   MsgPack/JSON through hub-main. At drag + idle-warm rates that is ~1 MB/s of
   serialization on the one queue everything else shares (§3.4).
3. **Every cold byte queues on a spindle at 94–100 % utilisation.** This is
   the floor, it is 19× the whole rest of the path, and no software below
   changes it — only shrinks how often it is paid. §0b showed the floor is
   the oversubscription, not the rotation: the reference product pays ~50 ms
   cold on four idle spinning arms (§2, §4-P0).
4. **The read unit is direction-blind while the gesture is backward-dominant.**
   A whole-segment read serves the target and leaves the bytes AFTER it in
   cache; 26/29 jumps go backward, into bytes nobody read ahead (§3.3).

## 2. The four questions, answered

### 2.1 Should scrub read from a purpose-built artifact written at record time?

**Not an image artifact — that is settled twice over.** The sprite/thumbnail
tier was built, served zero production frames, and was deleted (D41
amendment); the reference product has no scrub thumbnails either. An image
sidecar costs a decode on a recorder that runs `-c:v copy` and decodes
nothing, and it creates a second client fetch path beside the WebRTC train —
the exact shape that died. Reject, again.

**A keyframe pack — compressed IDR access units copied (not decoded) into one
append-only file per camera-hour — is the one artifact with a mechanism-level
payoff, and it is worth building only under one condition (below).** What it
is:

- At segment finalize, the recorder already opens the file and reads head +
  tail from page cache (`mfra-capture.ts`). The `tfra` names every keyframe's
  byte range; the whole 230 KB segment is still in page cache milliseconds
  after the write. Extend the same pass: copy the 2–3 IDR ranges (~35–45 KB
  each on `low`) into `scrub/<cam>/<hour>.pack` with a length-prefixed
  `(epochMs, len)` record header. **No decode, no ffmpeg, no new subprocess.**
- Read path: jump-mode scrub — the fast-drag mode, the broken one — reads a
  RANGE of the pack instead of one segment per frame. One ~1 MB range read =
  ~25 keyframes = **~100 s of timeline per seek**, in either direction. The
  frames go down the SAME wire (AU push, D42); only the byte source changes.
  Sweep mode (frame-accurate, needs P-frames) keeps the whole-segment read.

Costs, stated before anyone discovers them:

- **Disk**: IDRs are ~40–50 % of the `low` stream ⇒ ~36 MB/h per continuous
  camera, ~7–9 GB/day for the 8 continuous cameras. Trivial next to `high`'s
  600 GB/day; bounded by its own `maxUsedGb`.
- **Write path complexity**: a new file kind — append lifecycle, a truncated
  tail record on crash (recover by scanning length prefixes and truncating),
  janitor/retention integration (delete the pack with the hour), relocation
  awareness. Real work, all recorder-internal.
- **Un-finalized tail**: the pack lags the live edge by one segment
  (`spawn + segmentSeconds + dial`). Acceptable: scrub inside the last ~15 s
  falls back to today's demand read, and the newest seconds are in the
  broker's live pre-buffer anyway. The pack never gates finalize — it is a
  post-finalize copy, so a pack failure loses scrub locality, never footage.
- **Cap surface**: the broker needs a ranged pack read ⇒ a `recording.cap.ts`
  method ⇒ codegen + **framework train**, plus recorder + broker deploys.

**The condition: the pack and the P0 media move are mutually exclusive
investments.** On any medium with headroom (NVMe: 5–15 ms; the idle 4-arm
pool: ~30–60 ms measured, §0b) jump-mode cadence reaches 15–30 fps with no
new artifact; the pack would buy a second copy of bytes that are already
cheap. Only on the oversubscribed sdl spindle is the pack the one structure
that changes fast-drag cadence (one seek buys ~25 frames instead of 1 —
amortized ~45 fps even at 531 ms/seek). Decide P0 first; build the pack only
if the answer stays no.

### 2.2 Is the cross-process `locateSegment` hop defensible on a gesture path?

**Per tick, no. Per window, yes — and the fix is changing the question, not
the process topology.** Co-locating broker and recorder is off the table (D2:
one addon = one process; D29: never group data-plane runners — a co-located
crash respawns both). What is actually indefensible is asking "which file
holds instant T" once per finger position when the answer set is immutable:

- Recorded footage never changes behind the reader. A segment row
  `(startMs, durMs, bytes)` is ~24 B; a ±30 min window is ~180 rows ≈ 4 KB —
  one RPC returns the whole drag's discovery. Staleness is one-directional
  (only the live edge grows; revalidate forward only), and eviction produces
  an ENOENT on read that is already handled as a gap. This is the same
  property that lets the reference product cache dirents with no
  invalidation.
- A **windowed segment map in the broker** (one `listSegmentWindow` call at
  drag entry / warm / recenter, then RAM binary search per tick) removes
  `locateMs` from every tick AND removes the `resolveProfile` ladder — which
  today re-pays locate RPCs on every commit (`timeline-session.ts` docblock:
  "1–8 s on cold footage... latency the operator feels as a slow commit").
- What it costs: a new method on `recording.cap.ts` ⇒ **framework train** +
  addon deploy. The p50 saved is single-digit ms; what is bought is the TAIL —
  the gesture stops sharing a queue with hub-main's reclaim stalls and boot
  storms. On a 700 ms frame deadline, a p90 300 ms discovery hop is 43 % of
  the budget spent before the disk is even asked.

Until the train: the shipped mitigations (session fragment cache skipping
locate on coverage, the ride window, the deadline) already keep the hop off
the warm path. The hop is defensible as a fallback; it is not defensible as
the steady-state per-tick path.

### 2.3 Backward scrubbing — is there a structure that makes it cheap?

Backward is the gesture that matters (26/29) and it has no fast-forward
trick: the decoder needs the IDR at-or-before the target, and with a fixed
4 s GOP there is never a closer keyframe behind. Three structures change its
cost; they are not equivalent and only one needs new machinery:

- **(a) Direction-anchored read units — cheap, deterministic, addon deploy.**
  Today every read is forward-anchored: the byte-budget GOP read fills
  forward from the covering fragment, and a whole-segment read leaves the
  target's segment in cache — the bytes AHEAD of a backward drag are never
  touched. Two changes, both in existing code paths:
  - the byte-budget window (`fragmentsWithinBudget`) takes an anchor: when
    the drag direction is backward, budget consecutive fragments **ending**
    at the covering one — `[target − budget, target]` instead of
    `[target, target + budget]`;
  - after a landing with a confirmed backward run, deterministically read the
    **previous adjacent segment** into the session cache — one in flight,
    standing down on the existing `SCRUB_SLOW_READ_MS` median gate. This is
    adjacency, not prediction: a continuing backward SWEEP crosses the
    previous segment with probability 1 at any velocity. It replaces the
    deleted velocity prefetch; it must not be added beside it.
  Honest bound: (a) makes backward sweeps and short backward steps as cheap
  as forward ones. It does NOT help a fast backward fling whose jumps skip
  whole segments — nothing adjacency-based can.
- **(b) The keyframe pack (§2.1)** is the structure for the backward FLING:
  descending range reads in one hour file, ~25 keyframes per seek. Same
  exclusivity condition as §2.1.
- **(c) P0** dissolves the question: at 5–60 ms a random read per tick is an
  acceptable answer, which is precisely the reference product's answer —
  their backward path IS the 33-step keyframe animation: random reads,
  deadline-bounded, measured at ~50 ms cold **on four spinning arms with
  headroom** (§0b).

So: backward is inherently one random read per keyframe **on segment files**;
it is not inherent to the system. Rejected alternatives: reverse-ordered file
layout (helps only whole-file scans), shorter camera GOP as a latency fix
(decode-side, not I/O-side — the cost is the seek, advanced §5), 60 s
segments (decided; and note the byte-budget read unit has already decoupled
scrub cost from segment length, so segment duration is no longer a scrub
argument in either direction).

### 2.4 What does the operator need to SEE while dragging?

Split the gesture; the assumption that one answer covers both is what cost
the sprite tier its life and this week its tuning budget:

- **Careful drag (sweep granularity)**: a decoded video frame is the right
  and only answer — the operator is inspecting motion frame-by-frame. The
  P-frame walk is load-bearing (`data-planes.md`: the only mechanism that
  lands between keyframes) and the AU-push transport is measured healthy
  (ack 25 ms, paint within 25 ms of the wire). Keep D42. Reject image-based
  scrub on this leg permanently.
- **Fast drag (jump granularity)**: the operator is SEARCHING, not watching.
  What search needs is (i) frames that are FRESH — where the finger is, not
  where it was: shipped (deadline + retarget + lead ceiling; the census now
  proves paint tracks the wire); (ii) frame DENSITY enough to notice the
  thing being searched for — this is the medium-bound half: ~2 fps aggregate
  is the physical ceiling of one-seek-per-frame on this spindle, ~25× that
  with the pack, 15–30 fps on any P0 medium (§0b). No further tuning moves
  it; only §2.1's condition does. (iii) **Non-frame context, which is cheaper per unit of
  search-signal than any frame**: the activity bar and event markers already
  on the timeline, and the event/track thumbnails the teardown's P2 moves to
  cacheable URLs. A fling that lands NEAR the sought moment because the
  timeline said where to look needs ten frames, not two hundred.

So a decoded frame is the right answer at both granularities — but at jump
granularity it is the right answer at whatever cadence the medium affords,
and the honest fix for "1–2 fps when dragging fast" is named P0/P3b, not a
fifth tuning pass. The perceived-quality floor ("the picture chases the
finger") was the real defect and it is fixed; the remaining gap is cadence.

## 3. What should NOT change — rejections, not silence

- **The storage format and segment length** — see §0; nothing measured is
  attributable to fMP4, and both migrations were rejected with mechanisms.
- **The WebRTC AU-push transport, credit/ack, coalesce** — every client-leg
  number is healthy; the transport was never the cost.
- **Directory-names-as-index (deleting the RAM `RecordingIndex`)** — elegant
  in the reference, ~1 GiB of RAM and a boot-blindness win here, zero scrub
  win (locate p50 is 6–9 ms). Park it, as the teardown did.
- **Co-locating broker and recorder** — D2/D29; the window map (§2.2) buys
  the same latency without sharing a crash domain.
- **A client-pull scrub plane** (browser fetches segment ranges over HTTP and
  decodes via WebCodecs — the reference's other half). It would delete the
  feeder's server-side complexity, and it is the long-horizon shape if the
  embed ever adopts WebCodecs. Today it means a second decode path, a second
  auth surface, and re-solving credit/pacing in the client, against a server
  path that now works. Reject for cost, note for the horizon.
- **Re-tuning speculation.** The velocity-prefetch experiment is concluded by
  its own census: 88 % waste on a saturated spindle. Its removal (in flight)
  is the decision; §2.3(a) is what may replace it, and only under a confirmed
  direction run.

## 4. The plan, ranked by cost against what it buys

Cost classes, cheapest first: settings change → addon deploy → framework
train → image rebuild → hardware. Exclusivities are stated inline.

| # | Change | Cost | Buys |
| --- | --- | --- | --- |
| **P0** | **Move scrub media off the oversubscribed arm.** Two targets, either works: (a) `recordingsLow` → `/data/recordings-low` (hub NVMe, 144 G free — settings change only, no container change, `low` only); (b) a dataset on the **`nvr` ZFS pool** (4.4 TB, 128 K used, four 7200 rpm arms at ~6 % util, §0b — new bind mount ⇒ container recreate, but big enough for `low` + event media, or eventually everything). The relocate-engine drains the recent window either way. The pool is shared with the reference NVR's writes — measured headroom says fine; the shared-fate trade is the operator's call. | (a) settings change · (b) settings + container recreate | The gap itself: cold read 531 ms p50 / 9.2 s max → 5–15 ms (NVMe) or ~30–60 ms measured (pool); cold tick ≈ 50–90 ms; jump cadence 15–30 fps; warm/cache mechanisms stop being suppressed. Everything below is headroom against this. **Excludes P3b.** |
| **P1** | Finish deleting velocity speculation (in flight); re-read the census after — `prefetchReads` gone, `coverMiss` and `readMsP50` should fall on the next saturated-morning drag | addon deploy | Returns ~60 % of gesture-time disk work to the reads the finger is blocked on. |
| **P2** | Direction-anchored read units + backward-adjacent deterministic read-ahead (§2.3a), replacing — never beside — the removed prefetch | addon deploy | The dominant gesture stops paying cold for bytes the previous seek could have carried. Bounded by the same slow-read stand-down. |
| **P3** | Persist the keyframe table at finalize (teardown §4a): fold `tfra` offsets into the segment filename (path layout is recorder-internal — `segment-path.ts`) so the 26 h `MFRA_RETAIN_MS` re-derivation and the post-deploy blind tail reads disappear | addon deploy | Removes a random tail read per cold seek on old footage, and index survival across restarts. Prerequisite-free; also the first brick of P4. |
| **P4** | Windowed segment map (§2.2): `listSegmentWindow` on `recording.cap.ts`; broker locates in RAM; `resolveProfile` answers from the map | **framework train** + addon deploy | The gesture leaves hub-main's queue: locate p90/tail (300 ms–8 s) off the frame deadline; commits stop walking the profile ladder over RPC. Ride the next train — not worth one alone. |
| **P5** | Segment/pack bytes off hub-main: serve scrub reads from the recorder's existing node-local HTTP data plane (`/addon/recorder/playback`, `still/` precedent; scoped tokens exist) instead of MsgPack через the cap wire | addon deploy (after P4) | ~1 MB/s of serialization off the cluster's one queue; matters most AFTER P0, when transit (~25–40 ms) becomes the dominant term of a warm tick. |
| **P3b** | The keyframe pack (§2.1) — **only if P0 stays frozen** | framework train + addon deploy (+ ~7–9 GB/day) | Fast-drag cadence 2 → ~25 frames per seek on the spindle that is otherwise the permanent floor. **Excluded by P0.** |

Reading the table honestly: P0 is the cheapest cost class in the system and
the largest gain in this document, and §0b removed its last counter-argument
— the freeze was "ottimizziamo per il disco attuale" against a plan that said
"SSD", but the competitor this system is measured against runs its scrub on
four spinning disks with headroom, one mount away, at ~50 ms cold. The freeze
is the single most expensive standing decision on this path; P1–P5 together
do not add up to it. The plan above is ordered for the world where it stays
frozen anyway; if it unfreezes, strike P3b, demote P2's read-ahead to
optional, and keep P1/P3/P4/P5 — they are correct on any medium.

Verification, per step, from instruments that already exist: `drag-end`
census (`readMsP50`, `coverMiss`, `deadlineMisses`, prefetch fields absent
after P1, `locateMs*` ≈ 0 after P4), `recorded:seek-ready` split by
`prefixSource`, and the client paint clock (`onScrubDrawn`) for the number
the hub cannot see.

## 4b. Measurement appendix — the §0b experiment (repro)

Read-only, from the Mac over `ssh unraid`; total extra I/O ≈ 5 MB. The
The reference NVR CONTAINER was never touched — only host-side file reads.

- Layout: `docker inspect the reference NVR --format '{{json .Mounts}}'` →
  `/mnt/nvr/NVR` (ZFS dataset `nvr/NVR`); `zpool status nvr` → sdg1 sdh1
  sdi1 sdj1 (ST12000VX0017 + 3× ST12000NM0127, all `ROTA=1`, 7200 rpm CMR).
  `low-resolution` destinations live on the same pool — no `fastDisks`.
- Samples: 7 `.rtsp` files, 0.86–1.27 MB (60 s of their low-res ≈
  120–170 kbps), sessions dated 2026-07-11/12; 4 camstack `low` `.m4s` from
  2026-08-25 03:xx. ARC `size` 3.2 GiB ⇒ six-week-old files are not cached.
- Read shapes: the reference NVR = `cat` of the sibling `.json` + one 256 KB
  `dd … skip=<40 % of file> iflag=skip_bytes` (their seek = cached JSON +
  one pread at a `videoSeekPoints` offset); camstack = whole-file read
  ≤1.5 MB, else 256 KB mid-file range (the shipped read units). Timed with
  `date +%s%N` around `dd`.
- Results: the reference NVR range reads 29/34/35/35/45/50/56 ms, JSON 1–14 ms;
  camstack 57/64/67/71 ms. Context (10 s `iostat -x`): sdl 94.6 % util,
  r_await 46.7 ms, f_await 1 814 ms under 9.3 MB/s of recording writes; nvr
  members 4.6–6.6 % util under ~11.7 MB/s aggregate, f_await 64–130 ms.
- Side-finding: camera 1441's `low` segments are 2–3 MB per 8–12 s
  (~2–3 Mbps — not a real substream rate). Its every scrub read is already
  the GOP-range fallback; worth a camera-side encoder look regardless of
  anything above.

## 5. UNKNOWN — named, not guessed

- **What re-hydrates `readSegmentBytes` on the transport** (Buffer vs
  Uint8Array) — the one unverified link in the detach post-mortem. The
  discriminating test is one line at the broker: log `bytes.constructor.name`
  before demux. P5 makes the question moot; until then it is open.
- **How much of today's `coverCache` hits are idle-warm versus drag-warm.**
  `prefetchHits` is separated; warm attribution is not. Before extending or
  deleting idle warm, add the attribution — the 88 %-waste verdict on
  velocity prefetch must not be transferred to a mechanism that was not
  measured.
- **Where the saturated-hub locate tail queues** (hub-main's loop vs the
  recorder's). The reclaim-stall correlation is a mechanism-shaped
  suspicion, not a proof; P4 removes the dependency without needing the
  answer, which is why it is safe to ship unproven.
- **Whether the operator's "1–2 fps dragging fast" is now cadence-only.**
  `onScrubDrawn` shipped hours ago; the first post-`v1.0.402` drags will say
  whether paint lag re-enters anywhere. If it does, that is a new fact this
  document does not cover.
- **The §0b samples are small and single-moment** — 7 the reference NVR reads, 4
  camstack reads, one afternoon. The per-read numbers are load-bearing only
  as an existence proof ("~50 ms cold on this pool is achievable under live
  writes"); the 10 s utilisation averages and the census p50/p95 remain the
  field truth. Before committing P0(b), repeat the read bench during the
  07:06 export storm — the pool's headroom at the worst hour is the number
  the decision actually rests on.
- **Why sdl's write load costs 94 % util while the pool's costs 6 %** is
  attributed here to arms × rpm × SMR × btrfs-flush behaviour versus ZFS txg
  batching — mechanism-shaped, consistent with every measurement, but not
  decomposed per factor. The decision does not need the decomposition; a
  future "just tune btrfs" proposal would.
