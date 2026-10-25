---
title: Detection quality — an improvement plan
last-verified: 2026-07-30
---

# Detection quality — an improvement plan

Written after a delivered notification ("Persona su Uscio", with a still and a
GIF) turned out to be **a dead ornamental grass in a gravel bed**, classified
`person` at 0.5005.

Everything below is ordered by value-per-effort, and every number in it was
measured on the live cluster rather than assumed. The one thing this plan
refuses to do is recommend a threshold without ground truth — see step 1.

## What we know today

Device 101, 24 h, 346 object-events:

| class | n | min | p25 | median | p75 | max |
| --- | --- | --- | --- | --- | --- | --- |
| person | 161 | 0.500 | 0.538 | **0.641** | 0.801 | 0.913 |
| vehicle | 146 | 0.500 | 0.529 | 0.597 | 0.663 | 0.845 |
| animal | 39 | 0.503 | 0.587 | 0.655 | 0.730 | 0.884 |

Two samples were checked against their stored media, not inferred:

- **0.855** → a real person walking a dog.
- **0.5005** → the plant.

That single pair is what justifies raising a floor at all: **a genuine subject
produces at least one high-confidence frame across its track; a phantom only
ever grazes the floor.** The track still forms from the frames that survive.

Already shipped from this: `minConfidencePerson` 0.50 → **0.65**. Vehicle and animal deliberately left at 0.50 — they have no
ground truth yet, and moving a floor without evidence is how detections are
lost quietly.

## 1. Ground truth first — everything else is guessing

**The blocker for every threshold decision is that we cannot say which of the
161 person events were real.** A distribution tells you where the mass sits, not
which side of it is correct.

- export a stratified sample per class — say 40 crops per confidence band
  (0.50–0.60, 0.60–0.70, 0.70–0.85, 0.85+) per camera;
- label them by eye (this is an afternoon, not a project);
- from that, read the actual precision at each candidate floor.

Only then are the vehicle/animal floors a decision rather than a coin flip. This
also produces, for free, the negative set that step 6 needs.

## 2. Suppress stationary phantoms — the highest-value idea here

The plant is **scenery**. Its bbox does not move, ever, across its whole life.
That is a far stronger signal than its score, and it is the exact signature of
the failure that started this.

The machinery already exists — the per-camera IoU stationary registry
(`stationary objects`, live since 2026-07-19). The addition is a rule: an entry
that has been stationary at essentially the same bbox for N minutes and is
classified `person` is scenery, not a person, whatever its score.

Two properties make this attractive:

- it is **score-independent**, so it survives a model swap;
- it costs nothing at inference time — the registry is already maintained.

Care is needed in one direction only: a genuinely motionless person (someone
standing at a door, someone asleep) must not be suppressed. Gate on a long
window and on the bbox being *identical* rather than merely overlapping, and
release the suppression the moment the box moves.

## 3. Confirm on the track, not on the first event

A rule fires on the FIRST qualifying event. A weak opening detection therefore
notifies even when the track later earns a confident one — and, worse, a track
whose ONLY event is weak is exactly a phantom.

Require, before notifying: best-of-track ≥ a bar, or K frames ≥ a bar.

This is a latency/quality trade and should be an operator choice per rule, not a
global default. The cost is a second or two of delay; the benefit is that the
"one weak frame" phantom cannot notify at all. On the incident that prompted
this plan the track had eight positions and one event at 0.5005 — it would have
been silenced without touching any threshold.

## 4. Check the guard that already exists

`fullFrameGuardMaxConfidence` drops near-full-frame / full-column / full-row
low-confidence boxes, and its own comment cites `cam-101 "vehicle 52%" over an
empty scene`. Confirm it is armed on the cameras that need it and that its bar
is set — a guard nobody configured is a guard that is not running.

## 5. Mask known phantom geography

The gravel bed is a fixed patch of the frame that generates people. A detection
whose centroid sits in an operator-drawn ignore zone should never become an
event.

This overlaps the absent `private-zones` capability (roadmap). Worth resolving
together rather than building a second masking concept.

## 6. Retrain — but last, and with the right data

Retraining is the durable fix and the slowest lever. Do it AFTER the floors are
raised, because the negative set then contains the phantoms that **survive**
0.65 — the genuinely hard cases — instead of being dominated by floor-level
noise a threshold removes for free.

Source the positives from the labelled sample in step 1.

## 7. Enablement follows configuration, never a parallel switch

Package detection shipped behind `packageDropEnabled`, an opt-in defaulting to
false. Device 101 on 2026-07-30 had:

- the zone (`Uscio`),
- an **enabled** `package`-stage zone rule (`Pacchetti`, `classFilter:
  ['package']`, `zoneIds: [Uscio]`),
- a notification rule on `delivery: 'package-event'`,

and produced nothing — because a boolean that none of those three surfaces
mentions was still false. Three layers of operator intent, defeated silently.

**The configuration IS the intent.** Drawing a zone and attaching an enabled
package rule to it is not a hint that the operator might want package
detection; it is the request. The flag now defaults to true and survives only
as an explicit per-camera OFF. Cameras nobody configured cost a class check and
one cached lookup, because the detector already returns early with no zone rule.

Generalise the rule: **when a feature has a configuration surface, that surface
is the switch.** A separate boolean is a second source of truth, and the failure
mode is always the same — silence that looks like the feature not working
rather than like it being off.

Worth an audit for the same shape elsewhere. It is the same family as a stale
docblock: during this investigation `resolveDevicePackageRules` claimed "the
`package` slice is written by the orchestrator's package-stage provider (a later
slice); until then this returns `[]` and no package events fire" — which was
untrue. The `zone-rules` capability with a `package` stage already exists and
101 already had a rule. Trusting that comment produced a confidently wrong
conclusion until the cap was actually queried.

## 8. Make the failure visible

None of this is measurable today. Two additions, both cheap:

- a **false-positive proxy** on the pipeline board: tracks whose entire life sits
  below the class median, per camera per day. It will not be precise, and it does
  not need to be — it needs to move when quality moves.
- **event provenance in the notification log.** The `rule matched` and
  `notification delivered` lines carry `ruleId` and `rule` but **no eventId and
  no trackId**, so tracing a delivered notification back to the detection that
  caused it means hand-correlating timestamps. That correlation cost real time
  during this very investigation.

## What this plan deliberately does not say

It does not name floors for vehicle and animal. Not because they look fine —
vehicle's median (0.597) is *lower* than person's, which is mildly alarming —
but because step 1 has not been done for them, and a number chosen without it
would be exactly the kind of confident guess this document exists to avoid.
