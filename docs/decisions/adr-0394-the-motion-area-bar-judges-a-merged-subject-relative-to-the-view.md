---
id: D394
title: The motion area bar judges a merged SUBJECT, relative to the motion view — never a component, never an absolute count
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/motion-wasm/**
---

## Context

`docs/benchmarks/motion-crop-recall.md` <!-- drift-ok: the recall report is on the branch that produced it (worktree-agent-a0160034cb846f2d5) and lands separately --> set out to measure whether detecting on
motion-derived crops beats the full-frame pass on camera 101. It does — 4/6
pass-bys become 6/6 — but the report's own conclusion was that the crop recipe
is not the lever:

> Raw (pre-`minArea`) connected components existed on **35/38** positive
> frames; only **19/38** survived `minArea: 1500`. The largest raw region on
> the discarded frames measures **555–1495 px**, clustered just under the bar.
> The whole delta between "42% recall" and "74% recall" is that filter.

Two things were wrong with the filter, and only one of them is the number.

**Shape.** `minArea` was applied to each connected component independently. A
subject that fragments — a dog behind a railing, a body split by a
low-contrast band — arrives as three small blobs and is discarded three times,
even though the subject is three times the bar. Measured on the 101 ground
truth: at a fixed 1500 px bar, judging merged subjects instead of components
takes per-frame recall from 50% to 61% on its own, and 9 of the 37 groups that
pass at the chosen bar are made of more than one component.

**Units.** The bar was an absolute pixel count against a view whose size is not
fixed. `MOTION_FRAME_VIEW` is `content 320×320, fit contain`, so a 16:9 camera
is analysed at 320×180 = 57 600 px and a 4:3 camera at 320×240 = 76 800 px.
`minArea 1500` is 2.60% of the frame on one and 1.95% on the other — the same
number already meant two different things on this hub, and a camera swapped for
one with a different aspect ratio silently re-tuned itself.

What was NOT wrong: nothing about this needed a new event, a new store or a new
per-node setting. Every camera in the fleet reads the schema defaults for all
four motion knobs — checked on the hub, 28 of 28 — so there was no fleet of
hand-tuned values to migrate.

The trap that had to be avoided: merge-then-judge makes a storm WORSE. Wind,
rain and IR noise fragment into hundreds of specks that the merge step is
delighted to coalesce into one enormous group, and there was no storm guard
anywhere on this path to catch it — the only things between a rain frame and a
full detection session were the per-component area filter, optional zone rules,
and a 30 s cooldown that a storm continuously re-arms rather than being limited
by.

## Decision

The motion step merges first and judges second, and the bar it judges against
is relative to the motion view.

1. Components are grown to at least `r × r` about their centre
   (`r = min(viewW, viewH) / mergeRadiusDivisor`) and merged transitively where
   the grown boxes overlap. **The group's rectangle is the union of the
   ORIGINAL boxes**, never the grown ones — a crop derived from a grown union
   inflates by `r` on every side.
2. A group passes when its **summed member pixels** reach
   `minAreaFraction × viewW × viewH`. The relative form is the default and the
   only one that keeps its meaning across a resolution or aspect change.
3. **`minArea` (px) is the rollout switch, and it defaults to what shipped.**
   A positive `minArea` runs the pre-D394 rule in FULL on that camera — this
   absolute bar, per component, no merging, no storm cutoff — and the default is
   `1500`, so installing this addon moves nothing on any camera. An operator
   moves one camera by setting its `minArea` to **0**, which hands it to
   `minAreaFraction` with the storm cutoff live.

   It is one knob because it is one question: which rule does this camera run.
   A separate `useMergedRule` boolean beside a bar that already answers it would
   be a second source of truth, and this repo has shipped two knobs that
   disagreed before ([D62](adr-0062.md)).
   It also keeps the key and the meaning the fleet already has: a stored
   `minArea` keeps doing exactly what the operator who stored it asked for.
4. A group whose changed pixels exceed `maxCoverageFraction` of the view is a
   storm, not a subject, and does not fire motion. **Its components are then
   re-judged individually**, so a person walking through the rain — whose box
   merged into the storm — still fires on their own component, while the rain
   does not. A component that is itself over the coverage bar (an IR cut
   arriving as one enormous blob) does not come back through that door.
5. The geometry lives in one pure function, `groupMotionRegions`, with no I/O
   and no config store, and every case above is pinned by a test.

The end state is still one relative constant for the whole fleet. The path
there is one camera at a time, and it is enforced by the default rather than by
anyone's discipline.

Defaults come from a measured distribution, per camera, and are recorded in
`docs/benchmarks/motion-region-area.md` — never copied from the reference NVR because
The reference NVR uses them. The merge radius divisor IS taken from the reference NVR (1/6),
because it is a merge distance rather than a bar, and the measurement showed the
verdict is insensitive to it between 1/4 and 1/12.

## The shared detector, and what it did to the baseline

`motion-wasm` declares `execution.group: 'detection'`, so `resolveRunnerId`
gives the whole group ONE runner process per node and there is ONE
`WasmMotionDetector` in it, serving every camera on that node. `init(w, h)`
sizes the WASM's linear-memory buffers; the addon called it only when a
CAMERA's own last-seen dimensions changed. Two cameras with different frame
sizes therefore left the WASM sized for whichever called `init` last — and,
since neither's own size then changes, indefinitely.

**This is not benign, and it happened.** Measured on this hub, three frame sizes
reach the analyzer:

| size | where it comes from |
| --- | --- |
| 320×180 | the dedicated motion decode (`MOTION_FRAME_VIEW`) on a 16:9 camera |
| 320×142 | camera 1441 — its sub stream is 1200×536 |
| 640×360 | any camera whose motion rides the DETECTION decode: `registerSharedMotionSink` derives gray from the detection frame, which is not the motion view |

Over 24 h of stored motion rows, 23 cameras produced analyzer motion, 11 of them
at two different sizes, and there were **48 size flips between consecutive rows,
25 of them between different cameras**, the closest 391 ms apart. (Motion rows
are coalesced on a 5 s heartbeat, so that is a lower bound; and it cannot prove
both cameras were on the same node, only that the sizes coexist.)

What the mismatch does, run against the real `motion.wasm` and pinned in
`__tests__/shared-detector-sizing.spec.ts`:

- **Frame smaller than the WASM** (a 320×180 camera after a 640×360 one): each
  buffer is filled only a quarter of the way and the rest is the previous run's
  scratch — different scratch in each buffer. Two **identical** frames then
  produce one region of **176 000 changed pixels, 76.4% of the buffer**. That is
  a permanent motion generator: it clears the 1500 px bar on every frame, so the
  camera sits in `active` for as long as the mis-size lasts.
- **Frame larger than the WASM** (a 640×360 camera after a 320×180 one): the
  WASM compares a 320×180 window of a 640-wide image, so rows are misaligned and
  only the top of the picture is ever read. A subject in the bottom half is
  **invisible** — the test puts a bright square at y≈300 and the detector
  returns nothing.

`ensureSize(w, h)` now resizes before every detect and both tests pass with it.

**Consequence for measurement.** Anything read out of PRODUCTION about motion —
duty cycle, motion-event counts, "this camera fires too much / too little" —
is suspect for any period in which its node was serving more than one frame
size, in a direction that depends on which camera inited last. The measurement
behind this record is not affected: `scripts/motion-region-area-eval.mts` runs
the WASM out of process, one camera at a time, sized from that camera's own
frames. Its "shipped rule" baseline is therefore what the shipped rule SHOULD
have done, and on an affected camera production will have done worse. Any
future comparison against production history has to be taken after this fix, or
discarded.

## Consequences

- **More motion fires, and motion is not free** — but only on a camera an
  operator has moved. Measured on real footage, the time the runner would spend
  in `active` rises ×1.45 to ×2.82. On a camera recording `continuous` that
  costs nothing in storage; on the ten fleet cameras whose bands are `events` +
  `triggers.motion` it is recorded hours, and their own footage cannot answer
  the counterfactual. The numbers, per camera, are in the benchmark.
- **The fix is inert until someone opts a camera in**, which also means the
  storm breaker is inert until then. A camera left on the legacy rule keeps
  having no storm protection at all — that is the price of changing nothing on
  install, and it is why the rollout should not stall.
- **`regionCount` now counts SUBJECTS, not blobs.** Anything reading it as a
  fragmentation measure is reading something else than before. `rawRegions` is
  unchanged and is still every component, ungated — the debug overlay keeps
  showing what CCL found.
- **A merged group's `intensity`** (changed pixels ÷ bounding-box area) is lower
  than any of its members', because the union rectangle includes the gaps
  between fragments. Nothing branches on `intensity` today; anything that starts
  to must be aware the denominator changed.
- **The storm breaker is new behaviour, and it drops work**, so it logs
  (`motion storm suppressed`, with `tags.deviceId`). A camera silenced by
  weather must never be indistinguishable from a camera nobody walks past.
- The pure function is O(n²) in components, bounded by the WASM's own
  `MAX_REGIONS = 256` — 65 k comparisons in the worst frame, which is noise
  beside the WASM pass itself.

## Enforcement

`packages/addon-pipeline/src/motion-wasm/__tests__/region-grouping.spec.ts`
pins the geometry: fragments that must merge, fragments that must not, the
boundary, a single large region, a frame of noise, resolution invariance, and
four storm cases including the subject-inside-a-storm fallback. It also pins the
rollout: **the shipped default reproduces the pre-D394 filter region for
region**, a positive `minArea` restores the legacy rule whole (no merging, no
storm cutoff), and setting `minArea` to 0 is the entire gesture that moves a
camera.

`__tests__/shared-detector-sizing.spec.ts` runs the real `motion.wasm` and pins
both directions of the shared-detector mis-size, and that `ensureSize` removes
them.

There is no guard script — the rule is enforced by the fact that
`groupMotionRegions` is the only place the bar is applied, and
`WasmMotionDetector.detect` is the only caller.
