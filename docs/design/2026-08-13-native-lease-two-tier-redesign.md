---
title: The native frame lease, redesigned in two tiers (roadmap task 29)
covers:
  - packages/addon-pipeline/src/session-decode/**
  - packages/addon-pipeline/src/pipeline-runner/**
  - packages/addon-pipeline/src/recorder/**
  - packages/addon-post-analysis/src/pipeline-analytics/**
---

<!-- covers-demotion 2026-09-09 -->
> **2026-09-09** — same demotion, plus a note on the merits: the native lease that this page designs was redesigned on 2026-09-09. D419 bounded its age, D420 made its accounting honest, and D422 supersedes both by parking the frame when it becomes relevant instead of going back to fetch it. Read D422 before this page.

# The native frame lease, redesigned in two tiers

> **Status, 2026-08-14. Phase 1 (R1 + R2) and Phase 2 (R3) are IMPLEMENTED and
> have RUN ON THE CLUSTER** — every defect in §§10–12 was found in production
> logs (dev:102, dev:1443, the hub runner), which is only possible on deployed
> code. Do not read the phrase "not yet deployed" in the commit messages as the
> current state; each said so of its own commit, and a deploy followed.
>
> What that shakedown cost, in order: the hold could not release (§13) and had
> to be mitigated live with `nativeLeaseHoldFrames: 64` +
> `nativeTileBudgetMb: 0`; then the tile tier cut ZERO tiles for three
> independent reasons, fixed in §10 (`sharp` unresolvable in the forked decode
> worker), §11 (an NV12 retained frame rejected by YUV420P-only plane math) and
> §12 (a frame evicted between two subjects). All four fixes are in `main` with
> specs that go red when removed.
>
> **Two things this document cannot tell you, because they are live facts and
> not repo facts**: whether the §12 fix is deployed on every node, and whether
> `nativeTileBudgetMb` has been moved back off the `0` the incident set it to.
> Read them off the cluster — the global `pipeline-orchestrator` setting, and
> `tilesCut` / `tileHits` / `tileCutFailures` on the per-device session-decode
> metrics line. `tilesCut: 0` with the budget non-zero means the tier is still
> not cutting and §§10–12 are the list of ways that happens.
>
> The operator approved the design on 2026-08-13 with two decisions folded in
> below: `nativeLeaseTtlMs` is REMOVED with R1 (§3.1), and R3 runs
> opportunistically wherever recording exists — with the hard condition that it
> never sits on a delivery's critical path (§3.3), enforced by
> `scripts/check-recorded-still-off-delivery-path.ts`.
>
> Still open: Phase 3 (the `recording.extractStill` cap method — needs a
> framework train), Phase 4 (cut `nativeLeaseBudgetMb` 1024 → 256 once
> `tileHits` / `holdOverflow` have been read on live traffic), and §3.4's
> encoded tier, which is deliberately not built. What §6 says about phasing
> still holds; §9 records what landed.
>
> **Update, 2026-08-26 — §13's fix was necessary and not sufficient; see §14.**
> §13's registry-LRU fix made the tile cut run reliably (confirmed: 2
> non-dispatch events in 12 h against a 60 s-per-device throttle). It did
> **not** fix the thing §13's own framing implied it would: on the ORDINARY
> path, `holdFrames` still never governs whether a late request (the
> `keyFrame` catch-up retry chief among them) can reach the hold, because
> `cutSubjectTiles()` — which ends the hold — runs on the SAME result callback
> **immediately before** `emitInferenceResult()`, whose downstream effect is
> what triggers that late request in the first place. The release is
> therefore always dispatched before the request that needs the frame can
> exist. Every key frame that lands today lands off an **orphaned** lease
> entry (`holdOverflow / leaseAdmitted = 0.667`, `leaseFrames` pinned at the
> `holdFrames` bound) — read [the follow-up
> analysis](2026-08-26-native-frame-hold-lifetime.md) before touching
> `captureNativeFrame`, `NativeLeaseStore.release`, or `holdFrames` semantics:
> the obviously-correct cleanup of declining an already-released frame would
> take key-frame landing from ~50% to ~0%, because the orphan is the only
> thing serving it today.

> **Update, 2026-09-09 — the lease now has an AGE ceiling on the REQUEST side
> ([ADR-0419](../decisions/adr-0419-a-native-lease-lives-at-most-ten-seconds.md)).**
> Nothing below changes: the hold is still bounded by a COUNT and the tiles by a
> BUDGET, for the reasons argued here. What is new is that a native crop
> REQUEST naming a handle registered more than `NATIVE_CROP_LEASE_MAX_AGE_MS`
> ago — the worker's tile TTL, 30 s; ten seconds was deployed for two hours and
> cost a quarter of the fleet's key frames, see
> [ADR-0420](../decisions/adr-0420-a-refusal-swept-before-the-ask-is-still-a-refusal.md) —
> is refused by `NativeCropRegistry` before any round trip, and the entry released. The
> measurement that forced it: 332 `worker-lease-gone` misses in 54 minutes on
> the Mac agent at a median `handleAgeMs` of 30 099 ms, with the registry pinned
> at 4096/4096. The 30 s tile TTL therefore still bounds RETENTION; it no longer
> bounds who may ask. (This note does not re-verify the rest of the document —
> `last-verified` is deliberately unchanged.)

Roadmap task 29 (`docs/roadmap.md`, "Structural pair (own train)") names three <!-- drift-ok: moved to the private planning repo -->
things: *GOP re-decode fallback / sync-crop local / encoded presentation tier*.
This document says what each of them is, which two of them are load-bearing,
which one is optional, and in what order they can ship.

Required background, not restated here: [decode-path.md](./decode-path.md)
§"Lease admission", [data-planes.md](../architecture/data-planes.md) §"The one
rule", [detection-execution.md](../architecture/detection-execution.md)
§"The detail crop is derived in ONE place",
[post-analysis.md](../architecture/post-analysis.md) §"The detail plane's crop
ladder".

**A note on decision numbers before you cite any.** The prose in this repo has a
systematic drift between `D` numbers and ADR filenames. Cite the FILE:

| Cited in prose as | Real record | What it says |
| --- | --- | --- |
| D9 | [`adr-0009.md`](../decisions/adr-0009.md) | frames never cross a process boundary at frame-rate; the hub-main OOM |
| D18 | [`adr-0018.md`](../decisions/adr-0018.md) | cross-process frame access is tRPC by handle, never shm |
| D52 | [`adr-0052.md`](../decisions/adr-0052.md) | one vector index = one crop derivation |
| "D54" | [`adr-0056.md`](../decisions/adr-0056.md) (id **D56**) | `runStatelessStep`: bulk work over stored media, node-pinned, one `modelId` |
| "D58" | [`adr-0060.md`](../decisions/adr-0060.md) (id **D60**) | media retried until it LANDS; the key-frame gate |
| — | [`adr-0073.md`](../decisions/adr-0073.md) | the detail crop ladder `frameHandle → frameJpeg → cropJpeg` |
| — | [`adr-0075.md`](../decisions/adr-0075.md) | lease admission = only frames that reached inference |

---

## 1. What is actually wrong

### 1.1 The lease pays per FRAME and is asked per SUBJECT

The lease retains a full native raster of every admitted frame:
`min(frameBytes × admittedFps × ttlSeconds, budgetMb)`. At 4K pinned RGB24 that
is 24.9 MB a frame and ~620 MB/s of GPU→RAM download while the demand gate is
open ([`adr-0075.md`](../decisions/adr-0075.md)). Measured on this cluster at
the operator's 2 800 ms TTL, every 4K camera sits pinned at `leaseMb:1020,
leaseFrames:43` — **the RAM ceiling binds and the TTL expires nothing**.

Everything that later asks for those pixels asks for a *rectangle around one
subject*: the detail plane's per-track enrichment, the face/plate native
re-cuts, the confirmation gate's `captureCrop`. The one exception is the native
`keyFrame` (a bounded ≤1920 full frame).

So the store's unit of retention is three orders of magnitude larger than the
unit of demand, and it is paid on **every** admitted frame, including the
overwhelming majority on which nothing was detected at all.

### 1.2 The window is structurally unreachable, and widening it is the wrong lever

[`adr-0073.md`](../decisions/adr-0073.md) already established this: the detail
dispatcher ticks at 1 000 ms with two in flight per device behind 500–900 ms
inferences, against a lease TTL of 1 200 ms. The request is not narrowly late,
it is *routinely seconds* late. Raising the TTL was considered and rejected
there — it multiplies the resident set on every camera to serve a tail.

The measurement agrees. Parsing a full day of hub logs (2026-08-08,
`scratchpad/cropmiss/parse.mjs day-0808.json.gz`):

```
"no crop source resolved" rung shape:  handle=1 jpeg=0 crop=0   58 523
native miss reasons:  worker-lease-gone 30 635 · no-registry-entry 27 888
per-camera avg handle age at ask time:  2 208 – 9 874 ms
rung-2 (frameJpeg) failures:            0     on every camera
```

Two facts fall out and both shape the design:

- **The ask is 2–10 s old.** No TTL anyone would accept covers that. The
  request must be served by something whose lifetime is decoupled from a frame
  buffer.
- **The ≤640 RAM tier never failed.** The `RetainedFrameStore` full-frame rung
  covered every one of those 58 523 misses. What a lease miss destroys is
  therefore **not the enrichment, it is the RESOLUTION** of the enrichment —
  and, for the native-strict kinds (`keyFrame`, `captureCrop`), the media
  itself.

> Read those per-camera numbers with the date in mind. 2026-08-08 predates
>  (2026-08-09), which turned `LeaseActivityGate.disable` — a
> latch held until the next dial — into an escalating `disableFor(cooldownMs)`.
> The 93–97% miss rates on 104/592/618 in that table are mostly that latch, not
> the structural window. The structural residue is the 2–7% baseline plus the
> unreachable detail-plane window. Do not quote the 93% as evidence for this
> design; quote the ages and the reasons.

### 1.3 Native capture fails for real, and the failure is expensive

`scratchpad/cropmiss/leasefail.json`, same day: **165** `native lease download
failed` lines across 10 cameras in 22 h — `Failed to add frame to filter:
Input/output error` (155) and `Invalid argument` (10), all `hw=true`, mostly 4K.
Each one is a `hwdownload` of a 24.9 MB surface that failed *after* being
attempted. The escalating cooldown bounds the damage; it does not remove the
cost of a retention design whose failure unit is a whole native frame.

### 1.4 What a miss costs downstream, permanently

790 of 3 633 tracks over 7 days (21.7%) ended with **no `keyFrame`**
([`adr-0060.md`](../decisions/adr-0060.md)) — never written, not deleted. Since
the embedding rebuild reads the key frame and nothing else
(`packages/addon-post-analysis/src/pipeline-analytics/rebuild-source-loader.ts`),
those tracks are outside semantic search *forever*: "there is no historical
backfill, and there cannot be — the pixels are gone."

That last clause is the sentence this design exists to falsify. **The pixels are
not gone. They are on disk, in the recording.**

---

## 2. What the reference NVR does instead

Two independent reads agree, and neither retains decoded frames the way we do.

**The OSS detection path: decode → detect → invalidate, in one iteration.** The
frame is owned by the generator and valid only for the duration of one `yield`;
`close()` nulls the backing buffer, and reading it afterwards throws `'Video
Frame has been invalidated'`
(`~/Documents/Git/`the reference NVR sources`,
`plugins/objectdetector/src/ffmpeg-videoframes.ts`). There is no lease, no
window, no frame id, and no ring of decoded frames.

**The second pass is pulled FORWARD into the detect-time critical section.**
Face embedding crops are cut inside `run_detection_image`, while the frame is
still live, via `image.toBuffer({crop, resize})` — and the crop executes in the
process that owns the pixels, never by shipping the raster
(`plugins/openvino/src/predict/face_recognize.py`). Only model-input tensors,
small crops and JPEGs cross a process boundary; the native raster never does.
That is our [`adr-0009.md`](../decisions/adr-0009.md) rule, arrived at
independently.

**What survives the frame is compressed and time-boxed.** A `Map<detectionId,
JPEG>` with a 10 s `setTimeout`, and a 10 s *encoded* (RTP) prebuffer.
Backpressure is drop, never buffer: `queue: 0`, `Queue(1)` + `put_nowait`,
`leaky=downstream`.

**The NVR product goes one step further and pre-extracts JPEGs at RECORD time**
(planning repo: .superpowers/sdd/) the reference plugin (§1a): a per-detection JPEG
`{hour}/{detectionId}.jpg` and a periodic snapshot JPEG `{hour}/{time}.jpg`
written into the segment directory, re-cropped in-process later by a native
image decoder. Decoding video to recover a past moment is the *last* resort,
behind a 5 s timeout. Their decode worker bounds in-flight frames at ~20 and
throws `'possible frame leak'` above it.

The contrast in one line: **The reference NVR does not pay a per-worker RAM lease because
it converts frames into small compressed artefacts at the moment they are still
valid, and treats "a past frame" as something you re-derive, not something you
hold.**

---

## 3. The redesign

Four rungs. Two are new, one shrinks to a fencepost, one is unchanged.

```
R0  reserved slot        newest delivered frame                      unchanged
R1  the HOLD             frame alive from delivery until its result  replaces the TTL lease
R2  the TILE lease       native subject tiles, compressed, per device NEW  (= "sync-crop local")
--- tier boundary: everything above is live RAM; everything below re-derives from bytes ---
R3  recorded re-decode   (deviceId, epochMs) → segment → GOP → still  NEW  (= "GOP re-decode")
```

The ≤640 `RetainedFrameStore` full-frame rung is untouched and remains the
honest lower-resolution fallback it is today.

### 3.1 R1 — the hold replaces the lease

Today the retention decision is a *time* (TTL) and a *size* (budget), neither of
which is related to the event the pixels are waiting for. Replace both with the
event itself: **a delivered frame stays alive until the runner has produced its
`FrameResult`, or until a hard bound, whichever comes first.**

- Acquire seam is unchanged: `FrameSlot.reserveSlot()`'s `retainSuperseded`
  hook → `captureNativeFrame`
  (`packages/addon-pipeline/src/session-decode/decode-worker-child.ts`).
  Admission is unchanged (`nativeLeaseAdmission: 'inferred'` — see
  [`adr-0075.md`](../decisions/adr-0075.md)); a frame the runner never marked
  is still a frame nobody can name.
- Release becomes explicit: the runner sends `frameDone(frameId)` on the same
  worker channel as `markInferred`, in the turn that finishes handling the
  frame's result. The `releaseNativeLease` message already exists
  (`worker-protocol.ts`) — this is the same primitive, promoted from an
  optimisation to the contract.
- The bound is a small frame COUNT plus a short deadline, not a budget: hold at
  most `holdFrames` (default 8) and at most `holdMs` (default 600). Above
  either, drop the oldest and count it. Eight 4K frames is ~200 MB *peak*, and
  it is peak, not steady state — the steady state is `inferenceLatency × fps`,
  measured at 40–160 ms × ≤25 fps = 1–4 frames.
- `nativeLeaseBudgetMb` survives as the OOM ceiling only. Its job stops being
  "how much history do we keep" and becomes "the number above which something is
  wrong".

This alone returns ~800 MB per busy 4K decode worker. It also makes the failure
mode legible: a hold that overflows is a runner that is not keeping up, which is
a different sentence from "the crop was late".

### 3.2 R2 — the tile lease (this is the "sync-crop local")

**At the moment the runner has a `FrameResult`, the frame is still alive (R1).
That is the last instant at which native pixels for that frame exist. Spend it.**

For each surviving detection in the result, the runner asks the worker for ONE
**native tile**: the detection box, padded generously and even-aligned, cut and
JPEG-encoded *in the worker process*, and returned as compressed bytes. The
worker then frees the frame. The tiles go into a per-device, byte-bounded,
long-TTL `TileStore` on the runner node, keyed `(frameId, detectionIndex)` and
carrying the tile's exact rect in frame-pixel coordinates.

Every later native-crop request for that frame is served by re-cutting the
requested rectangle **out of the tile** instead of out of a frame that no longer
exists.

Three properties make this safe rather than clever:

- **The tile is a CONTAINER, not a crop.** It is padded wider than any
  model-input rectangle the convention can produce (default padding 0.35 against
  the convention's 0.15). The model-input rectangle is still derived exactly
  once, by `deriveDetailCropRect` through `detail-subtree.ts`'s
  `cutFromFullFrame`, and then cut from the tile raster. There is no second
  convention, no second padding applied to a padded thing
  ([`adr-0052.md`](../decisions/adr-0052.md)).
- **Containment is checked, and a non-contained rectangle is a MISS.** If the
  track's box has drifted beyond the tile, the tile is not stretched, not
  re-padded and not served — the request falls to R3. This is the whole reason
  `native-tile-geometry.ts` exists as a pure, tested module: the failure it
  prevents is silent (a rectangle clamped inside a tile enriches a *different*
  rectangle of the scene, and nothing errors).
- **Cost is proportional to SUBJECTS, not to frames.** A frame with no
  detections costs nothing at all. A 4K person tile at padding 0.35 is roughly
  1.2 MP → ~60–120 KB as JPEG q85, against 24.9 MB for the frame it came from.

Sizing, per busy 4K camera, 2 subjects per frame, 10 admitted fps:

| | today (frame lease) | R1+R2 |
| --- | --- | --- |
| GPU→RAM download | 249 MB/s (whole frames) | ~20 MB/s (tile ROIs only) |
| resident RAM | 1 020 MB (ceiling-bound) | ~35 MB for a **30 s** window |
| retention window | 2.8 s, and the ceiling ate it | 30 s, operator-set |
| cost on an empty frame | 24.9 MB | 0 |

The 30 s window is chosen against the measured ask age (2.2–9.9 s) with an order
of magnitude of headroom, and it is affordable *because* the unit shrank.

**What R2 does NOT serve**: the bounded full-frame native `keyFrame`
(`maxWidth` 1920). A tile is not a frame. Speculatively retaining a 1920 JPEG
per admitted frame would cost 2–4 MB/s per camera and is exactly the
"pay per frame" mistake, one order down. `keyFrame` goes to R3.

### 3.3 R3 — re-decode from the recorded GOP (this is the "GOP re-decode fallback")

Below the tier boundary nothing is held. A late consumer names a `(deviceId,
epochMs)` and the frame is **re-derived from the recording**.

Everything needed already exists:

- `recording.locateSegment(deviceId, profile, epochMs)` → the covering
  segment's `startMs`, or a gap with the nearest covered edge.
- `recording.readGopBytes(deviceId, profile, startMs, epochMs)` → the single
  GOP by mfra byte range. Its payload is `ftyp+moov` (the decoder init) plus one
  `moof`+`mdat` — self-contained and decodable, ~200 KB rather than a whole
  segment (`packages/addon-pipeline/src/recorder/gop-range-read.ts`).
- `StillFrameService`
  (`packages/addon-pipeline/src/recorder/still/still-frame-service.ts`) already
  decodes ONE JPEG near a wall-clock instant from recorded footage, with an
  input seek, a 15 s hard timeout, 3 concurrent decodes and an 8-deep wait
  queue. It reads the LOW profile for the export dialog; the generalisation is a
  `profile` and a `maxWidth`.
- The recorder is `-c:v copy`. **The recorded frame IS the native frame.** No
  quality tier is lost by re-deriving it.

The obligation this creates is the D60 one: a media kind that depends on R3
must **retry until it LANDS**, under a bound, and must log the branch where it
gives up. R3 makes that satisfiable for the first time, because unlike a lease
it does not expire on a clock the caller cannot see — it expires on the
retention policy, which the caller can read.

Two things R3 must be honest about:

- **Availability.** A camera with no recording covering that instant cannot be
  served. The refusal is a distinct outcome (`no-footage`), not a generic miss,
  and it must not be retried into the ground.
- **Finalisation lag.** `locateSegment` answers over finalised segments and the
  default `segmentSeconds` is 10, so R3 becomes able to answer roughly 10–20 s
  after the moment. That is *fine* for its consumers (key-frame catch-up runs
  over a track's life; the rebuild runs days later) and it is why R2's 30 s
  window is sized to overlap it. There is no hole between the tiers.

### 3.4 The "encoded presentation tier" — recommended NOT to build in v1

The third name in the task is an encoded (still-compressed, not yet decoded)
retention tier, i.e. keeping N seconds of the camera's own bitstream so a past
frame can be re-decoded without touching the disk. The substrate exists:
`StreamBroker` keeps a 10 s `EncodedRingBuffer` prebuffer, plus an optional
`clipBuffer` whose duration is already operator-settable
(`packages/addon-pipeline/src/stream-broker/stream-broker/encoded-ring-buffer.ts`).

It is nonetheless the one piece to leave out, for a reason that is not
aesthetic: **R2 covers 0–30 s and R3 covers 10 s–retention, so an encoded tier
would be a third mechanism serving a window that is already covered twice.** It
also does not come free — for RTP sources (i.e. every RTSP and Reolink camera
here) `preBuffer` is deliberately EMPTY, and the only encoded retention is the
current GOP; filling it would change what a late-joining WebRTC viewer is
flushed on every camera, which is a live-path regression bought for a
maintenance feature.

Build it only if the post-R2 metrics show a hole: cameras where recording is off
*and* the tile window is too short. That is a measurement, not a prediction.

### 3.5 Where each consumer lands

| Consumer | Today | After |
| --- | --- | --- |
| detail plane, per-track enrichment | `frameHandle` → ≤640 `frameJpeg` → `cropJpeg` | R0/R2 native → ≤640 `frameJpeg` (unchanged as the ordinary fallback) |
| confirmation gate `captureCrop` (native-strict) | native or `null` | R0/R2 native or `null` (the D38 display fallback unchanged) |
| `keyFrame` (native-strict, ≤1920 full frame) | native or a warn-and-drop | R0 native → **R3** re-decode, under the D60 bound |
| `thumbnail` / `snapshot` / `firstFrame` / `lastFrame` | native → ≤640 | unchanged; R3 available as the last catch-up rung |
| embedding rebuild (stored tracks) | stored `keyFrame` or `missingKeyFrame` | stored `keyFrame` → **R3** at the best event's timestamp → `runStatelessStep({frameJpeg})` |

The last row is the one that closes the 21.7%: a key-frame-less track stops
being unrecoverable and becomes "recoverable while the footage exists".

> **2026-08-20 — the tier a reply came from is now honest end-to-end.** The
> serving tier travels the analytics transport (`NativeCropRgb.tier`), and the
> subject-crop fetch (`getNativeCropJpeg`: `crop` / `thumbnail` / `faceCrop` /
> `plateCrop`) refuses a `ram-fullframe` reply with a warn, reusing the
> keyFrame's `keyFrameAcceptsTier`. The reachable path it closes: the runner
> classifies "full frame" from the BBOX, so a 16:9 thumbnail window of a large
> subject covering the whole raster skipped the native lease entirely and was
> served from the ≤640 RAM store — a best shot stored at detection resolution,
> indistinguishable from a native one unless the tier is read. An ABSENT tier
> is still accepted (a pre-tier runner in a mixed cluster). The ≤640 rung
> remains the honest fallback wherever the table above says "≤640"; the
> refusal binds only the native-strict kinds' own fetch.

---

## 4. Why this does not break the rules it touches

- **[`adr-0009.md`](../decisions/adr-0009.md) / [`adr-0018.md`](../decisions/adr-0018.md)
  (no frames across a process boundary at frame-rate).** R2 makes this *more*
  true: the tile cut and the JPEG encode happen in the worker child that owns
  the pixels, exactly as today's `handleNativeCrop` does, and what crosses is
  compressed and subject-sized. R3's GOP bytes are already compressed, fetched
  on demand, at a rate measured in requests per minute. Nothing new is
  streamed.
- **[`adr-0052.md`](../decisions/adr-0052.md) (one crop derivation).** The tile
  rect is a container, not a model input, and it is never fed to an encoder.
  The model rectangle is still derived once, by the one owner, from the
  cluster-wide convention. `native-tile-geometry.ts` computes a *container* and
  must never be imported by an encode path — see §7 for the guard extension
  that keeps this from being an honour system.
- **[`adr-0056.md`](../decisions/adr-0056.md) (`runStatelessStep`).** R3 feeds
  it a FULL frame as `frameJpeg`, never a pre-cut tile, with a pinned `modelId`
  and a `nodePin`. Unchanged contract; new source of pixels.
- **[`adr-0060.md`](../decisions/adr-0060.md) (retried until it lands).** R3 is
  what makes the retry terminate in a landing instead of in an expiry. Its
  bound (attempts × min gap × priority) stays; only the source changes.
- **[`adr-0075.md`](../decisions/adr-0075.md) (admission).** Unchanged. The
  `inferred` filter still decides which frames are held at all, and
  `leaseUnmarkedCrops` still checks the premise.
- **CLAUDE.md logging rule.** Every new line carries `tags: { deviceId }`, and
  every branch that drops work — hold overflow, tile containment refusal, R3
  `no-footage`, R3 queue overflow — logs it.

---

## 5. Budgets

**Memory.** Per busy 4K camera, steady state:

| | frames held | bytes |
| --- | --- | --- |
| R1 hold (steady) | 1–4 | 25–100 MB |
| R1 hold (bound) | 8 | ~200 MB peak |
| R2 tiles, 30 s @ 2 subjects × 10 fps | 600 tiles | ~35–70 MB |
| today's lease | 43 | 1 020 MB |

Node-wide, R2 needs a per-device floor and a global ceiling for the same reason
`RetainedFrameStore` does — a busy neighbour must not evict a quiet camera's
tiles. Reuse that store's shape (per-device floor, global byte budget,
oldest-first eviction above the floor); do not invent a second eviction policy.

**Latency.** R2 adds, on the detection process, per surviving detection per
admitted frame: one ROI download (~1–2 ms at tile size) plus one JPEG encode
(~2–4 ms). At 2 subjects × 10 fps that is 60–120 ms of CPU per second per
camera, i.e. 6–12% of one core — and it *replaces* a 24.9 MB full-frame
download that currently happens 10 times a second on the same process. Net
expected: down. It must be measured, not assumed, and it must be bounded: at
most `maxTilesPerFrame` (default 4, highest-confidence first) and a per-device
tile budget; anything shed is counted and logged.

R3's budget is the one that needs discipline, because it is a decode:

| step | cost |
| --- | --- |
| `locateSegment` | index in RAM, ~1–50 ms (hydration may add I/O) |
| `readGopBytes` | ~200 KB ranged read, ~10–50 ms warm |
| decode to the target frame | keyframe-only: one frame, ~30–80 ms · walk-to-offset: up to a full 4 s GOP, 0.3–1.5 s |
| JPEG encode ≤1920 | ~10–20 ms |

Bounds, non-negotiable: ≤2 concurrent R3 decodes per node, a bounded wait queue
that REFUSES rather than grows, a hard per-request deadline, and never on the
live frame path. `StillFrameService` already ships 3/8/15 s; adopt its shape.

---

## 6. Phasing — what is addon-deployable and what needs a train

The dividing line: `packages/types` (every `*.cap.ts`) travels inside the
published `@camstack/server` closure, so **any new cap method is a train**.
Everything inside `packages/addon-pipeline` and `packages/addon-post-analysis`
ships with `camstack deploy`.

**Phase 1 — R1 + R2. Addon-only, no train.** All of it lives in
`session-decode/**` and `pipeline-runner/**`, and `getNativeCrop`'s cap
signature (handle + bbox + maxWidth + encodeJpeg) does not change: the tile is
an internal source, invisible on the wire.
1. `native-tile-geometry.ts` (landed with this doc — pure, tested).
2. `TileStore` — per-device floor + global byte budget + TTL, modelled on
   `RetainedFrameStore`.
3. Worker: `cutTiles(frameId, rects[])` on `worker-protocol.ts`, returning
   compressed tiles; `frameDone(frameId)` release; hold bound + counters.
4. Runner: request tiles at `FrameResult` time; serve `getNativeCrop` from
   `TileStore` when the frame is gone and the rect is contained; extend the
   miss reasons with `tile-not-contained` and `tile-evicted` so the existing
   `native crop miss` line keeps answering "why".
5. Metrics: `tilesCut / tileBytes / tileHits / tileMisses / holdOverflow` on the
   session-decode line, per device.

**Phase 2 — R3 via the EXISTING cap. Addon-only, no train.**
`pipeline-analytics` calls `ctx.api.recording.locateSegment` +
`readGopBytes` and decodes the single frame in its own process (it already
spawns ffmpeg for notification media and timelapse previews). Consumers: the
`keyFrame` catch-up's last rung, and `loadRebuildSource`'s `keyFrame: null`
branch. This is the phase that closes the 21.7% inflow *and* makes the existing
gap partially recoverable while footage lasts.
*Verify first:* that an addon→addon `ctx.api.recording.*` call is not blocked by
the cap's `auth: 'admin'` — if it is, Phase 2 moves into Phase 3.

**Phase 3 — R3 done properly. Needs a train.** A `recording.extractStill({
deviceId, profile, epochMs, maxWidth })` cap method wrapping a generalised
`StillFrameService`, so the decode happens next to the bytes and only a JPEG
crosses. Retire the Phase-2 GOP-bytes hop. Land it on the same train as task 21
(motion-start pre-roll) — they are the roadmap's declared structural pair and
both touch the same frames.

**Phase 4 — retune and reclaim.** With R2 live and measured, cut
`nativeLeaseBudgetMb` 1024 → 256 and re-measure worker RSS with a grid open.
Then decide §3.4 (encoded tier) on evidence.

---

## 7. Risks, and what would falsify this

| Risk | Why it is real | Mitigation / falsifier |
| --- | --- | --- |
| **Tile containment silently wrong** | a clamped rectangle enriches a different part of the scene and nothing errors — the exact shape of the D52 defect | containment is a pure, tested predicate; a non-contained rect is a MISS, never a clamp; the guard extension below |
| **Sync-crop CPU on the detection process** | the detection group is already the hottest process on the node | bound tiles/frame, count sheds, measure `frameMs` before/after on 104 and 101; the fallback is `maxTilesPerFrame: 1` |
| **R1 hold hides a slow runner** | holding until the result means a slow result holds RAM | hard frame-count + deadline bound, overflow counted and logged at warn |
| **R3 clock skew** | `FrameResult.timestamp` is wall-clock on the DETECTION node; segments are stamped on the RECORDER node. `FrameHandle.pts` is documented process-local and must not be correlated | v1 accepts ±1 GOP for presentation kinds; for the rebuild, re-run the root detector on the decoded still and accept the frame only if a box matches the stored one by IoU. If skew proves large, the answer is a pts↔wall map in the recorder index, not a wider tolerance |
| **R3 CPU contention** | a 4 s 4K GOP walk is expensive and the recorder node is also writing | ≤2 concurrent, bounded refusing queue, hard deadline, priority below every live capture |
| **R3 unavailable** | motion-band-only cameras have no footage at that instant | `no-footage` is a distinct terminal outcome, counted per device, never retried into the ground |
| **The rebuild pass is still broken upstream** | `listTrackIds` paging bug (roadmap) and per-device retention has already pruned most old embeddings | fix the paging before any pass; do not judge R3's yield on a pass that re-reads page 1 |
| **Two knobs that disagree** | this repo has shipped that twice | `nativeLeaseTtlMs` STOPS being a retention window when R1 lands. Either it is removed, or it is redefined and its help text rewritten in the same commit. It must not survive meaning something it no longer does |

**Guard extension to write with Phase 1** (`scripts/check-clip-crop-single-owner.ts`):
add `native-tile-geometry.ts` to a new third list — a module that computes a
CONTAINER rect, which may not be imported by any encode path and may not import
an image library. The existing four checks stay. Without it, "the tile is not a
crop convention" is an honour system, and this repo has a rule about rules
nothing checks.

**The test that must fail when the fix is removed** (CLAUDE.md working style):
a spec that stores a tile for box A, asks for a crop of box B outside it, and
asserts the result is a MISS with `tile-not-contained`. Delete the containment
check and it must go green-to-red.

---

## 8. QUESTIONS FOR THE OPERATOR

Grouped, with the recommendation. None of these blocks Phase 1.

1. **Tile window (R2): is 30 s fine?** The measured age of the request is
   2.2–9.9 s. 30 s costs ~35–70 MB per busy 4K camera, against today's
   1 020 MB. *Recommendation: 30 s, cluster-wide like the other conventions
   (same idiom as D52), revisable after a week of metrics.*
2. **Lease budget after Phase 1: do we drop from 1024 MB to 256 MB?** With R1+R2
   the lease serves only as an anti-OOM ceiling. *Recommendation: yes, but in
   Phase 4, after 24 h of `tileHits/tileMisses` metrics — not in the same deploy.*
3. **Does `nativeLeaseTtlMs` survive or go away?** With R1 it is no longer a
   retention window. *Recommendation: remove it together with R1. A knob that no
   longer means what it says is worse than no knob — this repo has already
   shipped two switches that wrote a store nobody read.*
4. **R3 depends on recording.** Cameras in "motion only" band have no footage
   at the requested instant and can never have the `keyFrame` recovered.
   *Question: on which cameras does enrichment matter enough to justify a
   continuous recording band? Recommendation: start with 101 and 102 (the two
   we always measure on) and look at the `no-footage` rate on the others
   before changing policy.*
5. **Historical backfill of the 790 tracks without `keyFrame`: do we want it?**
   Many are older than the current retention, so the footage is gone.
   *Question: is a one-off pass over those still covered worth it?
   Recommendation: NO for now — first close the inflow (Phase 2) and fix the
   rebuild's pagination bug; the backfill is judged with a number, not with an
   intuition.*
6. **Time tolerance on R3.** Do we accept ±1 GOP (~4 s) for `keyFrame` and
   presentation media, with an IoU check for re-embedding?
   *Recommendation: yes for v1. A pts↔wall-clock map in the recorder's index
   is the right answer but it is structural work, and it is done only if the
   measured skew requires it.*
7. **Encoded tier (§3.4): do we build it?** *Recommendation: no in v1 —
   R2 and R3 already cover that window twice over, and filling the `preBuffer`
   for RTP sources would change the live behaviour of every WebRTC viewer.
   Reopen it only if the metrics show a real hole.*
8. **Train order.** Phases 1 and 2 are addon-only and can start right away;
   Phase 3 (new cap method) is a train. *Recommendation: Phase 3 on the
   same train as the pre-roll (task 21), as already planned in the roadmap
   ("structural pair").*

---

## 9. What landed

**R1 — the hold.** `NativeLeaseStore` lost its TTL and gained a frame-count
bound plus an `overflowCount`; the hold now ends on an EVENT (`cutTiles` /
`releaseNativeLease`) and the bound only catches a runner that stopped
answering. `nativeLeaseTtlMs` is gone from `packages/types`, the orchestrator's
settings UI, the fork env and the worker — replaced by `nativeLeaseHoldFrames`
(default 8). `nativeLeaseBudgetMb` stays at 1024 and is now documented as the
OOM ceiling and nothing else; cutting it is a separate, measured change.

**R2 — the tile lease.** `native-tile-store.ts` (byte- and TTL-bounded, 30 s),
`native-tile-geometry.ts` (container rect + the containment predicate +
`selectTileForRect`), a `cutTiles` worker request, `handleCutTiles` /
`serveFromTile` / `serveTileFallback` in the decode worker, and
`pipeline-runner/tile-cut-plan.ts` + the `onResult` hook that dispatches it.
New operator knob `nativeTileBudgetMb` (default 64 MB, `0` disables). Metrics:
`holdOverflow`, `tilesCut`, `tileHits`, `tileMisses`, `tileCutFailures`,
`tileMb`, `tileFrames` on the session-decode line, per device.

**R3 — recorded re-decode.** `pipeline-analytics/recorded-still.ts` (policy,
bounded at 2 concurrent, refusing rather than queueing, four named refusals) and
`recorded-still-ports.ts` (the recorder's READ surface — `getDeviceConfig`,
`locateSegment`, `readGopBytes` — plus one bounded ffmpeg reading the fragment
off stdin). Wired into ONE caller: the embedding rebuild's `keyFrame === null`
branch, which now reports `recoveredKeyFrame` separately from `missingKeyFrame`.
`missingKeyFrame` has changed meaning and its docblock says so: it is a
RETENTION question now, not a capture one.

**The guard.** `scripts/check-recorded-still-off-delivery-path.ts`, wired into
CI, fails the build if the notification centre or the capture scheduler imports
the recovery service. Verified both ways.

Still unwired, and still deliberate: nothing calls `estimateTileBytes` (the
store corrects its tally with the real encoded length). Phase 3 and the encoded
tier (§3.4) are not built.

## 10. Why R2 cut zero tiles until 2026-08-14

R2 shipped and `tilesCut` stayed at 0 on every node, with
`subject tile cut FAILED … Cannot find package 'sharp'` behind it. The tile is a
JPEG, the encoder is `sharp`, and `sharp` is a HOST-EXTERNAL: an addon leaves it
unbundled and the framework provides it through the ESM resolver hook
`registerFrameworkResolver` installs **in the addon-runner process**. The decode
worker is not that process — it is a plain `child_process.fork`, which inherits
the environment but not the loader hooks, so a bare `import('sharp')` inside it
has nothing to walk up into. `node-av`, in the same file, had carried an explicit
path fallback for exactly this reason for months; `getSharp()` had a bare import.

Two things were wrong and both are fixed:

- **Resolution.** `shared/host-external-import.ts` now owns the fallback for BOTH
  packages: bare specifier first, then `CAMSTACK_FRAMEWORK_DIR`, the Electron
  bundle roots, and finally the process cwd — the last one because
  `CAMSTACK_FRAMEWORK_DIR` is exported only on some boots while the launcher
  ALWAYS puts the framework on `NODE_PATH`, and a CJS-style
  `createRequire(...).resolve` honours `NODE_PATH` where an ESM bare import does
  not. Verified both routes independently against a `dist/` with no
  `node_modules` ancestor, i.e. the container's real shape.
- **Cost of failing.** `lazy-sharp.ts` used to CLEAR its memo on any failure, so
  every subject of every frame re-entered the module loader — a synchronous
  `Atomics.wait` on the frame path — and logged: 3 800 WARN/min cluster-wide. A
  RESOLUTION failure is now sticky (one `SharpUnavailableError`, one WARN naming
  every candidate tried, no further loader entry), while a LOAD failure (found,
  but the native binary threw) stays retryable so a deploy blip does not poison
  a runner for its lifetime. `handleCutTiles` resolves the encoder once per frame
  instead of once per subject and reports the drop through `tileCutFailures`.

The knob to re-examine after this lands is NOT `nativeTileBudgetMb` (64 MB of
JPEGs is a lot of subjects): it is `nativeLeaseBudgetMb`, still 1024, which is
what actually bounds the worker's RAM now that a hold ends on an event.

## 11. The second reason a tile could not be cut: two planes, not three

With the encoder resolving, the tier cut tiles everywhere except **dev:102**
(macmini, Electron runner), which reported `subject tile cut FAILED — retained
frame missing planar YUV420P data` 533 times across a handful of sessions.

The software crop offsets the retained frame's plane pointers to the crop origin
and scales only that ROI. That math was written inline against YUV420P — three
planes — and any other layout hit a `!yPlane || !uPlane || !vPlane` guard. A
**NV12** frame has two: Y, plus ONE plane of interleaved (U,V) pairs.

- `planar-crop-source.ts` now owns the offsets for every layout the lease can
  hold, and NV12 is a first-class one. It is not a conversion and not a
  de-interleave: libswscale reads NV12 as a source format, so the crop stays a
  single sws pass, which is what a per-subject-per-frame path needs. Verified
  against real libswscale on videotoolbox — a crop at x=0 of a half-dark frame
  comes back black and at x=32 comes back white, so the pair-aligned chroma
  offset (`left`, not `left/2` — an NV12 chroma column is two bytes) is checked
  by the picture and not only by arithmetic.
- The scaler cache key carries the SOURCE format (`nativeCropSourceTag`), so a
  three-plane scaler can never be handed a two-plane frame from a cache slot it
  aliases. `yuv420p` keeps the historical unprefixed key byte-for-byte.
- A format this path still cannot read is now NAMED (`unsupported pixel format
  <n> (planes=…, hw=…)`). The message it replaces asserted YUV420P and never
  said what it had actually been given, which is why 533 identical lines
  answered nothing.
- Tile-cut failures log on TRANSITION, not per subject: the count stays on the
  metrics line (`tileCutFailures`, per device) where volume belongs, and a
  standing cause costs one line instead of one per subject per frame.

## 12. The third one: the frame died between two subjects

dev:1443 (hub runner) then reported `retained frame in unsupported pixel format
-1 (planes=0, hw=false)` — `AV_PIX_FMT_NONE`, nothing behind it. That is a
node-av frame whose `free()` has already run, and the format-naming from §11 is
what made it legible in one line.

**The mechanism.** `handleCutTiles` held a JS reference to the retained frame
across the `await` of each subject's JPEG encode. A JPEG encode is real async
work, so the worker services more IPC while it runs — and the message it is most
likely to service is a `pull`, whose delivered frame reaches
`captureNativeFrame` → `NativeLeaseStore.put`, which evicts the OLDEST held frame
to stay inside `holdFrames` / the byte budget. On a busy camera the oldest held
frame is the one being cut. So the tier cut the first subject of a frame and lost
the rest. `handleNativeCrop` was never exposed: it is synchronous from `get` to
the pixel read.

**The fix is ordering, not detection** (`subject-tile-cut.ts`). Every pixel read
now happens in ONE synchronous turn — `extractSubjectTiles` cannot await, so no
free can interleave with it — and the encodes then run off copied bytes. A
liveness check before each read is kept as an ASSERTION of that invariant (and
it is what turns a frame that was already dead on arrival into a counted miss),
but it is not the mechanism: a check is not a lock, and between turns it would
only narrow the window.

**No generation counter, for two independent reasons.** The store is keyed by a
monotonic `frameId` and `drop()` removes the entry in the same statement that
frees it, so `get(frameId)` can never return a recycled frame under an id it did
not belong to — the "tile of the wrong frame" hazard needs an aliasing the store
cannot produce. And after this change there is no window in which a held
reference can change at all.

**The hold is still released once, after `tileStore.put`.** Releasing at the
extract/encode boundary was tried and reverted: it buys back one frame's raster
for a few milliseconds and opens a window in which a crop for that frame can be
served by neither the lease nor a tile. A miss is the failure this tier exists to
remove; the RAM is not worth it.

## 13. The one that came FIRST: a frame's hold cannot depend on another camera's eviction

Chronologically this precedes §§10–12 — it is the same evening R1+R2 shipped —
and it is the most expensive of the four, because it did not merely fail to cut
tiles: it broke the hold.

`tilesCut: 0` on every camera, `holdOverflow` climbing ~80 per 10 s and
`leaseFrames` pinned at the bound of 8. The hold NEVER released, so the
retention window collapsed from ~2.6 s to ~1 s, every late enrichment crop
missed, and the recognisers' per-frame retries turned that into 325–434 capture
requests/min per camera — hub-main into D-state and tRPC from 0.15 s to 6.5 s.

**The cause.** The cut was dispatched by looking the cutter up in
`NativeCropRegistry`. That is a NODE-WIDE LRU capped at 256, shared by every
camera, whose reason to exist is serving LATE cross-process crops; measured on
the hub during the incident it sits pinned at `registrySize=256
registryCap=256`. So an entry's lifetime is a function of how busy the OTHER
cameras are, a frame's own result could not find its own cutter, and the frame
was never freed. **Ending a frame's hold is a per-frame lifecycle event** and now
rides a per-frame binding made at DELIVERY (where the requester is already in
hand) and consumed at the result — bounded at 256 with the oldest RELEASED
rather than dropped, so a result that never comes back (shed, inference timeout,
detach mid-flight) still frees its frame. That is what keeps `holdOverflow`
meaning "the runner stopped answering" instead of "the runner forgot".

**The second defect is why this took an operator to find: both early returns
were SILENT.** A method whose entire job is to release a frame returned without
a word when it could not, while its own metrics line printed `tilesCut: 0` with
no explanation anywhere in the logs. Every non-dispatch is now counted per
camera by reason (handleless / unbound / threw) and warned once a minute.

**The spec drives the production condition, not the coordinator**: 256 frames
from another camera arrive while one frame waits for its result, and the
registry lookup is asserted to FAIL where the per-frame binding survives. The
specs that existed before all drove `image.cutTiles(...)` directly — which is
exactly why they were green while the runner between them never called it.

Mitigation during the incident, since superseded by the fix but worth knowing
the shape of: `nativeLeaseHoldFrames: 64` (the byte budget then binds again at
~21 frames, restoring the pre-change window) and `nativeTileBudgetMb: 0`, both
written to the GLOBAL `pipeline-orchestrator` settings with the runners
restarted per node. tRPC recovered 6.5 s → 0.15 s.

## 14. The ordinary keyFrame path never uses the hold as designed (2026-08-26)

Full analysis: [`2026-08-26-native-frame-hold-lifetime.md`](2026-08-26-native-frame-hold-lifetime.md)
(read-only, live traffic, no code changed). It corrects a reading of this
document rather than a defect in it — §13's fix was real and necessary, but it
fixed the TILE cut's reliability, not the hold's usefulness to a late
full-frame request.

**The mechanism.** `pipeline-runner/index.ts:1061-1062`, the runner's result
callback:

```ts
this.runner.onResult(async (deviceId, frame, result, _streamType, handle) => {
  this.retention?.noteInferenceResult(deviceId, handle, result)
  this.cutSubjectTiles(deviceId, result, handle)   // → cutTiles → leaseStore.release()
  this.emitInferenceResult(deviceId, frame, result, handle)   // ← the ask starts HERE
  …
```

`cutSubjectTiles` (§3.2's R2 cutter) ends the R1 hold in its `finally` —
**including when there are zero detections**, i.e. on the majority of frames —
and it runs BEFORE `emitInferenceResult`, whose downstream effect (reaching
`pipeline-analytics`, deciding to retry a `keyFrame` capture) is what
*produces* the late `getNativeCrop` ask in the first place. So **the release
is always dispatched before the request that needs the frame is born**;
`holdFrames` (default 8, §9) never governs this path at all. It cannot: a
key-frame hit can come from neither the tile tier (`serveFromTile` needs the
rectangle CONTAINED, and a full frame is contained by nothing) nor the
reserved slot (resolves only the newest delivered frame). The only remaining
source is a lease entry whose `release()` was a no-op because the frame had
not yet been `put()` into the store — a frame enters the hold roughly one
delivered-frame gap (~130-170 ms) after delivery (`FrameSlot.reserveSlot()`
puts the *previous* frame), so a release racing a not-yet-admitted frame
leaves an entry that nothing will ever release again except the hold's own
count/byte bound. **Every key frame that lands today lands off that orphan**
— measured 2026-08-26: `holdOverflow / leaseAdmitted = 0.667`, `leaseFrames`
pinned at the `holdFrames` bound, fleet key-frame landing 49.9% (1 569 / 3 142
attempts over 12 h), `ramTier` **0** on every camera (§4.1 of the companion
doc: the RAM rung is refused by `keyFrameAcceptsTier` by design, so it could
never have served one regardless).

**Do not "fix" the orphan.** Making `captureNativeFrame` decline a frame
already released — the obviously-correct-looking cleanup — would drop
`leaseFrames` to ~1, hand back ~190 MB per worker, and take key-frame landing
from ~50% to ~0%, because the orphan is the only thing serving it. This also
means §5's "R1 hold (steady): 1-4 frames" sizing table describes the
BOOKKEEPING model, not what is currently relied upon in production for a late
`keyFrame` ask.

**What the companion doc recommends instead** (ranked by cost, detail there):
raise `nativeLeaseHoldFrames` from 8 toward 21 so the EXISTING `budgetMb`
ceiling (512 MB, already documented above as a safety ceiling with headroom
never used) binds before the count does — this is a settings change with no
new RAM reservation, because `holdFrames` is not a term in
`decodeWorkerFootprintMb`. It turns the accidental orphan into something
closer to the intended session-scoped hold, rather than requiring the
"encoded presentation tier" or a protocol change. Two further findings worth
carrying back into this document's own claims:

- **§9's "servedTier: ram-fullframe" framing needs the same correction made in
  [post-analysis.md](../architecture/post-analysis.md#media-capture):** it is
  a PERMISSION the pixel resolver grants itself before trying the RAM store,
  not proof the RAM store answered. Of 37 938 such permissions logged in the
  12 h window, 39 596 `native full-frame miss` lines followed — within 1.4%,
  every permission ended in a miss.
- **The capture-scheduler tail is a separate, measured contributor**, not
  covered by this document at all: the per-device lane (budget 3 execs, queue
  cap 24) sheds 33% of all capture requests fleet-wide, and a `keyFrame`
  request carries no `staleAfterMs`, so a saturated lane makes it late rather
  than dropping it cheaply. See [post-analysis.md](../architecture/post-analysis.md#media-capture)
  for the capture-scheduler queue-bound fix that landed 2026-08-25 (a
  different, additive fix — the per-device QUEUE bound; the lane's in-flight
  budget and per-kind `staleAfterMs` are unchanged).


## 15. The rung this design left out: the FULL-FRAME request (2026-08-27)

R2's serve gate is strict containment — a rectangle no tile contains is a miss,
never a clamp — and that is correct and must stay. Its consequence was not
thought through: **a full-frame rectangle is contained by no SUBJECT tile**, so
the moment R1's hold became event-scoped, every consumer that asks for the whole
frame lost its last rung. Those are the native `keyFrame`
(`getNativeKeyFrameRgb`, bbox `{0,0,1,1}`, `maxWidth 4096` — the only image the
semantic rebuild reads), the detail plane's `runDetailSubtree({ frameJpeg })`
rung, and the display-crop full-frame fallback.

The measurement, over 24 h on the live cluster, and it is unambiguous about
which of the four candidate causes is dominant:

| Signal | 24 h | Reading |
| --- | --- | --- |
| `key-frame capture (window)` `attempts` / `landed` | 3 750 / 2 868 | 23.5% of captures produce nothing |
| … `nativeMiss` | **874** | the fetch returned `null` |
| … `ramTier` | **3** | the ≤640 store almost never answers either |
| … `error` / `skippedNodeOffline` | 5 / **0** | routing and node-offline are NOT the cause |
| `native full-frame miss` at `maxWidth 4096`, `worker-lease-gone` | **855 (95.7%)** | the worker was reached, answered, and no longer had the frame |
| … `no-registry-entry` | 38 (4.3%) | an actually evicted/recycled handle — the minority |
| handle age at that miss | p50 **367 ms**, p75 1.0 s, p90 4.3 s, p99 15 s | not a late request; an early release |

Per-device `nativeMiss` matched the operator's report exactly (104→237,
102→162, 1443→141, 101→108), and the worker's own counters close the loop: on
dev:104 at `ageS:1560`, `nativeCropMisses:328` with `tileMisses:328` — *every*
miss reached a live worker and failed containment. So the frame is gone because
§4 releases it at its `FrameResult`, not because a slot was recycled.

**A longer hold cannot buy it.** `leaseMb:190, leaseFrames:8` puts one 4K raster
at **23.75 MB**; the admitted rate is ~2.1 frames/s; concurrency measured 4.3
sessions typical, 12 peak. Ten seconds of raster is `21 × 23.75 MB ≈ 498 MB per
camera`, ~6 GB at peak — the D9/D18 OOM, and the exact thing §2 exists to have
stopped paying.

**R2b — the SCENE tile** is therefore the same trade as R2, one rectangle wider:
one JPEG of the WHOLE native frame, cut in the same synchronous read phase as
the subject tiles (`scene-tile.ts` `planFrameCuts` appends `{0,0,1,1}` to the
one cut — a second pass after an encode `await` is the §12 eviction race), on
detection-bearing frames only (~0.4/s, not 2.1). ~1.5–2.5 MB instead of
23.75 MB: the operator's ten seconds costs ~10–25 MB a camera.

Four decisions, each of which could have been made the other way:

1. **Its own `NativeTileStore` instance under its own knob**
   (`nativeSceneBudgetMb`, default 48). A scene tile is ~20× a subject tile;
   one shared budget would let key frames evict the face/plate tiles the
   recognisers live on. Two stores make that impossible rather than unlikely.
2. **Budget exhaustion evicts the OLDEST scene, it does not refuse the newest.**
   At p50 367 ms the newest tile is the likeliest to be asked for. Every drop is
   counted (`sceneEvicted`); a non-zero value is the signal that the budget, not
   the TTL, is what bounds the window.
3. **Expiry is the store's TTL** (`CAMSTACK_SESSION_NATIVE_TILE_TTL_MS`, 30 s) —
   the existing constant, not a second one — plus `clear()` on every re-dial and
   teardown. A track that never closes therefore cannot pin anything.
4. **The subject store is asked first.** Both rungs are native-resolution and
   either would be honest, so the order is purely about not re-extracting an
   ordinary face crop from the 20×-larger raster.

`tileBudgetMb: 0` no longer silences the scene rung: they are independent knobs
and one secretly gating the other is how a slider stops meaning what it says.
