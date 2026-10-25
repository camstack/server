---
id: D665
title: A box under the class floor may continue a confirmed track and do nothing else, and the graveyard reach grows with the gap
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/low-score-continuation.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/dropout-skip.ts
  - packages/addon-pipeline/src/pipeline-runner/below-floor-tally.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
  - packages/addon-post-analysis/src/pipeline-analytics/tracking-settings.ts
  - packages/addon-pipeline/src/pipeline-runner/timing-sampler.ts
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The online graveyard reach this record (and its D678
> amendment below) time-scaled has no equivalent in tracker v2 — a deferred
> linker judges reach with the future in hand. The sub-floor box SELECTION
> this record also introduced, `pipeline/tracker/low-score-continuation.ts`,
> is unchanged and still feeds tracker v2's own continuation
> (`lowScoreContinuationEnabled`, `LINGERING_CLASSES` in
> `tracker-v2/constants.ts` — the same class set this record and D678 built,
> now one constant instead of two settings).
>
> **Face retraction (2026-10-23).** The `rejected` re-verification of a held
> face and the identity-label retraction this record describes (the C1 row of
> the table, `retractFaceIdentityLabel`) were removed with the old tracker in
> e504c1659 (D683 Task 21): tracker v2 never resurrects a track id, so their
> trigger cannot occur. The only identity change on a track today is the L2
> fusion relabel, logged as `face: fused tracks disagree`. Retracting a
> confirmed name on later contradicting faces is an open idea
> (`docs/ideas.md`), not shipped behaviour. <!-- drift-ok: moved to the private planning repo -->

> **Amended by [D678](adr-0678-a-proximity-resurrection-needs-the-corpses-size-and-a-vehicle-keeps-the-flat-graveyard-gate.md)
> (2026-09-29).** The time-scaled resurrection reach and the sole-subject veto
> lift apply to people and animals only; a vehicle corpse is back on the flat
> gate. A proximity (`centroid`) resurrection also needs an area ratio of at
> most 2.5. The trigger: on 2026-09-28, 18 of 41 sampled centroid binds bridged
> ×2 or more, and a car on 102 inherited the previous car's id at ×9.5. The
> class set of this record's two relaxations is now one constant,
> `LINGERING_SUBJECT_CLASSES`.

## Context

On 2026-09-27, 35% of tracks were re-splits: one subject that never left the
scene was recorded as two ids. On camera 104 there were 283 unique re-splits.

- **50%** happened while the old track was still live or coasting (gap under
  4 s). These were association failures.
- **28%** had a gap where most frames carried zero detections. These were
  detector misses.
- **38%** had a gap of 4–12 s, which puts them in the graveyard band.
- Frames kept arriving throughout: 7–8 fps in 282 of the 283 gaps.
- The 4 s and 8 s coast budgets were never the constraint. The gaps failed on
  the gates, not on the clock.

Two mechanisms explain most of it.

1. **ByteTrack's low tier was dead code.**
   - The executor applies `minConfidencePerson` (0.65) before the tracker
     (`macroGateVerdict`).
   - The tracker's low tier starts at `byteTrackHighThreshold` 0.4. Nothing
     below 0.65 ever reached it.
   - The tracker logged about 1,550 person boxes that day, and none scored
     under 0.65.
   - The score histogram rose toward the cut: 0.65–0.70 = 583, 0.70–0.75 = 372,
     0.75–0.80 = 242. The distribution is truncated, with its mode in the first
     band.
   - The detector-dropout skip made it worse. It counted `frame.detections`
     only, so a frame holding only a 0.5 person looked like a glitch and never
     reached `update()` at all.
   - Nothing counted the refused boxes, so the share could not be measured.
     The executor carries them on `FrameResult.discarded` for the ghost overlay
     and did nothing else with them.
2. **The graveyard gate was flat, and for a person it was not even
   reachable.**
   - Resurrection measured proximity with a flat `0.75 × diagonal`. It kept that
     on purpose (D399): the pass was written for "a flickering stationary
     object".
   - Separately, the centroid clause was vetoed for any box that would spawn on
     its own (`isPlausibleBirth`). Every person above 0.65 is such a box.
   - So for a returning person, only an IoU of at least 0.1 with the corpse's
     last box could resurrect the id. The reach was never the question.

## Decision

**A box the class floor dropped is continuation evidence, and nothing else.**

- **Where it enters:**
  - `below-threshold` entries on `FrameResult.discarded` qualify when the score
    is at least `lowScoreContinuationFloor` (0.35) and the class is `person` or
    `animal`.
  - They pass the camera's detection-zone rules first.
  - They reach the tracker on a SEPARATE list, `TrackerFrameContext.lowScore`.
- **What they may do.** One stage runs after every confident claim. On the
  predicted box, at `byteTrackLowIouThreshold`, a low box may keep a
  **confirmed**, unmatched, **same-class** track alive. It moves only
  association state: `bbox`, `lastSeen` and `age`.
- **What they may not do:**
  - add a hit;
  - touch the score, class, vote, path or velocity;
  - spawn, continue a provisional track, rescue or resurrect.
- **How the held track is emitted.** It goes out exactly as a coasting track:
  the last CONFIDENT box and score, and `matchedThisFrame: false`. The only
  addition is `heldByLowScore: true`.
- **The bound.** A hold ends `lowScoreContinuationMaxMs` (8000) after the last
  confident box, whatever the low boxes say.
- **Dropout skip.** A frame carrying a continuable box is not a dropout
  (`dropoutEvidenceCount`).

**The resurrection reach grows with the gap, up to a cap.** This amends
D399's "the resurrection pass keeps the flat budget" (D399 carries the note).

- The reach is `resurrectionReachPx`: diagonal × clamp(0.25/s × gap, 0.75, 2.0).
- The plausible-birth veto is lifted only for a **sole subject**. That means no
  same-class live track or resurrectable corpse beside the corpse, and no other
  box of that class on the frame. This is the exception the rescue pass already
  has.
- **Sub-floor boxes count as peers** (review C1). A `lowScore` box of the
  corpse's class makes the scene ambiguous, unless it sits on `det` itself
  (IoU ≥ `byteTrackLowIouThreshold`), which makes it the same subject read
  twice.
- **A veto-lifted bind names itself.** It emits `resurrectionScene:
  'sole-subject-veto-lifted'`, never plain `sole-subject`. The face recognizer
  quarantines the held face (it loses `recognizedIdentityId`) on every scene
  except `sole-subject`. What happens to the NAME depends on the scene:
  - **`sole-subject-veto-lifted`** (a proximity bind):
    - The identity aggregate is STASHED and reset. `updateTrackAggregate` keeps
      an assignment through every unmatched frame, so without the reset a
      stranger carried the name and an "unknown person" was never unknown. The
      "incomparable" verdict (a probe from another face model) is the path
      where nothing else stops it.
    - The identity label already written is retracted from the track and its
      events.
    - The first face-bearing frame decides. `confirmed` (cosine against the
      held face) restores the stash and rewrites the label, so the same person
      gets the name back immediately. `rejected`, `incomparable`, or no face
      before the track ends discards the stash; only `confirmFrames` new
      matches name the id again.
  - **`multi-subject`** (a bind that needed IoU ≥ 0.3): unchanged from before
    D665. The aggregate stays, and the next face confirms or rejects by cosine.
    A seated person occluded for a few seconds keeps the name at no cost. A
    `rejected` verdict is a proven subject change: the aggregate is deleted (as
    before), and now the written identity label is also retracted.
  - **Retraction is attributed.** `retractFaceIdentityLabel` clears tier 2 only
    when the label's `subLabelMeta.stepId` is `face-recognizer`. It never
    clears a plate or an operator's assignment. It then re-runs
    `recomputeTrackImportance`, which is a no-op while the track is active.
  - Notifications already sent are not unsent; the outbox is immutable. A
    `track-end` identity rule fails closed if the name never comes back.
- The crowd guard is unchanged (IoU ≥ 0.3 while a peer is present).
- **The switch is per camera, with no redeploy.** `resurrectionTimeScaled`
  (tracking setting, default ON) restores the flat gate and the veto. A settings
  patch rebuilds the camera's processors on the next frame.

**A sub-floor box on a confidently claimed box is a shadow** (review C2). The
continuation stage skips any low box whose IoU with a box a confident detection
claimed this frame is at least `byteTrackLowIouThreshold`, and counts it as
`shadowed`. Without this guard, a person read a second time as `animal` 0.4
(under the animal floor) dragged the dog's coasting track onto the person, and
`resolveDuplicates` deleted it with no graveyard entry.

Two C2 residuals remain. "Claimed this frame" means claimed by stages 1a–1c.
- A box resurrected or spawned later in the same frame (4a/4b) is not yet
  claimed, so a sub-floor box on it can continue another track for that one
  frame. The next frame the subject is matched, and `resolveDuplicates` needs 5
  frames, so exposure is one frame.
- Two tracks both coasting, with an `animal` sub-floor box on the person's
  prediction, can still walk the dog's track onto the person: there is no
  confident claim to shadow against.

Both are rare. Watch `shadowed` and `continued` on the per-camera line.

**`resumed` counts only holds the tier kept** (review I2). `lowScoreHeld` is
cleared when a track is dropped, so a later resurrection counts as the
graveyard's win.

**The floor's drops are counted.** The per-camera `pipeline stats` line gains
`belowFloor`, keyed class → score band (`<0.35`, `0.35-0.50`, `0.50-0.65`,
`>=0.65`) → count. `{}` is a measured zero. Post-analysis adds one line per
camera per minute, `tracker: low-score continuation`, with these fields:

- `offered`
- `continued`
- `resumed`: a hold that ended in a confident box again, meaning an id the tier
  kept
- `sustainCapDrops`
- `shadowed`
- `windowMs`

### Why 0.35, why 0.25/s, why 2.0

- **0.35.** The observed distribution is truncated at 0.65 with its mode
  against the cut, so there is mass just below it. 0.35 takes a 0.30-wide band
  under the default and sits under the old `byteTrackHighThreshold` (0.4), which
  was chosen with a low tier beneath it. The risk is bounded by the contract:
  such a box can only extend a track that already exists, on its predicted box,
  for at most 8 s. `belowFloor` is the histogram to re-tune it from.
- **0.25 diagonals/s.** A subject nobody has boxed for more than 4 s stood
  still or was half-hidden; a striding person is detected. At the 4 s floor of
  the graveyard band this gives 1.0 diagonal. The refused returns on 104 sat at
  0.79–1.37 diagonals, which this covers from about 5.5 s of gap.
- **Cap 2.0, reached at 8 s.** Beyond two of its own diagonals, a returning box
  is as likely to be the next subject through the same door.

### Consumers, and how each is guarded

A low box never enters `frame.detections`. Every consumer below reads either
detections or the tracker's emission, and a held track's emission is a
coasting track's. Each consumer was already required to ignore coasting frames.

| Consumer | Guard |
| --- | --- |
| Executor children (CLIP, face, plate, classifiers) | Never run on a discarded box. Children run only on boxes that passed `macroGateVerdict` (executor.ts). |
| Recorder object trigger, detection-source plan | Read `detections` through the same `macroGateVerdict`. The discard trail is not read. |
| Frame-processor bbox side tables (labels, embedding, face, plate, mask, native recovery, birth evidence, source id) | Keyed by the bbox OBJECTS of this frame's detections. A held track emits its confident box from an earlier frame, which matches none of them. |
| Zone membership, zone enter/exit, tripwires, birth-zone seeding | Computed on the emitted box, which is the last confident one, so a refused box cannot move a track across a zone. The path is not extended. |
| Event emitter, object events, notification rules | Driven by the tracker emission and `StateAnalyzer`. The held emission is identical to a coasting one: same box, score and velocity, and no new hit. A low box cannot create a track, so it cannot create a `new track` event. |
| Track store positions and `lastSeen` | `matched: t.matchedThisFrame !== false` (index.ts upsert). A held frame appends no sighting. |
| Best shot (D400), key frame, first/last frame, snapshots, raster fallback | Every capture path skips `matchedThisFrame === false` (index.ts first-frame retries, raster fallback, capture loop). |
| Detail dispatcher (CLIP/face enrichment triggers) | `frame.matchedThisFrame === false` is counted as `coastedFramesIgnored` and returned. |
| Face recognizer: held face, identity aggregate, track label (C1) | A resurrection bound on proximity with the veto lifted emits `sole-subject-veto-lifted`. `face-recognizer.ts` quarantines the held face on every scene but `sole-subject`. On `sole-subject-veto-lifted` the aggregate is stashed and reset, and the face-recognizer's tier-2 label is retracted (`retractFaceIdentityLabel`, attribution-guarded). The first face decides: `confirmed` restores the stash and rewrites the label; anything else leaves the id unnamed until `confirmFrames` new matches. On `multi-subject` the pre-D665 cosine path is kept, and a `rejected` verdict now also retracts the label. |
| Birth / confirmation gate | Only confirmed tracks are continued, and `birth-first-frame-gate` skips unmatched frames. |
| Stationary registry evidence | `trackOffersEvidence` requires `matchedThisFrame !== false`. Vehicles are excluded from the tier, because a sub-floor box on a parked car is the D410 hop. |
| Tracker internals (occluders, spawn-beside-coasting report) | Occluders are built from confidently matched tracks only. |

## Consequences

- **A track may now outlive its subject by up to 8 s instead of 4 s.** This
  happens when a sub-floor box keeps overlapping its prediction, for example a
  person walking past the 0.50 ornamental grass of 2026-07-30. Downstream this
  looks like a longer coast: the track leaves later and no media is added.
- **A confident box meeting a held track binds to it on the strict pass.** This
  is the point of the tier. It also means a second subject arriving exactly
  where a held phantom sits inherits the id. Before D665 the same box would
  have faced the graveyard.
- **A sole subject can be resurrected up to 2 diagonals away within the
  graveyard window.** A different person entering alone within 12 s through the
  same area can inherit the id. The crowd guard does not help there, because
  there is no crowd.
- **`rescueCentroidFactor` governs neither salvage pass by default any more.**
- **Out of scope, as follow-ups:**
  - Appearance-verified stitching of crowd-guard and geometry refusals, using
    the SigLIP and face embeddings already computed for every track (report
    R4).
  - The native class-flip keep-alive (R6).
  - The lifetime cap (R5).
  - The int8 model score shift (R7).

## Measuring the effect live

1. **Re-split share per camera, before and after.** Use the heuristic in
   `truncation/analyze.cjs`. A track A is re-split when a later track B of the
   same `className` starts within 15 s of A's `lastSeen`, and B's normalised
   position envelope is within 0.05 of A's (`near`). The share is re-splits
   divided by tracks, per camera. Compare the same weekday hours on the day
   before the deploy with the first full day after. 104 read 50% on 2026-09-27
   and 1443 read about 40%.
2. **Split by gap band** (`deep.cjs`: under 1 s, 1–4 s, 4–8 s, 8–15 s). The
   tier should shrink the under-4 s and "detector empty" rows. The resurrection
   change should shrink the 4–12 s band.
3. **`tracker: low-score continuation` per camera.**
   - `resumed / continued` says how many holds ended in the same id.
   - `sustainCapDrops` climbing on one camera points at a standing sub-floor
     phantom there.
4. **`pipeline stats` → `belowFloor`.** Look at the person `0.35-0.50` and
   `0.50-0.65` bands on 104 and 111 against 112/101/102. If the indoor cameras
   carry most of it, that confirms mechanism 1.
5. **`tracker: salvage bind`** with `stage: resurrection`, `gate: centroid`.
   These lines are new binds that the flat gate or the veto used to refuse.

## Enforcement

- `sort-tracker-low-score-continuation.spec.ts` pins the contract: continue,
  never spawn, never continue a provisional track, never resurrect, class match,
  coasting emission, and the sustain cap.
- `sort-tracker-resurrection-gap-scaled.spec.ts` covers the 4.5, 6 and 11 s
  gaps, the cap, the crowd, and a live peer with the guard off.
- `frame-processor-low-score-continuation.spec.ts` covers the discard trail and
  the zone rules. `dropout-skip.spec.ts`, `below-floor-tally.spec.ts` and
  `timing-sampler.spec.ts` cover the dropout skip and the counts.
- `face-recognizer-veto-lifted-resurrection.spec.ts` covers the stranger
  (unknown, with and without a face), one matching face not being enough, the
  same person restored, and a plain sole-subject keeping the identity.
  `tracking-settings.spec.ts` covers the per-camera switches.
- 22 disarms, all red; each one is listed with its failing test in
  `scratchpad/tracker-fix-report.md`.
