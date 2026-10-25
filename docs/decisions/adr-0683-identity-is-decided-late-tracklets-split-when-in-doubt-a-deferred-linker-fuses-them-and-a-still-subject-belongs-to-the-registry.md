---
id: D683
title: Identity is decided late — tracklets split when in doubt, a deferred linker fuses them into one track, and a still subject belongs to the parked-object registry
status: accepted
date: 2026-09-29
supersedes: D665, D678
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/**
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-fusion-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-fusion-leaf.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/promotion-plan.ts
  - packages/addon-pipeline/src/pipeline-runner/appearance-descriptor.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/tracking-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
---

## Context

Eighteen tracker ADRs in 33 days each repaired a rule the previous one had
already moved, on the same two cameras:

| record | date | what it moved | what came back |
| --- | --- | --- | --- |
| [D258](adr-0258-a-track-is-never-handed-to-a-detection-that-could-be-born.md) | 08-27 | a `growthAdjacentMatch` reach of `1.35× diag` handed a parked car's plate to a different car 573.8 px / 106 ms away | [D535](adr-0535-growth-rescues-a-fragment-never-a-settled-whole-object.md): the same clause rescued a 1130 px jump onto a different parked car three weeks later |
| [D283](adr-0283-a-re-attached-id-does-not-carry-a-face-nobody-re-confirmed.md) | 08-29 | a resurrected id shipped a face captured under its PREVIOUS incarnation, 8 s before the row's own `firstSeen` | the resurrection mechanism itself stayed; only the evidence-carry was patched |
| [D399](adr-0399-re-acquisition-is-a-speed-budget-not-a-distance-one.md) → [D535](adr-0535-growth-rescues-a-fragment-never-a-settled-whole-object.md) → [D543](adr-0543-the-prediction-freeze-is-per-camera-opt-in-and-the-cadence-is-divided-out.md) | 09-08→19 | flat per-frame distance budgets, one at a time, each proven wrong by a live case | a time-scaled budget, then a stillness freeze, then its own cadence bug |
| [D436](adr-0436-the-crowd-guard-says-how-crowded-it-was.md) | 09-10 | the crowd guard refused 191/510 splits on a camera with no actual crowd (median `centroidDist/reach` 0.55, 81 already overlapping) | measured, not fixed — the guard's binary question stayed |
| [D442](adr-0442-a-flip-votes-without-renaming-and-an-established-id-claims-first.md) | 09-10 | one person crossing camera 101 in 8 s became three ids; an "established id claims first" pass order was added on top of the flip-without-renaming fix | a pass-order rule is itself a hand-tuned heuristic, same class as what it replaced |
| [D399](adr-0399-re-acquisition-is-a-speed-budget-not-a-distance-one.md) → [D665](adr-0665-a-box-under-the-class-floor-may-continue-a-track-and-do-nothing-else.md) → [D678](adr-0678-a-proximity-resurrection-needs-the-corpses-size-and-a-vehicle-keeps-the-flat-graveyard-gate.md) | 09-08→29 | the graveyard reach went from flat, to time-scaled, to area-ratio-bounded, in three records in three weeks | 18 of 41 sampled centroid binds on 09-28 still bridged ×2 or more; a car on 102 inherited the previous car's id at ×9.5 |
| [D391](adr-0391-a-track-that-never-emitted-is-a-dropped-detection-and-reports-as-one.md) | 09-07 | silent accept-then-discard branches got a refusal vocabulary (`merged-duplicate`, `unconfirmed-spawn-lost`) | naming the silence did not remove the mechanism producing it |

Every one of these records is correct on its own measurement and wrong about
the shape of the fix: a flat multiple, a crowd count, a pass order, a reach
formula, a refusal name — each is a patch on an **online, single-hypothesis**
tracker that must commit an identity the instant a box arrives, from geometry
alone, on cameras that deliver **56 ms to 2135 ms** between stored positions
(D399) and 4–10 fps overall. Camera 103 produced **80 tracks for one person
sitting in one seat** in a single session: not 80 failures of 80 different
rules, but one structural fact — a tracker that must decide NOW cannot also
decide CORRECTLY when the evidence that would settle it (a face, a second
sighting, a competitor leaving frame) arrives seconds later.

The 2026-09-29 analysis of cameras 101/102 (04–18Z across four days) found
tracker-level confusion itself rare (0–6 cases per 100 person tracks) but
systematic in shape: id swaps inside a group, owner-and-dog, a stopped track
"trampled" by a walking one, parked cars alternating. All four shapes are the
same error — an online association forced to choose before the ambiguity that
caused it has resolved. No further geometric rule closes that gap; the fix is
structural, not a 19th tuning record.

**Operator decision, 2026-09-29 (binding):** replace the tracker directly.
No shadow deployment, no runtime switch between old and new — the rollback
path is the previous release, not a flag. The branch went into a live trial
2026-10-01 06:45 (70 fusions in the first 90 minutes, 0 failures).

## Decision

Tracker v2 splits identity into three separable questions, each answered by a
different layer, none of them answered by guessing.

**§3 — L1: when in doubt, split.** `TrackletTracker` is a conservative online
tracker: Hungarian minimum-cost assignment per frame, and an ambiguous
pairing — a `swap` (crossed pairs cheaper than the chosen ones by
`SWAP_MARGIN`), a `rival` (a second box this close in cost) or a
`competitor` (a second tracklet this close) — **ends every tracklet in the
group and lets the group's detections spawn new pieces.** It never merges,
never resurrects and never grows one box into another's identity (D258's and
D535's clauses have no equivalent here). A split piece's doubt is bounded
(`CONTESTED_MAX_MS`, 3 s): past it the piece is confirmed and emitted anyway —
an alert is never lost to doubt — but it keeps `contestedHits`, so L2 may
still join it on appearance alone. A cross-class flip (D439: a bending person
read as `animal` for a frame) still **votes** the reported label without
renaming the tracklet's own class — the one piece of the old pass-order
record (D442) that survives, because it is not an ordering heuristic, it is a
read of the box itself. The "established id claims first" half of D442 has no
replacement: Hungarian assignment has no pass order to tune.

**§4 — L2: fuse late, final, under the earliest id.** `TrackletTracker`'s
output is PIECES, not subjects. A deferred linker (`linker.ts`) decides,
seconds later, whether two pieces are one subject — with the future already
in hand: an arc "B continues A" is only even considered once A has ended (or
is coasting) and B is confirmed, and it only COMMITS once every piece that
could compete for A is also known (every relaxation the online tracker made
on the spot — D665's reach, D678's size bar, D399's time-scaled budget — is
now a feasibility bound or a cost term of ONE function, decided with
hindsight instead of guessed in the moment). A commit is **final**: the
survivor is the chain's earliest id, and a later disagreement (two different
settled face identities on one fused chain) is reported (`tracker: a fused
track now carries two identities — fusion is final`, WARN) and never undone.
A predecessor that could have been continued by either of two competing
successors, and lost to the first, never goes to the second afterwards — a
competitor that was refused keeps competing.

**§5 — a subject is a track while it moves; a still subject is the
registry's.** L1 carries **no presence state at all** — there is no second
stillness authority beside the independent parked-object registry (D547).
While a subject moves, it is a tracklet. The instant the registry's own
evidence ledger promotes it (unchanged: D547's artifact and oversize rules,
D174's re-anchoring, D279's independent-read departure, D410's suppression
before L1 ever sees the object), the promoted subject's **track closes** —
the registry is now the only place it exists, as occupancy. A track that
**ever moved** (arrived, walked to its seat) closes normally, through the
ordinary close gate, so a later return within the link window can still be
linked to it (`stationary` tracklet end-reason). A track that **never
moved** (the object was already sitting there on first sight) was never a
moving subject and is disposed exactly as D547 always disposed it — deleted,
row and media, because the registry does not want a parked object persisted
as a track too. "Moved" is answered once, scale-relative to the subject's own
box (`DEFAULT_STILL_SPAN_FRACTION`, 0.35× the first box's short side), the
same test the state analyzer already used for stillness — no new constant.

**The model-free descriptor (§8).** Appearance is a 96-integer histogram per
box (`appearanceCrop`, 16×32 RGB view): a Bhattacharyya distance per
hue×saturation / value / gradient-orientation block, upper and lower half
separately, colour and gray kept as separate running means so a dusk IR read
never pollutes a daylight one. No learned weights (O6) — it is a fixed
comparator, not a model. It is attached to every first-level box by the
RUNNER (`attachAppearanceDescriptors`, `packages/addon-pipeline`), cut from
the same raster the birth-evidence crop already holds, and may resolve an L1
ambiguity, add to the L1/L2 cost, reject an L2 link, or be the ONLY evidence
for a piece that stayed contested past `CONTESTED_MAX_MS`. It is **off by
default** (`APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT = false`): unproven cost
until it is calibrated against tapes that carry it (tracked as a follow-up),
read from one authority both the runner's cost gate and the tracker's own
default share, never two copies of the same decision.

**Downstream invariants (§6.1).** A fusion never touches a closed track — the
service checks both rows active before any step, so a refusal leaves extra
ids outstanding rather than a mix-up. Every store that can delete a track's
rows can also re-point them (`TrackLeafStore = TrackScopedStore &
TrackFusibleStore`): one registry (`buildAnalyticsFusionRegistry`) serves
both the retention cascade and a fusion, built from the same stores in the
same order, so a leaf that forgets fusion does not compile. `TrackFusionService.fuse`
is the ONE choke point that turns an L2 decision into effects everywhere —
residents, recognizers, live dispatcher state, the lifecycle `end`, the store
row merge, every leaf — in one fixed order, and `sweepUp` re-runs the leaves
once more right before the survivor's row closes, so a write that landed
under the absorbed id after the fusion (a queued capture, a detail result)
still moves. An absorbed id resolves to its survivor **forever**
(`TrackAliasStore`), at every read the addon exposes by track id — derived
from each capability's own method schemas, so a method added later is
covered without a list to maintain.

**The Notification Center owns duplicates (§6.5).** There is no notification
hold. Two provisional ids of one subject may each fire a rule; the NC's
cooldown key (`cooldownKey(rule, subject)`) never contains a track id, so
both ids share one cooldown window on one camera regardless of whether or
when they are fused — pinned by a test against a regression that would key it
by track.

**Operator decisions named.** 2026-09-29: replace the tracker directly (no
shadow, no switch; rollback is the previous release — see Context). 2026-09-30
(round 4, binding), replacing the rounds 2–3 design before anything in it was
committed: (a) there is no notification hold — the rounds 1–3 Task 19
(`continuation-hold.ts`, `HOLD_MAX_MS`, the outbox `holdUntil`/`release`/
`dropHeld`) is cancelled; the NC's existing cooldown already covers it; (b) a
subject is a track while it moves, a promotion ends its track — the rounds
2–3 "holder" design (`holderLiveAt`, `rekeyHolder`, `releaseHolder`, a TTL
skip and a `'holder-moved'` reason) is cancelled: the registry defers to
nothing, because a promoted subject is not a live track any more; (c)
stationary is occupancy only, for every class, with face/plate recognition,
the detail plane and best-shot evaluation stopping with the track; (d) extra
ids are preferred over mix-ups — a refusal that leaves two tracks is always
chosen over a fusion that might be wrong; (e) exits stay immediate, the NC
owns their timing; (f) the recognition wait is capped at 20 s.

## Consequences

- A track close now waits for tail finality, not only the TTL: a row may
  outlive its 30 s TTL (`TrackStore`'s hardcoded `DEFAULT_CONFIG`, unchanged)
  by up to **~25 s after its last sighting** while `TrackerSweep.canClose`
  still holds it — either the tracklet is still live on some processor, or L2
  has not yet made its tail final (it could still be chosen as a predecessor).
  The addon's 5 s close sweep is what advances a silent camera's L2 at all.
- A subject that stops is a track until the registry promotes it, and then
  only occupancy. A promoted track that ever moved closes normally, through
  the ordinary close gate; one that never moved is disposed exactly as D547
  always disposed it. Face recognition, plate reading, the detail plane and
  best-shot evaluation stop with the track (operator decision 2026-09-30).
- Four ids for two people crossing in IR without appearance calibrated is
  accepted, never a mix-up (operator's extra-ids-over-mix-ups rule,
  confirmed on the live cases).
- Two provisional ids of one subject may each notify; the NC's per-device
  cooldown, not a tracker-side hold, owns the duplicate (operator decision:
  no hold).
- A piece that ends emits its own `leaving`/`end` before L2 has decided it
  will be fused into another track — a consumer may see
  `end(B, fusedIntoTrackId: A)` with no `start(A)` yet (a gate-deferred
  birth). Exit events stay immediate regardless; the NC owns their timing.
  HA's export ignores an `end` that carries `fusedIntoTrackId`.
- The recognition wait is capped at 20 s (`FACE_SETTLE_HOLD_MS`) — the
  operator's ceiling until a later measurement of the p90 of
  `identity.t − first face frame t` on committed tapes can lower it, never
  raise it. The identity cannot-link reads ONLY the FaceRecognizer's settled
  verdict — the same one D681 records on the tape; an operator assignment or
  a rescore pass is never read by the linker.
- A stored blob carrying only the legacy `maxMissedFrames` key (never the
  newer `maxMissedMs`) used to resolve through an alias to 3990 ms (30 ×
  the old 133 ms nominal frame); the resolver's default is now 4000 ms
  directly. Effect: 10 ms, for any blob that never set it explicitly; a blob
  with a hand-set `maxMissedFrames` and no `maxMissedMs` loses that
  customisation.
- Sixteen tracking settings are retired (§7 of the implementing spec):
  `maxMissedFrames`, `occlusionEnabled`, `occlusionContainment`,
  `occlusionMaxMissedFrames`, `occlusionMaxMissedMs`, `maxTrackLifetimeSec`,
  `rescueCentroidFactor`, `rescueIouThreshold`, `resurrectionWindowMs`,
  `stationarySpeedPx`, `dedupMergeIou`, `dedupMergeFrames`,
  `byteTrackEnabled`, `byteTrackHighThreshold`, `lowScoreContinuationMaxMs`,
  `resurrectionTimeScaled`. A stored blob keeps them harmlessly (the resolver
  reads only schema keys); a committed tape strips them from every header and
  processor record on read.
- Identity is not kept across a restart: face identities are per-boot
  pseudonyms (D681), unrelated to a track's own id or its fusions.
- The parked-object registry is the only stillness authority there is — L1
  was the second one, and it is gone.
- Tapes recorded under tracker v2 are schema version 2 (descriptor + fusion
  records); the previous release cannot read them. A v1 tape still reads
  under v2, upcast, with retired keys stripped.

## D52

`appearanceCrop` derives a rectangle from a box, the same shape of operation
[D52](adr-0052.md) reserves to `deriveDetailCropRect` for a vector-indexed
CLIP/detail crop. It is not a second instance of that rule: the appearance
descriptor is a fixed 96-bin histogram compared by Bhattacharyya distance,
computed and consumed entirely inside the tracker and the runner's cost
gate — it is never written to a vector store or served by a vector index.
Stated here so the next reader does not take `appearanceCrop` for a second
CLIP crop derivation and route a change to it through D52's convention.

## Enforcement

- Unit: `tracker-v2/__tests__/recorded-scenes.spec.ts` (the operator's own
  cases), `linker.spec.ts` (camera 102 at ×9.5 reach, camera 101 at ×3.6,
  face-bearing arcs), the D681 cases replayed through `CASE_TRACKER`,
  `track-fusion-leaf.spec.ts` (one registry, deletable and fusible),
  `track-store-adopt.spec.ts` (every `MutableTrackState` field has a
  declared merge rule), `track-resident-adopt.spec.ts` (every per-track RAM
  container has one), `promotion-plan.spec.ts` (moved vs never-moved,
  scale-relative), the NC cooldown-key pin in `rule-engine.spec.ts`.
- CI: `scripts/check-no-legacy-tracker.ts` — fails the build if a deleted
  module, a deleted identifier (`SortTracker`, `resolveDuplicates`,
  `resurrectionScene`) or a retired tracking-setting key reappears under
  `packages/*/src` or `server/*/src`, tests included.
- Review discipline: every implementation task of this record carries its
  own disarm-and-restore list in its commit message — each test named proved
  to fail when the behaviour it pins is removed, not merely to pass once.

**Amended 2026-10-01 ([D692](adr-0692-a-grouped-immediate-rule-waits-for-its-subjects-and-sends-once.md)), §6.5:** inside a grouped notification window, the NC merges a
fused pair into ONE member under the survivor id, so two provisional ids of one subject make
one tile. Outside a grouped window, §6.5 is unchanged: the cooldown key never contains a track
id.
