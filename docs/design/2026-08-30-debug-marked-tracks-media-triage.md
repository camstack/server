---
title: The operator's debug-marked tracks — plate crops off-target, face-only tracks, best shots from nowhere
last-verified: 2026-08-30
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/plate-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-close.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/keyframe-crop.ts
  - packages/addon-post-analysis/src/pipeline-analytics/copy-face-crop-preview.ts
---

# The debug-marked tracks — where each of the three complaints actually comes from

Triage of the operator's three reports, run 2026-08-30 against the 24 tracks he
marked `debug` (21 real + 3 `pa-synth-` contact markers). Every real track's
media was pulled (`pipelineAnalytics.getTrackMedia`) and **looked at**, per the
`camstack-track-audit` discipline; log evidence is Loki (≈2-day retention), row
evidence is `settingsStore.query` on `pipeline-analytics:tracks` with
`filter.where.debug`. Running versions at audit time:
`@camstack/addon-post-analysis` **1.2.148**, `@camstack/addon-pipeline`
**1.2.149** (confirmed via `addons.list`).

**The three complaints are three different defects, but two share one shape:
a rectangle measured on frame A cut out of the pixels of frame B, with no
motion guard.** The third is capture starvation wearing the D276 stand-in as
its face. None of them is caused by the last two days' work (the D295 ledger
authority and D291–D293 eviction fixes are recorder-side; the sensor-transition
gate is timeline-side): defect A dates to 2026-07-22, defect B to 2026-08-24,
defect C is a load condition that D276 (2026-08-28) made *legible* but did not
fix — and said so.

## The marked set, classified

Verdicts from looking at the stored images, not from counters. "OK" = the
tile frames the subject.

| track | device | class | born (UTC) | complaint it exhibits | evidence |
| --- | --- | --- | --- | --- | --- |
| `4126f977` | 102 | vehicle 6.1 s | 08-29 13:04 | **1 — plate crop off-target** | stored `plateCrop` is **pure gravel/asphalt**; OCR read DNZM855 @0.899 and the plate is clearly legible in the track's own thumbnail. Log: `plate crop recovered from keyFrame (live capture missed)` `skewMs: 531` |
| `e9c024bb` | 102 | vehicle 6.5 s | 08-30 06:45 | **1 — plate crop off-target** | stored `plateCrop` shows a **windshield/A-pillar**, no plate; OCR DNDJ84 @0.765. Log: same line, `skewMs: 1179` |
| `7613c0fa` | 102 | vehicle 34 s, near-stationary | 08-28 17:08 | 1 — control case, **aligned** | `plateCrop` frames DN RG 309 correctly. Same fallback family; subject did not move, so the time skew is invisible |
| `2a82b973` | 102 | vehicle 4.6 s | 08-29 13:30 | partial starvation | plate row exists (DNGR167) but **no plate crop landed at all**; track holds only `thumbnail` + `firstFrame`; `previewMissReason: raster-tile … thumbnail:native-missx2` |
| `978ea88b` | 1443 | person 9.0 s | 08-30 06:50 | **2 — face-only track** | ONLY media rows: `thumbnail` + `faceCrop`, **byte-identical** (3 790 B tight face). `previewMissReason: no-key-frame capture=keyframe:native-missx2`; log: `birth allowed unmeasured — no crop available`, `runDetailSubtree produced no result (every crop source missed)`, `face crop stood in as track thumbnail (provisional)` |
| `d3c084bf` | 587 | person 14.7 s | 08-30 06:35 | **2 — face-only track** | identical signature (3 469 B face as only media; `no-key-frame capture=keyframe:native-missx2`) |
| `42df1c21` | 104 | person 6.7 s | 08-29 13:34 | **2 — face-only track** | identical shape, different starvation reason: `previewMissReason: no-key-frame capture=keyFrame:overflowx13` — thirteen keyFrame captures shed by the bounded per-device queue |
| `ba12ed7b` | 102 | person 9.7 s | 08-29 05:38 | **3 — best shot from nowhere** | thumbnail (405 KB, ~1380×780 window) shows **pavement and two parked cars, no person**, while the track holds a real face crop at +2.5 s. Log: `thumbnail derived from keyFrame at close (no live best-shot landed)` `skewMs: 0` — the derive cut the best-seen box (recorded ~+5.8 s) out of the keyFrame captured at +0 s |
| `c5cec41a` | 101 | animal 6.2 s | 08-30 06:35 | **3** (edge/window) | thumbnail is mostly empty street; the animal is a cut-off sliver at the bottom-left corner |
| `bd137d94` | 102 | vehicle 3.9 s, top-edge transit | 08-28 17:08 | 3 (edge) | thumbnail dominated by the parked foreground SUV; subject barely present at the top edge (`BEST_AT_EDGE` shape — subject bbox at y=0 for its whole life) |
| `0b6a4656` | 618 | person 94 s | 08-29 05:31 | 3 (variant) + separate leak | thumbnail's **timestamp precedes `firstSeen` by 7.2 s**. The id was born → `birth suppressed — track record retracted` → resurrected; a thumbnail captured for the retracted incarnation survived on the media store and resurfaced on the reborn row. Tile itself is a full scene that does contain the subject |
| `08e31014`, `438cce40`, `c07ec315`, `7eb1ba0b`, `07655e12` | 102 | vehicle | 08-28 | none of the three | parked/transiting cars, subject framed. `438cce40` and `c07ec315` show a cosmetic **smear band** where the 16:9 window crosses the right frame edge (out-of-frame area filled with a stretched blur, not letterbox) |
| `5e5cd1a3` | 586 | person 4.6 s | 08-28 23:50 | none (borderline) | thumbnail is a whole-scene frame, subject visible; `previewMissReason: raster-tile … thumbnail:native-missx2` |
| `7bb4a74c` | 104 | person 25.5 s | 08-29 13:32 | none | subject crop OK (partial body, matches bbox) |
| `9f4e0f85`, `68267541` | 618 | person | 08-29 05:32/05:34 | none | full-scene thumbnails (subject bbox ≈ half the raster → runner classifies full-frame), subject present, faces held |
| `9f9204d4` | 618 | person 74 s | 08-29 05:30 | **could not verify** | `getTrackMedia` timed out (`UDS request timed out after 60000ms` — hub under drain load); face row is `null` |
| 3 × `pa-synth-*` | 101 | contact | 08-28/29 | none of the three | sensor markers, presumably marked for the (already landed) sensor-transition-gate work |

## Cause A — the plate crop's keyFrame fallback has a time guard and no motion guard

**What the operator sees**: `plateGallery` tiles (and the track detail's
`plateCrop`, which is the same row — `ownerKind: 'plate'` renamed on the way
out by `track-media-scope.ts`) that frame gravel or a windshield instead of the
plate, while the OCR text on the same row is correct.

**Mechanism, confirmed on two tracks.** The live gallery-crop capture
(`PlateRecognizer.observeRead` → `captureDisplayCrop`,
`plate-recognizer.ts:322`) missed every tier — the ordinary starvation of
cause C. At track end the durable last-resort fires:
`plate-recognizer.ts:398` calls `deriveCropFromKeyFrame`, which cuts the plate
rectangle (measured at the best OCR read's instant) out of the track's
persisted **keyFrame** (captured at a different instant). The only guard is
temporal: `keyframe-crop.ts:67` computes `skewMs` and rejects above
`KEYFRAME_CROP_MAX_SKEW_MS` = 1500 (`index.ts:809`, wired at `index.ts:3289`).
**1.5 s bounds time, not motion**: a car crossing 102's frame covers hundreds
of native px in 500 ms. `e9c024bb` passed the guard at `skewMs: 1179` and got
a windshield; `4126f977` passed at `skewMs: 531` and got the road behind where
the car had been; `7613c0fa` (parked) got a perfect crop from the identical
path. The OCR is right because the runner read the plate from the correct
frame's tile (D52 path) — only the *display* crop is cut cross-time.

**This is not new.** The fallback shipped 2026-07-22, and the
`plate crop recovered from keyFrame` line fires at a steady ~13–15/day across
the whole 48 h Loki window, including before the 08-28 F1/F1b deploys. What
makes it *feel* new is exposure: every firing on a **moving** vehicle is a
wrong image, and the live-capture miss rate that routes plates into the
fallback is high right now (cause C). Whether the miss rate itself rose over a
longer horizon is outside log retention — not determined.

**Cheapest confirming experiment**: the track's `positions` are already stored.
For the next `plate crop recovered from keyFrame` line, compare the subject
bbox at `keyFrame.timestamp` vs at the plate read's timestamp
(`getTrack` + the two timestamps on the rows); IoU ≈ 0 predicts a wrong crop,
IoU high predicts a right one. No deploy needed — it is a read-only check that
the defect tracks motion, not skew.

**Fix shape (for when the tree is free)**: keep the fallback, add the motion
guard — refuse the derive when the subject bbox at the keyFrame instant does
not contain/overlap the plate rect (positions are available at close), or
re-detect the plate on the keyFrame crop via the runner (`runStatelessStep`,
D52-clean) instead of trusting a cross-frame rectangle. A refused derive
should log, per the silent-drop rule.

## Cause B — the close-time thumbnail derive lost its temporal guard on 2026-08-24

**What the operator sees**: a best-shot thumbnail whose window contains no
subject at all (`ba12ed7b`: pavement and parked cars; the person was elsewhere
at the keyFrame instant).

**Mechanism, confirmed in code and log.** At close,
`maybeDeriveThumbnailFromKeyFrame` cuts the **best-seen bbox** — recorded at
its own instant, `track-close.ts:703` — out of the persisted keyFrame, and
passes `timestamp: keyFrame.timestamp` (`track-close.ts:706`) into the same
`createKeyFrameCrop` guard. The guard then compares the keyFrame's timestamp
with itself: `skewMs` is **0 by construction** (the `ba12ed7b` log line shows
exactly that), so no cross-time cut can ever be refused. The docblock at
`track-close.ts:104` states the intent ("the crop bbox may be the latest
best-seen box, but the skew guard MUST compare against the persisted
keyFrame") — that choice fixed track 20da3195 (a track that closed with no
tile because a *later* best-seen timestamp tripped the guard) by deleting the
only protection against cutting a rect from the wrong moment. Landed in, 2026-08-24. Before it, the doc's own description held: "the
keyFrame is often the birth frame, and a walking person rejects the crop" —
rejection was the correct outcome for `ba12ed7b`, whose keyFrame is the birth
frame and whose best-seen box is from +5.8 s.

This is the sharpest match to "best shots taken from nowhere", and it is a
**regression with a date**. It only bites when no live best-shot landed
(cause C again), which is why it presents on starved cameras.

**Cheapest confirming experiment**: for tracks with
`thumbnail derived from keyFrame at close`, compute IoU between the best-seen
bbox and the track's position at the keyFrame's timestamp (both already
stored). `ba12ed7b` scores ≈0. A handful of healthy derives will score high
that split is the whole proof.

**Fix shape**: pass both instants — guard on
`|bestSeen.timestamp − keyFrame.timestamp|` (the best-seen record already
carries its timestamp) **or** on bbox agreement at the keyFrame instant; when
refused, fall through to the retained-raster fallback, which cuts pixels from
the correct moment by construction. The 20da3195 concern (a good keyFrame
refused for pure clock skew) is answered by the bbox-agreement form, not by
deleting the guard.

## Cause C — capture starvation; the face stand-in is the messenger, not the defect

**What the operator sees**: person tracks whose only image is the tight face
crop ("i casi in cui il best shot è il crop del volto invece del soggetto
intero" [the cases where the best shot is the face crop instead of the whole subject]).

**Mechanism, confirmed on all three marked tracks.** On `978ea88b` / `d3c084bf`
/ `42df1c21` **every native capture missed for the track's entire life**: the
confirmation gate got no crop (4–5 attempts, `birth allowed unmeasured`), the
detail plane's own retries missed (`runDetailSubtree produced no result (every
crop source missed)`), the keyFrame never landed (`previewMissReason:
no-key-frame`, with the D276 capture note naming the killer:
`keyframe:native-missx2` on 587/1443, `keyFrame:overflowx13` — queue shed —
on 104). With no keyFrame there is nothing for the close derive or the late
`runPreviewUpgrade` to redeem, so `copyFaceCropIfTrackHasNoThumbnail`
(`copy-face-crop-preview.ts:39`, wired at `index.ts:3225`) installs the face
tile — which is the **designed, operator-accepted fallback** (D276) and is
correctly marked `provisional`. The defect is upstream: the whole native plane
missed. Scale: the `face crop stood in as track thumbnail` line has fired
**~256 times in the ~40 h it has existed** (it shipped with D276, so no
pre-08-28 baseline exists for it).

The face crop itself survives because face pixels take a different route: the
aligned template is cut **on the runner** at detail time and rides the result
back — it does not depend on the post-analysis capture round-trip that starved.

**What is actually starving, measured this morning**: `native crop miss`
reasons in one 10-min window — `worker-lease-gone` ×188 on 104, ×115 on 1443,
×60 on 101, ×13 on 587, plus "frame released and no retained subject or scene
tile contains the requested rectangle"; `capture queue full` ×272 in 24 h;
session-decode on 1443 shows `holdOverflow` ≈1000+ per metrics window while
tiles ARE being cut (`tilesCut` in the thousands — so `nativeTileBudgetMb` is
**not** 0 on that node, answering one of the frame-locality doc's §8 opens for
that node at least). The per-camera split (`previewMissReason` aggregated per
device) is now queryable thanks to D276 — that column is the F3 the
frame-locality plan asked for, delivered.

**Cheapest confirming experiment**: aggregate `previewMissReason` per device
per day (`settingsStore.query` with `filter.where.deviceId`, column
projection) — it directly ranks `native-miss` vs `overflow` vs `stale` per
camera with zero deploys. Then F2 of
`2026-08-28-faces-plates-frame-locality.md` (refuse at the demand side instead
of enqueue-and-shed) is the standing recommendation for the overflow family,
and the `worker-lease-gone` bursts want the lease-side levers of that same
doc's §5/F4 — not another retry bound.

## Two secondary defects found on the way

- **Suppressed-birth media outlives the retraction** (`0b6a4656`): D38's
  "a rejected birth leaves nothing behind" drops the track row, but a
  `thumbnail` already captured for the suppressed id stays in the media store;
  when the tracker id is later resurrected, the reborn row inherits a tile
  from before its own `firstSeen` (−7.2 s here). Cheap detector: media rows
  with `timestamp < track.firstSeen`. Cheap fix: the suppression path already
  knows the trackId — cascade the media delete, or stamp `firstSeen` into the
  media accept gate.
- **Out-of-frame smear band** (`438cce40`, `c07ec315`): when the wide-square
  window crosses the right raster edge, the out-of-frame region renders as a
  stretched blur instead of letterbox. Cosmetic; likely the compose path's
  extend mode. Not investigated further.

## What could not be determined

- `9f9204d4`'s media (the one marked 618 track that timed out) — retry when
  the drain finishes; its face row is `null`, which on 618 (not a default face
  camera in the audit config) is not itself a defect.
- Whether the plate-fallback **rate** rose before 2026-08-26 — outside Loki
  retention; the code path is 07-22, the rate within retention is flat.
- The root cause of the `worker-lease-gone` bursts (EIO cooldown vs late asks
  vs hold overflow) — the miss lines carry `handleAgeMs` and reason, so it is
  answerable, but it needs a per-burst read that this pass did not do.
- `tilesCut` on hub-decoded cameras with live subjects at the defect instants
  (the sampled hub cameras were subject-free overnight); 111 proves the tile
  store is on for the Mac-mini node only.

## Reproduction pointers

Marked rows: `settingsStore.query {collection: 'pipeline-analytics:tracks',
filter: {where: {debug: true}}}` (columns must use the store's names — `id`,
not `trackId`). Images: `pipelineAnalytics.getTrackMedia {deviceId, trackId}`
— the plate/face gallery crops appear there as `plateCrop`/`faceCrop` (the
`ownerKind: 'plate'|'face'` rows renamed by `track-media-scope.ts`). Every
image referenced above was decoded from those responses and inspected.
