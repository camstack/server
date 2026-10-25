# Operator debug-track audit — eleven tracks, 2026-09-07 (101 / 102 / 3829)

The operator marked eleven tracks `debug: true` and wrote, per track, what
looked wrong. This page is the answer, one section per track, the note quoted
verbatim, plus the synthesis across them. It exists because clearing `debug`
destroys `debugNote`: these are the operator's words, kept.

Written 2026-09-08 against the live hub. The flags were cleared **after** this
page was written, one `pipelineAnalytics.setTrackFlags` call per track — see
[Closing out](#closing-out).

## How this was measured

- `pipelineAnalytics.getTrack` / `getTrackMedia` / `getObjectEvents` for the
  rows, and `addons.custom {addonId:'pipeline-analytics', action:'debug.analyze'}`
  for the standard finding codes.
- Hub log lines for the 2026-09-07 23:22 window (still inside the ring for the
  `46d4e09f` / `df1ca4b8` pair; nothing older survived, so every other track is
  reasoned from the persisted record).
- All three cameras are `armed:on-motion` (`pipelineOrchestrator.getCameraStatus`
  → `assignment.reasons.detection`). Every frame cadence below is a
  motion-settle burst plus a poll, never a steady fps.
- All frames are 3840×2160 (`ObjectEvent.frameWidth/frameHeight`).

Two measurement facts that shape everything below:

**`getTrack.positions` is arrival order, not time order.** `track-store.ts`
appends (`positions.push`) and nothing sorts on read. Seven of the fourteen
tracks read here have at least one position whose timestamp precedes its
predecessor's. A consumer that draws the array as a polyline draws a path that
crosses back on itself.

**A track's positions can come from two different detector passes, and the
record does not say which.** Boxes from the full-frame pass are exact multiples
of 1.2 (an integer box on a 3200-px analysis raster, ×1.2 to 4K). Boxes from
`packages/addon-pipeline/src/pipeline-runner/small-subject-recovery.ts` are
full-precision floats — `remapCropDetections` computes
`x = (crop.left + x × crop.side/view.width) × nativeToResultX`, and with the
`cropSidePx=800 / viewPx=640` pair the hub logged, that is exactly the ⅛-pixel
granularity seen on `df1ca4b8`. `TrackPosition` carries no `source`, no score
and no provenance, so this had to be recovered arithmetically.

Recovery-pass share of positions, this set:

| track | positions | recovery-pass |
| --- | --- | --- |
| `df1ca4b8` | 5 | **5** |
| `5abeefc2` | 6 | 4 |
| `59bbae2b` | 8 | 4 |
| `dfb3a961` | 10 | 2 |
| `b8ff2579` | 12 | 1 |
| `a99af2f3` | 8 | 1 |
| the other 8 | — | 0 |

## Theme 1 — "this one is the continuation of that one" (4 notes)

Four notes, one symptom: one subject, two track ids. The constants that decide
it are in
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/sort-tracker.ts` <!-- drift-ok: this audit is dated 2026-09-08, against the old tracker; deleted with it (D683 Task 21) -->
(`DEFAULT_TRACKER_CONFIG`): `iouThreshold: 0.3`, `rescueIouThreshold: 0.1`,
`rescueCentroidFactor: 0.75`, `maxMissedMs: 4000`, `resurrectionWindowMs: 8000`,
`classGroupAssoc: true` (the association group is `{person, animal}` — vehicle
is alone).

### `df1ca4b8-419e-4407-add3-e43b23d123da` · 101 · person · 1788816129842

> È il continuo della 46d4e09f-d0f6-461e-97b4-fe5280606195
> [It is the continuation of 46d4e09f-d0f6-461e-97b4-fe5280606195]

**Correct observation; the split is a real defect, and it is the one case in the
set the record cannot fully explain.**

`46d4e09f` ends at 1788816129025 with box `[2428.8, 64.8, 612×526.8]`;
`df1ca4b8` begins 817 ms later at `[2752.6, 212, 542.1×428]`. The centroid moved
305 px. `46d4e09f` was still alive throughout — its `track lost` line is at
23:22:13, four seconds later, i.e. it burned the full `maxMissedMs`.

All five of `df1ca4b8`'s positions came from the small-subject-recovery pass;
`46d4e09f`'s twelve all came from the full-frame pass. The hub confirms the
birth as `reason=native-pass, nativeRecoveryCropSidePx=800, nativeRecoveryViewPx=640`
— so what happened at the scene is: the full-frame detector lost the subject,
the recovery pass found it 817 ms later, and the recovered box minted a new id
instead of re-acquiring the coasting one.

The published gates do not explain the refusal. IoU against `46d4e09f`'s
last-known box is **0.246** — below `iouThreshold` (0.3), so the greedy pass
legitimately declined, but comfortably above `rescueIouThreshold` (0.1), so the
rescue pass's `looseMatch` should have returned gate `iou` and bound it (the
`isPlausibleBirth` veto applies only to the `centroid` gate). Two candidate
mechanisms, neither provable from the record:

1. `sameGroupAsMeasured` (D378) refuses the `{person, animal}` widening for any
   detection carrying `nativeRecovery` — it must match `track.class` exactly.
   `track.class` is the **last matched frame's** class, and the detector was
   oscillating on this subject that second: the hub logged an `animal` box at
   0.536 and a `person` box at 0.83 on the same rectangles. If the last match
   left `track.class = 'animal'`, a recovery `person` box could not bind, by
   construction.
2. The recovery detection was consumed by another track in the greedy pass
   before the rescue pass ran.

**Neither can be confirmed, because a spawn beside a live compatible coasting
track produces no log line.** `reportRefusal` logs a suppressed spawn and
`reportBind` logs a loose bind; the case that actually fragments a subject —
"I minted a new id while a compatible track was coasting N px away at IoU X" —
is silent. That is the first fix (see [Fixes](#the-fixes-the-eleven-imply)).

### `46d4e09f-d0f6-461e-97b4-fe5280606195` · 101 · person · 1788816126698

> (no note)

The other half of the pair, marked so the two could be compared. Healthy in
itself: 12 positions over 2.33 s, a full media set, `bestEventId` set. Its only
finding is `MISSING_BEST_CROP`, which it shares with 10 of the 14 tracks read
here and which is not a per-track defect (see the synthesis). Its `lastFrame`
sits 508 ms before `lastSeen` — under the `LASTFRAME_STALE` bar, but the same
mechanism as the two tracks that trip it.

### `267840a1-e548-466c-9daf-87767f7e2958` · 101 · person · 1788803547636

> Continuo di 7781d055-0592-4497-9180-37ddae46afdf
> [Continuation of 7781d055-0592-4497-9180-37ddae46afdf]

**Correct, and here the arithmetic is decisive: the tracker could not have
bridged it.**

`7781d055` ends at 1788803546756 at `[950.4, 0, 513.6×721.2]`; `267840a1`
begins 880 ms later at `[1760.4, 0, 709.2×654]`. The boxes do not touch —
**IoU = 0** — so both the greedy gate (0.3) and the rescue gate (0.1) refuse on
overlap. The rescue pass's centroid fallback also refuses: the centroid moved
**908.4 px** against a gate of `0.75 × hypot(513.6, 721.2)` = **664.0 px**.

The subject travelled 908 px in 880 ms (≈1030 px/s) after covering only 196 px
in the previous 1.08 s. That is not acceleration — it is a **missing frame**.
Both tracks are pure full-frame-pass; nothing was measured in between.

This is where predictive coasting should have carried the track, and cannot:
`SortTracker.predicted` extrapolates by **frame count**, not by wall clock —
`driftX = clamp(velocity.dx × (age + 1), -bbox.w, bbox.w)`, and `velocity` is
itself px **per frame**. On an `on-motion` camera the interval between two
tracker updates ranges from ~200 ms inside a settle burst to over 3 s on the
poll (`5abeefc2` holds intra-track gaps of 2925 ms and 3327 ms). One missed
update therefore predicts one *average historical step* regardless of how much
real time passed, and the drift clamp caps it at one box width (513.6 px here)
when the subject moved 908.

`7781d055` itself is healthy: 4 positions, 1.076 s, `SHORT_TRACK` (under the
2 s floor) — the fragment, correctly labelled as one.

### `5abeefc2-c9a5-4b06-a6ac-1917700a4387` · 101 · person · 1788800736033

> Questa è il continuo di 2670ae47-c6c9-4695-96b3-23ad47390224
> [This is the continuation of 2670ae47-c6c9-4695-96b3-23ad47390224]

**Correct, and the refusal is a hard one: the two tracks are different macro
classes.** `2670ae47` is `vehicle`, `5abeefc2` is `person`.

`associable()` compares `assocGroup(track.class)` with `assocGroup(det.class)`,
and `assocGroup` widens only `{person, animal}`. A vehicle track can never be
claimed by a person detection, whatever the geometry — and the geometry refuses
too: 1194 ms gap, **IoU 0**, centroid moved 705.9 px against a 531.4 px gate.

The subject is almost certainly a rider: `2670ae47` covers 1872 px in 2.3 s
(≈810 px/s) with a 589-px-wide box, `5abeefc2` continues the same line with a
302-px-wide person box. `rider-pairing.ts` exists for exactly this and could not
help — it folds a person box into a **concurrent** two-wheeler box in one frame,
and here the two never coexist: the vehicle box stops, then the person box
starts. The one lever that would have bridged it is a class-agnostic
re-acquisition, which the tracker deliberately does not have.

`5abeefc2`'s own media is the `copy` fallback: `lastFrame` is byte-identical in
size and timestamp to `keyFrameSmall`, hence `LASTFRAME_STALE — 8443 ms older
than the track's end`. Explained in Theme 3.

## Theme 2 — the suspected duplicate

### `dfb3a961-636d-460a-8597-856e7a7b2b44` · 101 · animal · 1788803197594

> Duplicato di 81177f2b-bd0b-48eb-929a-e0b1b5602531?
> [Duplicate of 81177f2b-bd0b-48eb-929a-e0b1b5602531?]

**No — the opposite. `dfb3a961` is the real animal; `81177f2b` stopped being an
animal track 734 ms into its life and followed a person for the rest of it.**

At the instant `dfb3a961` is born, the two boxes overlap by **IoU 0.037** — they
are not the same object, so "duplicate" is ruled out on geometry alone.

What the positions say about `81177f2b`:

| offset | box | shape |
| --- | --- | --- |
| −112 … +546 | `y ≈ 356–792`, `w ≈ 750–883`, `h ≈ 403–432` | wide and low — the dog |
| +734 onward | `y ≈ 0–660`, `h ≈ 520–660` | tall — a person |

The takeover is a rescue-pass bind: IoU between the dog's last box
(`[1011.6, 366, 883.2×403.2]`) and the incoming person box
(`[1165.2, 3.6, 568.8×652.8]`) is **0.2938** — below `iouThreshold` 0.3, above
`rescueIouThreshold` 0.1, and `classGroupAssoc` makes `person` and `animal` one
association group, so `looseMatch` returned gate `iou` and the person claimed
the dog's id. The dog, now unmatched, re-spawned 306 ms later as `dfb3a961`.

Two consequences the operator can see:

- `81177f2b.classes` is `['animal', 'person']` and its `left` event carries
  `className: person`, yet the row reports `animal`. That is
  `classVotingEnabled` doing what it says: a confidence-weighted lifetime
  majority. Three dog frames at the start out-voted nothing — the vote is over
  the whole life including the person frames, and `animal` still won ≥ 0.5 of
  the weight. **The label is a vote over a track that changed subject, so the
  vote is meaningless here, not wrong.**
- `81177f2b`'s four snapshots and its `lastFrame` (at 1788803202197) are all
  from the person half. The dog's own evidence lives on `dfb3a961`, which has
  no snapshot at all and whose `lastFrame` is the `copy` fallback
  (`LASTFRAME_STALE — 3062 ms`).

`dedupMergeIou` (0.6) and `dedupSpawnIou` (0.6) could not have stopped the
takeover: the two subjects never overlap that much. What made it possible is
`classGroupAssoc` widening the gate for a coarse-pass misclassification, applied
here to two genuinely different animals-of-different-kind sharing a frame.

## Theme 3 — "no first / no last shot"

### `59bbae2b-2975-4d65-8dde-726c0ba523f2` · 102 · vehicle · 1788800751885

> Niente primo e ultimo
> [No first and last]

**Correct, and the record names the cause.** The row carries

```
previewMissReason = "raster-tile tile=raster capture=thumbnail:native-missx2"
```

Read through `composePreviewMissReason`
(`packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-close.ts`):
the tile that stood in was the **detection raster**, and the native subject tile
missed **twice** on the `thumbnail` capture. `debug.analyze` agrees:
`MISSING_KEYFRAME` (error), `MISSING_LASTFRAME`, `BEST_SHOT_RASTER`. The
thumbnail is 87.7 KB against a p50 of ~240 KB for a keyFrame-derived one.

The two are one failure, not two. `decideLastFramePromotion`
(`last-frame-promotion.ts`) can fill an empty `lastFrame` slot in two ways:
promote the newest `snapshot` (`move`), or, for a track that died inside one
snapshot interval, copy `keyFrameSmall` (`copy`). This track has **neither** —
no snapshot (1.14 s of life, under one interval) and no `keyFrameSmall`, because
the keyFrame never landed. **So "no last shot" is a downstream consequence of
"no key frame"; there is no independent last-frame defect.** The same shape
explains `b8ff2579`, `a99af2f3` and `2670ae47` in this set.

Worth separating from the media question: this track's last four positions are
recovery-pass boxes that jump 930 px upward into an 18.5-px-wide "vehicle". Its
`hasRider` is true. The track is a mess independently of its media.

### `a99af2f3-7a9a-4944-adc7-09f22ba6e1ed` · 102 · person · 1788800750466

> Niente ultimo
> [No last]

**Correct, same mechanism, one step less severe.** `MISSING_KEYFRAME` (error) +
`MISSING_LASTFRAME`. It has `firstFrame` (176.8 KB), a 218 KB `thumbnail`,
`thumbnailSmall`, and a face `crop` — so pixels were reaching the face path
while the key-frame capture missed; this is the split described in
`.claude/skills/audit-debug-tracks/SKILL.md` §5, except that here the thumbnail
is 218 KB, far above the 3–6 KB face-copy signature, so the thumbnail is a real
subject capture and not the face crop wearing the kind.

Its final position (1788800752700) is a recovery-pass box that drops 400 px down
the frame — the same pollution as `59bbae2b`, on the same camera, in the same
two seconds.

Nothing here says WHY the native key-frame fetch missed. The window is long past
the log ring, so that stays **UNKNOWN** — and the audit runbook already records
the native key-frame lease as untested rather than disproven.

### `3d1c3b41-a5c1-444d-9b0e-8d00446dbb0e` · 102 · person · 1788801618085

> La detection qui ha iniziato a metà strada e non subito
> [The detection here started halfway through and not immediately]

**Correct behaviour that looks wrong. Not a defect in the track.**

This is the healthiest track in the set: 11 positions, 2.74 s, `crop` +
`faceCrop`, `hasFace` and `hasEmbeddedFace` both true, a full media set, and
**zero findings** from `debug.analyze`. Its `firstFrame` is stamped at
`firstSeen` exactly, so the capture path fired at the true birth.

The lateness is upstream of tracking. Camera 102 is `armed:on-motion`: the
detection session starts when motion fires and the pipeline warms up, so the
first stretch of an approach is simply not analysed. The trajectory is
consistent with that — the subject is largest (272×817) and nearest at the first
stored position and shrinks monotonically as it walks away, i.e. the camera
picked it up at the closest point of its path, not on entry.

Two secondary contributors, both by design: `minHits: 3` before a track may
emit, and `minTrackAge: 3` frames / `minTrackAgeMs` before an appearance event
(`event-emitter.ts`). Its appearance event is at 1788801619272, the third
position, 1187 ms after `firstSeen` — so the *event* is later still than the
*track*, and a surface keyed on events will look later again.

**If the operator wants earlier detection here, the lever is the motion/settle
arming on 102, not the tracker.**

### `b8ff2579-bf55-4665-90ab-221e73e9d15f` · 101 · person · 1788800735278

> Qui la traccia non coincide con la box
> [Here the track does not match the box]

**Correct, and it is the clearest single instance of the two-pass pollution.**

Eleven of the twelve positions sit in a narrow strip across the top of the frame
(`y` from 0 to about 324, box height 271–324) as the subject moves right from
x=1657 to x=3231. **One position does not**: at +105 ms, box
`[2050.0, 113.8, 449.7×380.6]` — a full-precision float box, i.e. a
small-subject-recovery box, sitting 190 px lower and 60 px taller than anything
around it. It is also **out of temporal order** in the stored array, landing
between the +0 and +213 entries.

That one box is what the operator is looking at, because it is the box two
surfaces chose:

- the `firstFrame` media row is stamped **1788800735383** — the recovery
  position, not the birth position at 1788800735278;
- the appearance `ObjectEvent` at 1788800736957 carries
  `bbox [2050, 114, 450×381]` — the same box.

`firstFrame` / `lastFrame` / `snapshot` are all **annotated** — the box is burnt
into the pixels by `event-media-dispatcher.ts#boxedTimelineFrame` — so the
operator's "Primo" tile literally shows a rectangle that does not sit on the
track's own path.

This track is also `MISSING_KEYFRAME` (error) + `MISSING_LASTFRAME`, the same
pair as the two 102 tracks above.

## Theme 4 — best-shot quality

Both notes are about the same ranking, in
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/edge-clear.ts`
(`isEdgeAwareNewBest`) under `BEST_FRAME_POLICY`
(`best-selection-policies.ts`: `hysteresis 0.05`, `minGapMs 2000`, edge-, size-
and semantic-aware). The tiers, highest first: delivered-square containment →
semantic (a recognition succeeded on that frame) → edge-clear → effective score
(`confidence × containment × sizeFactor`).

**"Clipped" IS a factor — twice — but neither factor measures what these two
notes are about.**

### `5f5f0f6e-0253-4208-8eab-f8d5d6a14fbe` · 3829 · person · 1788803563535

> Qui il best shot è a bordo. C'è però Una posizione più avanzate che non ci
> costringere a usare il bordo specchiato
> [Here the best shot is at the border. But there is a more advanced position that does not force us to use the mirrored border]

**Correct on both halves.**

The stored `keyFrame`, `keyFrameSmall`, `thumbnail` and `thumbnailSmall` are all
stamped **1788803563535 — the birth frame**, box `[9.6, 404.4, 357.6×633.6]`.
That box starts 9.6 px from the left border, inside the 1 % tolerance band
(`DEFAULT_EDGE_TOLERANCE` = 0.01 → 38.4 px on a 3840-px frame), so `isEdgeClear`
returns **false** for it. Seven later positions are edge-clear.

And the delivered image is worse than "at the edge". The best-shot crop is the
16:9 central-square window of
`packages/addon-post-analysis/src/shared/frame/wide-central-square-crop.ts`: a
square containing the subject, extended laterally to `side × 16/9`, slid back
inside the frame when it can be, with the residue as padding. Computed on this
track's own boxes:

| position | central square | 16:9 canvas | lateral fill needed |
| --- | --- | --- | --- |
| **+0 (shipped)** | 633.6 px, clamped to x=0 | 1126.4 px | **246.4 px** |
| +803 | 680.4 px | 1209.6 px | 132.6 px |
| +1205 | 648.0 px | 1152.0 px | 60.6 px |
| +1266 (`bestEventId`) | 640.8 px | 1139.2 px | 33.8 px |
| **+1534** | 679.2 px | 1207.5 px | **0** |
| **+1715** | 619.2 px | 1100.8 px | **0** |

The two "more advanced positions that would not force the mirrored border" are
real and measurable: +1534 and +1715 need no fill at all, and +1534 is also
edge-clear, larger in the square, and did produce a capture (there is a
`snapshot` row at 1788803565069).

Why the shipped best shot stayed at the edge-touching birth frame is the part
the record cannot settle. `isEdgeAwareNewBest` says a clear frame beats a
touching one **always**, and the tier upgrade bypasses both `hysteresis` and
`minGapMs`. So either the promotion never fired, or it fired and its native
capture missed while the held peak had already advanced — from the stored rows
those two are indistinguishable. **UNKNOWN**, and it needs one line at the
promotion attempt to become answerable.

What *is* settled, and is a design gap rather than a mystery: **no tier measures
the delivered 16:9 canvas.** `isSquareContained` measures the central square
(fully in frame for every candidate above, including +0), `isEdgeClear` measures
the detection box, `bboxContainment` measures border touching. The lateral fill
the operator is complaining about is explicitly permitted by the crop module's
own contract ("padding only ever appears in the lateral thirds") and is
therefore invisible to ranking by construction.

### `841f9b8e-f31a-419c-beb4-b0b1016b9bf3` · 3829 · person · 1788801617236

> Questi tagli hanno uno score troppo alto, non si vedono il dorso e testa
> [These crops have a score that is too high; the back and head are not visible]

**Correct, and this one has a number.**

All three of this track's positions have `y = 0` — the subject is clipped by the
top border on every single frame, so no edge-clear frame ever existed and the
edge tier had nothing to promote to. The shipped best shot is +233,
`[1244.4, 0, 399.6×424.8]`, detector confidence **0.832**.

The clipping penalty that applies is `bboxContainment`, and it is calibrated for
the wrong shape. Its penalty is scaled by how much of the touched border the box
spans on the perpendicular axis — the docblock's own rationale is "a wide bbox
flush to the top/bottom (a wide subject cut off top/bottom) … is heavily
penalised". A **person** clipped at the head is narrow: `spanX = 399.6 / 3840 =
0.104`, so

```
containment = 1 − 0.5 × 0.104 = 0.948
```

A decapitated person loses **5.2 %** of its score. The composite is
`0.832 × 0.948 × (0.5 + 0.5 × 0.452) = 0.573` — and since the same containment
factor applies to every candidate on this track, the ranking between them is
effectively raw confidence.

That is exactly the operator's complaint: the score is high because the score
does not know the head is missing. `CONTAINMENT_MAX_SIDE_PENALTY` is 0.5 for a
box that fills the whole border — a value no upright person can ever approach on
a top/bottom clip.

`SHORT_TRACK` (1177 ms) also fires here. With three positions, `minHits: 3` was
met on the last one; the track had no room to find a better frame.

## Synthesis — why this keeps happening

Eleven notes, four themes, and under them **three** mechanisms.

### 1. The tracker's re-acquisition is spatial and per-frame, on cameras whose frame interval is not

Three of the four continuity notes, and the animal takeover, are the same shape.
`predicted()` extrapolates by `age + 1` **frames** with a per-frame velocity, and
clamps drift to one box width. `maxMissedMs` is wall-clock (4 s) and generous;
the *cost gate* is what refuses. On an `on-motion` camera the interval between
tracker updates spans an order of magnitude (200 ms inside a burst, >3 s on the
poll), so the same 0.3 IoU bar means "the subject moved less than half a box" at
one cadence and "the subject stood still" at the other. `267840a1` is the clean
proof: 880 ms, 908 px, IoU 0, centroid 908 px against a 664 px gate — no branch
of the tracker could have bridged it, and none is at fault individually.

The corollary is that the same loose gate that cannot bridge a fast subject
across a poll gap *is* loose enough to hand one subject's id to another one
standing 294 px away (`81177f2b`). One number is doing two jobs.

### 2. Two detector passes write into one track row, and the row does not say which

The small-subject-recovery pass (D377/D378) is a second, native-resolution
detector on motion regions the full-frame pass did not account for. It is a good
idea and it demonstrably recovers subjects. But its boxes:

- land in `positions` indistinguishably from full-frame boxes — no `source`, no
  score, nothing but float precision to tell them apart;
- are deliberately made "their own subject" by `sameGroupAsMeasured`, which is
  the leading explanation for the `46d4e09f → df1ca4b8` split;
- become the box the appearance event and the burnt-in `firstFrame` overlay use
  when they happen to be the position of record — which is `b8ff2579`'s note in
  full;
- arrive interleaved, which is most of why `positions` is out of temporal order.

None of the five affected tracks can be diagnosed from the API alone. Every one
of them required reconstructing the producer from the decimal expansion of a
bounding box.

### 3. Media: one capture failure, reported as three symptoms

`MISSING_KEYFRAME` on four of the fourteen tracks read (`b8ff2579`, `59bbae2b`,
`a99af2f3`, `2670ae47`) is a single upstream failure — the native subject tile
missed — and it propagates:

```
keyFrame missing → keyFrameSmall missing → lastFrame `copy` fallback impossible
                 → thumbnail falls back to the ≤640 raster (BEST_SHOT_RASTER)
```

Only one of the four carries a `previewMissReason`, and only that one can say
how many times the tile missed. The operator's "niente primo e ultimo" [no first and last] and
"niente ultimo" [no last] are not two bugs; they are one bug seen through a viewer that
renders per-kind.

And `MISSING_BEST_CROP` on **10 of 14** tracks — including the fully healthy
`46d4e09f` and `5f5f0f6e` — is not a per-track finding at all at that rate. It
is either a systemic gap or a mis-scoped check, and it should be triaged as one
question rather than eleven.

## The fixes the eleven imply

Ordered by how many of the eleven one change would close. **Nothing here was
implemented** — the tracker and the best-shot ranking both need review first.

| # | Fix | Closes |
| --- | --- | --- |
| 1 | **Make coasting time-based.** Carry velocity in px/**ms** and extrapolate by `timestamp − lastSeen`, with the drift clamp scaled to the elapsed interval rather than fixed at one box width. On an `on-motion` camera the frame count is not a clock. | `df1ca4b8`, `267840a1`, `5abeefc2` (3) |
| 2 | **Log the spawn that happened beside a live compatible coasting track** — new id, competitor id, both classes, measured IoU against last-known and against the prediction, elapsed ms. `reportRefusal`/`reportBind` cover the cases where the tracker *acts*; the fragmenting case is the one where it does not, and it is silent. Without this, fix 1 cannot be verified on live traffic. | diagnoses all 4 continuity notes |
| 3 | **Give `TrackPosition` a provenance field** (`source: 'frame' \| 'recovery'`, plus the detection score). Then `b8ff2579`'s note is answerable from one API call, the appearance event can prefer a full-frame box over a recovery box, and the two-pass interleaving stops being invisible. | `b8ff2579`, and the diagnosis of `df1ca4b8`, `59bbae2b`, `a99af2f3`, `dfb3a961` (5) |
| 4 | **Sort `positions` by timestamp on read**, and say in the cap doc that the array is time-ordered. Seven of fourteen tracks here are not. Cheap, and it stops every consumer drawing a self-crossing path. | contributes to `b8ff2579`; correctness for all |
| 5 | **Make `bboxContainment` penalise a clipped subject by the subject's own geometry, not by its span across the border.** A person whose head is cut by the top edge loses 5.2 % today. The natural measure is the fraction of the *expected* subject that survives (aspect-prior for the class), not the fraction of the border it covers. | `841f9b8e` (1) |
| 6 | **Add a delivered-canvas term to the best-shot ranking.** Rank on whether the 16:9 window fits in frame, not only on whether the central square does. `5f5f0f6e` had two later positions needing zero lateral fill against the shipped 246.4 px. | `5f5f0f6e` (1) |
| 7 | **Log every best-shot promotion attempt and its capture outcome.** Today a promotion that fired and whose capture missed is indistinguishable from one that never fired — which is why `5f5f0f6e` ends at UNKNOWN. | unblocks 6 |
| 8 | **Triage `MISSING_KEYFRAME` as one question**, and write `previewMissReason` on *every* track that closes without a native tile, not only when the raster stand-in path runs. Three of the four affected tracks here carry no reason at all. | `59bbae2b`, `a99af2f3`, `b8ff2579` (3) |
| 9 | **Re-scope or re-measure `MISSING_BEST_CROP`.** 10/14 including healthy tracks. | noise reduction |

Not proposed, deliberately: widening the association group to include `vehicle`
so a rider survives its class flip (`5abeefc2`). That would let any person claim
any car; the honest fix for a rider is sequential rider pairing, and it is a
design question rather than a tracker constant.

## Closing out

The audit runbook (`.claude/skills/audit-debug-tracks/SKILL.md` §8) says to
clear `debug` only on EXPLAINED-BENIGN and to leave it set on EXPLAINED-DEFECT,
so that "audited, still broken" stays visible. That was overridden here by
explicit instruction: all eleven flags were cleared, and **this page is the
replacement handle** — it holds every note verbatim, which the flag would not
have survived anyway.

| track | device | verdict |
| --- | --- | --- |
| `df1ca4b8` | 101 | DEFECT — fragmentation; mechanism UNKNOWN, fixes 1+2 |
| `46d4e09f` | 101 | BENIGN — the comparison half |
| `267840a1` | 101 | DEFECT — frame-count coasting, fix 1 |
| `dfb3a961` | 101 | DEFECT — not a duplicate; identity takeover on `81177f2b` |
| `5abeefc2` | 101 | DEFECT (by design) — cross-class rider split |
| `b8ff2579` | 101 | DEFECT — recovery-pass box used as `firstFrame` + appearance bbox |
| `3d1c3b41` | 102 | BENIGN — `armed:on-motion` session start, no track defect |
| `59bbae2b` | 102 | DEFECT — native tile missed ×2, keyFrame ⇒ lastFrame cascade |
| `a99af2f3` | 102 | DEFECT — same cascade; cause UNKNOWN (past the log ring) |
| `5f5f0f6e` | 3829 | DEFECT — best shot at the border; ranking has no canvas term |
| `841f9b8e` | 3829 | DEFECT — clipped-subject penalty is 5.2 % |
