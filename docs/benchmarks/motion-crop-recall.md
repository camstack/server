# Motion-derived cropping vs the full-frame pass — measured on camera 101

Measured 2026-09-07 on **camera 101 (Camera front door)**, against
**agent-a** — the node that actually runs 101's detection — with
**`yolov9m-320-int8` / python+openvino**, that node's production detector. The
model id was pinned on every call and verified against what the node echoed
back, so no delta here can have been produced by a different model.

Harness: `scripts/motion-crop-recall-eval.mts` (what it measures and how to
re-run it are in its docblock). Inputs: `scripts/motion-crop-recall/`. Raw
results and frames stay under `scratchpad/motion-crop/` (gitignored).

## Why not the replay subsystem

`packages/addon-benchmark/src/replay/` replays a camera's resolved step tree over <!-- drift-ok: names benchmark code removed by D792 -->
recorded footage under an explicit operator overlay, and it refuses a run whose
model would be silently substituted — the right shape for this question. It
**cannot express it**: the decode is scale-only
(`replay-decode.ts`: `fps=<n>,scale='min(maxWidth,iw)':-2`, no crop filter, no
ROI), and `ReplayOverlay` has exactly three fields — `packageZone`,
`stepSettings`, `stepModels` — none of which is a rectangle the detector runs on.
(`packageZone`'s rectangle is in fact dead: `applyPackageZoneOverlay` reads only
`hasPackageZone(overlay)`, so the `{x,y,w,h}` never reaches `plan.steps`.) The
harness therefore does its own cutting and calls `benchmark.runPipelineTest`
per pass, pinning `nodeId`, `modelId` and `plane: 'frame'`.

## Method

For each sampled instant, two detector passes over the **same** pixels:

| arm | what it is fed |
| --- | --- |
| **full** | the production content view — a 320 model on a 16:9 camera sees **320×180**, which is what the live path detects on |
| **crops** | the reference NVR's recipe over OUR motion boxes: each region padded **×1.5** about its centre, overlapping regions unioned, **top 3 by area**, grown to the detector's input aspect ratio without ever shrinking, cut from the **full-resolution 3840×2160** frame, no minimum size |

Motion comes from the real `packages/addon-pipeline/wasm/motion.wasm`, on the
real motion view (`MOTION_FRAME_VIEW` = 320×320 contain, gray ⇒ **320×180**),
with the addon's shipped config (`threshold 45, blur 1, dilate 4, minArea 1500`)
and the production inter-frame lag (`motionFps 4` ⇒ 6 frames at 25 fps).

Pixels are full-resolution `recording.readGopBytes` fragments — a byte-range cut
off disk through the segment's own index, no transcode, no scaling.

**Ground truth is a human judgement**, not an inference: contact sheets at 2 s
were read by eye and the presence intervals recorded in
`scripts/motion-crop-recall/ground-truth.json`. Six episodes on 2026-09-07,
spread from 04:41 to 16:29 UTC: small dog on a lead, dog + two people, black dog
entering from the road, a cat crossing alone, a white dog at dawn, a
black-and-white dog. **38 frames** in which an animal is visibly present.

The `discarded[]` array is kept alongside `detections[]`, so a box that existed
but was filtered is counted as a candidate and reported separately at each
threshold — a recovered detection under the gate is not a recovery.

## Result — per episode

An operator is notified once per pass-by, so this is the number a notification
rule feels:

| episode | full ≥0.50 | crops ≥0.50 | full ≥0.70 | crops ≥0.70 |
|---|---|---|---|---|
| E1 16:29 small dog + person | yes | yes | **NO** | yes |
| E2 14:04 dog + two people | **NO** | yes | **NO** | yes |
| E3 15:48 black dog from the road | yes | yes | yes | yes |
| E4 13:34 cat crossing alone | **NO** | yes | **NO** | yes |
| E5 04:41 white dog at dawn | yes | yes | yes | yes |
| E6 09:26 black-and-white dog | yes | yes | yes | yes |
| **total** | **4/6** | **6/6** | **3/6** | **6/6** |

Identical at both motion sensitivities tested. Two of six pass-bys produce
nothing at all today; at the reference NVR's own 0.70 animal gate, three of six.

## Result — per frame

| metric (38 positive frames) | full-frame (today) | motion crops |
|---|---|---|
| an animal box exists at any score | 26% (10/38) | 47% (18/38) |
| survives the production filter chain | 24% (9/38) | 42% (16/38) |
| best animal score ≥ 0.50 (our animal floor) | 24% (9/38) | 42% (16/38) |
| best animal score ≥ 0.70 (the reference NVR's animal gate) | 16% (6/38) | 34% (13/38) |

Score distribution of every animal box on those frames:

- full frame: `n=10 min=0.220 p25=0.526 med=0.780 p75=0.854 max=0.892`
- crops: `n=19 min=0.082 p25=0.652 med=0.840 p75=0.861 max=0.914`

The crop arm does not merely find more boxes, it finds **more confident** ones:
the median animal score moves 0.780 → 0.840 and the interquartile band moves off
the floor. That matters more than the count, because the boxes the full-frame
arm does find sit right on top of the 0.50 gate.

## The number that explains everything: motion is the ceiling

The crop arm can only act where the motion step produced a region.

| subset | frames | full ≥0.50 | crops ≥0.50 | full ≥0.70 | crops ≥0.70 |
|---|---|---|---|---|---|
| motion fired | 19 | 42% (8/19) | **84% (16/19)** | 26% (5/19) | **68% (13/19)** |
| motion silent | 19 | 5% (1/19) | 0% (0/19) | 5% (1/19) | 0% (0/19) |

Where motion fires, crops double recall at our gate and nearly triple it at
0.70. Where motion is silent they contribute nothing at all, by construction.

And motion is silent for the wrong reason. Raw (pre-`minArea`) connected
components existed on **35/38** positive frames; only **19/38** survived
`minArea: 1500`. The regions being thrown away are not noise — the largest raw
region on the discarded frames measures **555–1495 px**, clustered just under
the bar:

```
E1 1332, 1219   E2 1065, 1102, 602, 555   E3 1010, 1051
E5 1184, 1086, 655   E6 871, 1049, 1398, 1220, 1495
```

`minArea 1500` on a **320×180** view is 2.6% of the frame. A dog measured
170×87 px at 4K is 14×7 px there. The motion step is not built to see the
subjects this feature exists to recover.

Re-running with `minArea: 500` (everything else identical):

| metric (same 38 positive frames) | full-frame | crops @ minArea 1500 | crops @ minArea 500 |
|---|---|---|---|
| best animal ≥ 0.50 | 24% (9/38) | 42% (16/38) | **74% (28/38)** |
| best animal ≥ 0.70 | 16% (6/38) | 34% (13/38) | **55% (21/38)** |
| motion fired on | — | 19/38 | 35/38 |

The full-frame arm reproduced to the box (26% / 24% / 16%) across two
independent runs hours apart, which is the consistency check on the harness.

## Cost

Measured on agent-a, the node that would run it, per detector invocation:

| | @ minArea 1500 | @ minArea 500 |
|---|---|---|
| extra invocations per frame (mean) | **0.25** | **0.88** |
| crops per frame | 0→79, 1→27 | 0→8, 1→40, 2→2 |
| step latency, full-frame pass (p50 / p95) | 43.1 / 74.4 ms | 41.3 / 76.6 ms |
| step latency, crop pass (p50 / p95) | 65.0 / 97.3 ms | 54.7 / 93.7 ms |
| predict only, full-frame (p50 / p95) | 42.1 / 73.8 ms | 40.8 / 76.0 ms |
| predict only, crop pass (p50 / p95) | 48.2 / 86.5 ms | 45.2 / 75.7 ms |

A crop invocation is **not** cheaper than a full-frame one — same 320 model,
same pool. Predict is within noise of the full-frame pass; the extra ~10 ms in
the step figure is JPEG decode of a larger tile, which a real implementation
would not pay (the decode worker already holds the native surface).

At `minArea 500` the accelerator cost of a motion-window frame roughly
**doubles**: ~41 ms → ~86 ms. That cost is bounded by the motion duty cycle, not
by the frame rate — camera 101 runs `detectionMode: on-motion`
(`reasons.detection = "armed:on-motion"`), so nothing is spent while the scene
is still. The pool is shared across the node's cameras, so the capacity
question belongs to `runCapacityRamp`, not to this measurement.

## The top-3-by-area cap never bound

**On 0 of the 106 (production config) and 0 of the 50 (minArea 500) measured
frames did the cap drop a region.** After the ×1.5 padding and the overlap
union, this camera produces one or two regions per frame, not four. The concern
that the cap keeps the LARGEST regions while a distant animal is the smallest
never materialised here — and the union is why: when the animal walks with a
person, the two padded boxes overlap and merge into **one** crop, so the animal
rides inside the person's region rather than competing with it. When the animal
is alone (E4, the cat) it is the only region there is.

The cap is not the risk on this camera. It could still bind on a camera with
several independent movers; nothing here says otherwise.

## The full-frame guard never fired inside a crop

Zero `full-frame-guard` discards across every crop invocation. The a-priori
worry — a subject filling its own crop looks like a full-frame phantom — did not
happen, because ×1.5 padding plus growing to a square leaves the subject well
short of the frame.

## False positives

This is the number nobody collects, so it was collected deliberately, on
footage chosen to be hostile: **60 real onboard-motion edges on camera 101 with
no object event within 60 s of them** (built by the harness's `fp-windows`
command from `pipelineAnalytics.getMotionEvents` ∖ `getObjectEvents`, and kept
as `scripts/motion-crop-recall/windows-fp.json`), plus 12 minutes of
sparse quiet sampling and 6 minutes scanned at the motion cadence. "Motion
fired and nothing was there" is exactly the case a crop feature is supposed to
be dangerous in.

All at `minArea 500`, the sensitivity the recall section recommends:

| | |
|---|---|
| frames scanned for motion | **3085** |
| frames with ≥1 motion region | **27** |
| crop invocations | **28** |
| boxes above a gate — full-frame arm | **0** |
| boxes above a gate — crop arm | **3** |

| class @ gate | full-frame | crops |
|---|---|---|
| animal ≥ 0.50 | 0 | **0** |
| animal ≥ 0.70 | 0 | **0** |
| person ≥ 0.65 | 0 | 1 |
| person ≥ 0.80 | 0 | 0 |
| vehicle ≥ 0.50 | 0 | 2 |

Every one of the three was inspected by eye:

| when | crop | box | verdict |
|---|---|---|---|
| 01:45 UTC, IR | lower-right quadrant, 1098² | `vehicle 0.749` | **false** — dark hedge and planter, nothing there |
| 03:46 UTC, IR | top-right corner, 990² | `person 0.701` | **false** — empty street corner |
| 08:45 UTC, day | top-right corner, 846² | `vehicle 0.656` | **plausibly real** — a dark vehicle sits at the frame edge; the full-frame pass did not see it |

So: **two unambiguous false positives in 28 crop invocations, and zero false
`animal` boxes** — none in the class this feature exists for. Both false boxes
are at night, in IR, in a corner of the frame, and both would clear the
per-macro floor they were scored against. The reference NVR's 0.80 person gate would have
stopped the person one; nothing would have stopped the 0.749 vehicle.

At the shipped `minArea 1500` the same corpus produces almost no crops at all
(123 sparse frames: 1 motion region, 1 invocation; 1477 cadence-scanned frames:
3 regions), so the shipped configuration has essentially **no** false-positive
exposure and essentially **no** benefit either. The false positives arrive with
the sensitivity, which is the honest trade.

Caveat in the direction that matters: the harness's motion input is a downscale
of the 4K `main` recording, while production motion reads the noisier 640×360
`sub` stream. Real motion fires more often than this proxy — 60 onboard edges
produced only 27 wasm-positive frames here — so **both** the crop count and the
false-positive count above are lower bounds.

## Limits — read these before quoting the numbers

- **Six episodes, 38 frames, one camera, one day.** This is a diagnostic sample,
  not an accuracy dataset. The per-episode 6/6 vs 4/6 rests on two episodes.
- **The motion input is a proxy.** Production motion reads the camera's `sub`
  stream (640×360) and downscales to the motion view; the harness downscales the
  `main` 4K recording instead. Sub-stream compression noise would make real
  motion *more* sensitive, not less, so the crop arm's recall here is a lower
  bound and its false-positive exposure is understated.
- **The tracked-box term of the reference NVR's recipe is not modelled.** A stills
  harness has no live tracker, and ×1.25 around an intersecting tracked box can
  only enlarge a crop — so this arm is conservative for recall.
- **What 101 stores as motion events is the camera's own VMD, not ours.**
  Those rows carry `frameWidth: 0`, the onboard branch's signature, and
  `regionCount: 0`. The WASM analyzer is nonetheless live on this camera:
  `motionSources: []` with `onboardMotionDrivesAnalyzer: true` makes
  `shouldStartOnboardAnalyzer` open the frame-diff subscription in bursts on
  each onboard motion edge, for `motionCooldownMs`. Motion boxes therefore exist
  during active-motion windows — but **only** during them, and nothing persists
  them today.
- **The `full` arm's view is smaller than the live one, and that is not
  neutral.** This page's method says a 320 model on a 16:9 camera "sees
  320×180, which is what the live path detects on". 101's stored boxes are
  exact multiples of 1.2 of 3840 — integers on a **3200 px** raster — so the
  live path hands the pool a much larger picture and the pool's own
  preprocessor reduces it. Measured on one slice in
  [`2026-09-08-101-dog-on-a-lead.md`](2026-09-08-101-dog-on-a-lead.md): feeding
  the same instants at 1280 px instead of 320 moves the first surviving
  `animal` 300 ms later and loses two frames entirely. The `full` arm is
  therefore an **optimistic** proxy for the live full-frame pass, which widens
  the crop arm's advantage rather than narrowing it — but every absolute
  full-frame number on this page should be read with that 300 ms in mind.
- **Camera 101 is not pinned to agent-a.** The session balancer places
  each detection session by capacity, and in the log ring 101's sessions land on
  all three nodes; the Mac agent runs `yolov9m-320` (coreml), not
  `yolov9m-320-int8`. The two configurations were compared frame by frame on
  one episode and agreed, so nothing here is invalidated — but "the node that
  actually runs 101's detection" is a per-session fact, not a property of the
  camera.
- **Ground truth is presence, not position.** Recall is scored as "does an
  `animal` box exist, at what score", the same convention as
  [`pipeline-frame-model-eval.md`](pipeline-frame-model-eval.md). IoU against a
  hand-drawn box is not defensible at these subject sizes.
- **A shed frame is indistinguishable from an empty scene at the call site.**
  Two concurrent harness runs made 20 instants that had returned boxes come back
  empty, with a plausible `predictMs` and no `shed` flag. The harness now
  re-asks a wholly empty result once and the runs are serial. Any future run of
  this harness must stay serial.

## Decision

**ADOPT WITH CHANGES.**

Crops win, and they win by more than the gate width. On the six pass-bys
measured, the full-frame pass reports 4/6 at our animal floor and 3/6 at
The reference NVR's 0.70; motion crops report **6/6 at both**. Per frame, at the
sensitivity that makes the feature work, animal recall goes 24% → 74% at 0.50
and 16% → 55% at 0.70, and the median recovered score moves 0.780 → 0.840 — so
the recovery is not a pile of boxes sitting on the gate. The cost is a mean 0.88
extra invocations per motion-window frame at ~45 ms predict each, spent only
while motion is live on an `on-motion` camera. The false-positive price is two
bad boxes in 28 invocations, both at night, **none of them an animal**.

The three changes, in order of how load-bearing they are:

1. **The motion step is the feature, and it is the part that has to change.**
   Everything else here is downstream of one number: `minArea 1500` on a 320×180
   view discards the regions this feature needs, on 16 of the 19 frames it
   loses. The whole delta between "42% recall" and "74% recall" is that filter.
   Adopting the crop recipe without touching motion sensitivity buys the smaller
   half of the gain — and buys it only inside the burst windows the onboard VMD
   happens to open. Decide `minArea` (and whether the motion view should be
   larger than 320×180 at all) from a measured distribution, per camera, not by
   copying 500 out of this page.

2. **Do not run the crop pass on a still scene, and do not let it replace the
   full-frame pass.** On the 19 positive frames where motion was silent the crop
   arm scored 0% and the full-frame arm scored 5% — small, but not zero, and it
   is the only arm that can see a stationary subject at all. The occupancy
   re-check and the stationary registry both depend on that. Crops are an
   ADDITIONAL pass on motion frames, never a substitute.

3. **Gate the night.** Both real false positives are IR-frame corners upscaled
   into a 320 model. A per-camera or IR-conditional floor on the non-animal
   classes coming out of a crop — or simply not trusting `vehicle` and `person`
   from a crop below the reference NVR's own 0.80 — removes both without touching the
   animal recall, which lost nothing to false positives at any gate.

Two things this measurement says are **not** worth engineering around on this
camera: the **top-3-by-area cap** (it never bound — 0 frames of 156) and the
**full-frame guard firing inside a crop** (0 occurrences). Ship the cap because
The reference NVR has it and it bounds the worst case; do not spend design effort on the
tie-break.

What would change this recommendation: a camera with several independent movers
(where the cap could bind and the invocation count could reach 3/frame), or a
capacity run showing the node cannot absorb ~2× accelerator time during motion
windows. Neither was measured here — the second belongs to
`pipeline-runner.runCapacityRamp`, on a quiet node.
