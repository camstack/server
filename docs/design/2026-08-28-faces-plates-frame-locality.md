---
title: Faces and plates, frame locality, and where the enrichment misses actually come from
last-verified: 2026-08-28
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/**
  - packages/addon-pipeline/src/session-decode/**
---

# Faces and plates, frame locality, and where the enrichment misses come from

> **The question.** *"Potrebbe essere di beneficio spostare la parte di faces/plates
> da post-analisi in orchestrator? O farli girare sullo stesso runner? Per
> permettere un facile passaggio dei frame."*
> [Could it be beneficial to move the faces/plates part from post-analysis into the orchestrator? Or make them run on the same runner? To allow an easy handover of frames.]
>
> **The answer, committed.** No. Keep the boundary. The intuition is good and it is
> aimed at a hop that **no longer exists**: face and plate inference already run
> inside the `detection` group, and `pipeline-analytics` has not received a pixel
> for a model input since the two-plane cut. What crosses the boundary is *gallery
> and event media*, and neither its miss rate nor its memory cost is caused by the
> boundary. Both are caused by things co-location would carry across unchanged.

## 1 · Three facts that decide it

**1.1 The orchestrator holds no frames.** `pipeline-orchestrator` is `hub-only`,
declares no `execution.group`, elects nodes and owns session lifecycle. It never
opens a decode session and never holds a `FrameHandle` — and being `hub-only` it is
on the wrong *node* for every camera the hub does not run. Dead end, not an option.

**1.2 The pixels are not in the `detection` group either.** The native raster lives
in a `child_process.fork`ed decode worker child (`session-decode/decode-worker-child.ts`),
forked by `session-decode-pump.ts`. `pipeline-runner` — a `detection` member — does
not hold those pixels; it asks for them one `pull` at a time across a boundary of its
own. The real topology:

    [ decode worker child ]   [ detection group ]        [ pipeline-analytics ]
      THE PIXELS          IPC   runner, executor,   cap    tracker, gate, media,
      native lease R1      <->  motion, py pools    <->    galleries, stores
      subject tiles R2

Co-locating post-analytics with `detection` moves it from the third box to the
second. **The pixels stay in the first.** And `worker-lease-gone` is decided
entirely inside that child, on a clock and a containment test with no knowledge of
who is asking — invariant to the caller's process.

**1.3 Face and plate INFERENCE already runs in the detection group.**
`detail-dispatcher.ts` calls `pipelineRunner.runDetailSubtree`, node-pinned; the
chains `face-detection -> face-embedding` and `plate-detection -> plate-ocr` execute
on the runner. `deriveDetailCropRect` cuts the rectangle on the runner (D52).
`FaceRecognizer.ingestFaceDetail` takes a decoded **vector**; `PlateRecognizer`
takes OCR **text**. What `captureCrop` fetches is the *gallery tile*, not a model
input. The premise asks for something the system already has.

## 2 · What the 0.25 miss rate is made of

`enrichment crop native miss` is emitted from one place, `pipeline/capture-crop.ts:80`,
covering **face, plate, clip-embedding, the classifier fallback, the confirmation gate
and the native keyFrame**. It carries `deviceId` and `nodeId` and **no `kind`** — so
507-per-5-minutes cannot be split by consumer at all.

- **`worker-lease-gone`** — either the ask is late (measured handle age at miss:
  p50 367 ms, p75 1.0 s, p90 4.3 s) or **the rectangle is contained by no tile**.
  `MAX_TILE_SUBJECTS_PER_FRAME` is **4**: a frame with five people loses the fifth's
  tile permanently, and a face rectangle is cut from the person tile.
- **`Input/output error`** — the vaapi `hwdownload` filtergraph inside the worker.
  On failure `LeaseActivityGate.disableFor(cooldown)` switches native lease capture
  **off for the whole camera**. Precedent: the latch version produced the 93-97%
  `nativeCropMisses` measured 2026-08-08.
- **`capture queue full — shedding`** — `requested:100 started:15 droppedStale:70
  droppedOverflow:11`. **81 of every 100 capture requests never executed.** They never
  reached the runner. `CaptureScheduler` allows `maxInFlightPerDevice: 3`,
  `maxQueuedPerDevice: 24`; enrichment sits at priority 4 with a 3 000 ms staleness
  bound. Every drop returns `null`, read as a miss, and retried — the queue is re-fed
  by its own overflow. **Entirely inside `pipeline-analytics`.**

## 3 · Where the 4.9 GB comes from

rss 4.9 GB, JS heap 182 MB, arrayBuffers 2.6 GB, `stranded` 4031 MB. The same addon
on the agents: 83 MB and 225 MB (only the hub consumes media). heap-watch's third
shape: **`native-residue` — freed, not returned to the kernel.**

`runtime/native-frame-transport.ts` has `wantJpeg` returning `true` unconditionally,
**including same-node** (a correct 2026-07-23 fix: raw RGB over the UDS relay
ballooned hub-main). But on arrival, for every subject and enrichment crop:

1. `reply.jpeg` base64 string
2. `Buffer.from(base64)` — allocation 1
3. `sharp().raw().toBuffer()` — allocation 2, **raw RGB** (24.9 MB for 4K)
4. `Buffer.from(rgb.bytes)` in `cropReplyToRgb` — allocation 3, a full copy
5. `Buffer.from(bytes)` in `encodeRgbCropToJpeg` — allocation 4, another full copy
6. `sharp().jpeg({quality:90})` — allocation 5, the stored JPEG

**Decoded from JPEG, copied twice, re-encoded — and nothing in between looks at the
pixels.** The correct shape is one function away: `getFullFrameJpegBase64` already
refuses to decode, with the reason written down — *"a decode plus a re-encode of an
image nobody on this side ever looks at."* It was never applied to the crop paths.

**None of this is a boundary cost.** Merge the processes and all five allocations
still happen — inside the detection runner, where a 152-second event-loop stall
loses more than a gallery tile.

## 4 · Why co-location is refused

D29's motive (RAM reclaim) is not this proposal's motive, but its consequence binds:
`CrashSupervisor` respawns the **whole** runner, a runner publishes its manifest only
after every member's `initialize()` returns, and heap-watch takes the **max** budget.

| D29's gate | `pipeline-analytics` |
| --- | --- |
| not on a live frame path | **fails** — the confirmation gate blocks track birth on a `captureCrop` round-trip |
| frame-free | **fails** — the largest media consumer in the cluster |
| low-crash | **fails** — see below |

- **2026-08-27** — OOM killer took `hub/pipeline-analytics` at **11.4 GB**; every hub
  runner logged `loopMax ~152-158 s`.
- **2026-08-19** — `boot step buildNotificationCenter ms=270000`. For 270 s no provider
  for any capability it declares.
- **2026-08-14** — a timelapse render inside `initialize()` never returned; eight
  capabilities off **all three nodes**.

Co-located, the 2026-08-19 boot takes detection off every camera for 270 s. The
2026-08-14 incident takes it off indefinitely. **Conceded, not beaten.**

Option 2 (move only face/plate) is not separable at a worthwhile cost: identity is
keyed on `trackId` with five per-track maps whose lifecycle is the tracker's; labels
go through the one writer (D89 exists because re-deciding per row let 407 of 437
tracks disagree with their events); it reads and writes track media; and it shares
`CaptureScheduler`, which exists because 8 uncoordinated call sites caused a stampede.
The realistic version is "move the tracker too" — option 1 renamed.

## 5 · The recommendation, in order

**F1 — stop the decode/copy/copy/re-encode.** Consumers whose destination is a stored
JPEG should pass the runner's JPEG through, as `getFullFrameJpegBase64` already does.
Keep the decode for `keyFrame` (one surface, two encodes, deliberate) and
`captureDisplayCrop` (genuinely crops). Attacks the memory; no effect on misses.
Stated cost: stored tiles change slightly (different encoder), cosmetic only.

> **DONE 2026-08-28.** `tryNativeCrop` (→ `captureCrop`), `getNativeCropJpeg`
> and — as F1b, the same day — `captureDisplayCrop`'s native-ROI leg all hand the
> reply on. `NativeCropJpeg` is the arrival shape beside `NativeCropRgb`.
>
> The stated cost turned out to be smaller than stated: the runner encodes at
> `quality: 90` and `encodeRgbCropToJpeg` re-encoded at `quality: 90`, so the
> change removes a generation of loss rather than swapping encoders — the bytes
> differ, the picture does not get worse.
>
> **The exemption written above was half wrong, and it mattered.** Only
> `captureDisplayCrop`'s FALLBACK leg "genuinely crops"; its native-ROI leg was
> the same pass-through — and it is the HOT one, because the face and plate
> gallery injections call `captureDisplayCrop`, not `captureCrop`
> (`index.ts:3174`, `index.ts:3275`). F1 alone would have converted the colder
> route, and §6's first falsification row ("after F1, rss does not fall
> materially") would have fired for a reason that had nothing to do with §3.
> Two consumers keep the decode and both are now one-line justifiable: `keyFrame`
> (one surface, two encodes) and that fallback leg (handed a whole frame, must
> cut a region).
>
> Also removed, same change: two full copies of a raw RGB surface per key-frame
> capture (`cropReplyToRgb` copied the buffer `decodeJpegToRgb` had just
> allocated; the display fallback copied it again). ~12.4 MB per 1920-wide
> capture, immediately garbage — the fragmenting shape §3 is about.

**F2 — stop shedding 81%.** Refuse at the demand side, not at the tail: the demand
sites should consult lane depth and **not enqueue** rather than enqueue-and-be-shed —
a refusal that never enters the queue does not re-fire the scheduler; a shed one does.
Count and log every refusal per device. Then re-measure `maxInFlightPerDevice: 3`,
chosen when a reply was raw RGB; after F1 the payload is 10-20x smaller. Raise it one
step at a time against the scheduler window line, never blind.

**F3 — make the miss reason readable. Do this FIRST if only one thing gets done.**
`enrichment crop native miss` must carry the `NativeCropMissReason` the runner already
computes, the `handleAgeMs`, and the capture `kind`. And `NativeCropMissReason` needs a
fourth member, `lease-disabled`: today an EIO cooldown is indistinguishable from a late
ask, and they are opposite problems. F3 is what makes F1 and F2 falsifiable.

**F4 — only if a residue remains: widen the TILE, do not lengthen the hold.** The
arithmetic is done: a held 4K raster is 23.75 MB, admitted ~2.1 frames/s, concurrency
4.3 typical / 12 peak. Holding across a 10 s window is ~498 MB per camera, **~6 GB at
peak** — the D9/D18 OOM. A lease held "until every consumer fetched" is unbounded by
construction. Levers in order: `MAX_TILE_SUBJECTS_PER_FRAME` (4, env-only) →
`nativeTileBudgetMb` (64) → `nativeLeaseHoldFrames` (8).

## 6 · What would falsify this

| Observation | Falsifies | Do instead |
| --- | --- | --- |
| After F1, rss does not fall materially | §3 — the arrayBuffers are not the transport copies | Heap snapshot + smaps census. A heap number needs a retainer. |
| The F3 split is dominated by `lease-disabled` | §2.3 — shedding is a symptom | Go at the vaapi filtergraph; F1/F2 will not move it |
| `started/requested` already ~1.0 fleet-wide | §2.3 and F2 | Misses are runner-side; F4's tile levers move up |
| Face/plate misses persist with `tilesCut` healthy, `tileMisses` high | Nothing above — expected residue | F4.1 |

## 7 · The measurement that settles it

Per device, never fleet-wide: (1) `capture scheduler window` —
`requested/started/droppedStale/droppedOverflow`, **the decisive one**; (2) the miss
line split by `kind` and reason — requires F3; (3) session-decode
`tilesCut/tileHits/tileMisses/leaseMb/holdOverflow`; (4) the `[mem]` heartbeat
correlated with capture rate — does `arrayBuffers` track `started` or `requested`?

## 8 · What could not be determined

- **Whether `nativeTileBudgetMb` is still at the `0` a 2026-08-13 incident set it to.**
  A live fact, not a repo fact. **If it is 0, R2 is off entirely and that single setting
  explains the whole miss profile** — check before doing anything in §5.
- Whether the 4.9 GB is the transport copies (code read, not a heap snapshot).
- Which consumers the 507 misses belong to — not derivable; F3's whole point.
- The current crash rate of `pipeline-analytics` — the OOM and two `initialize()`
  incidents are history; the *current* rate is what would make §4 quantitative.
- glibc arena behaviour in this container (`MALLOC_ARENA_MAX`, `malloc_trim` reach).

## 9 · Relationship to the records

**D9/D18** upheld — F1 makes the implementation *more* compliant by removing a raw-RGB
materialisation D18 never asked for. **D2** respected — no group change. **D29**
conceded, not beaten. **D52** untouched. No ADR here: the record follows F1-F3 having
measurements, not the analysis.
