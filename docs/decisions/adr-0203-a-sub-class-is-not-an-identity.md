---
id: D203
title: A sub-class is not an identity — the static gate reads tier 2 only
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/key-event-scoring.ts
---

## Context

`computeImportance` demotes a track that never moved by a factor of ten
(`STATIC_IMPORTANCE_MULTIPLIER`). That gate is what keeps a pile of clothes read
as a person, or a parked car, out of the events feed. It has one exemption:
**an identified track is never suppressed**, because a recognised face or a read
plate is worth surfacing even standing still.

The exemption was implemented as `input.label !== undefined`, and the call sites
filled `label` from `displayLabel(t)` — which is `subLabel ?? label`.

That was correct until the 4g label tiering split the one label column into two.
After it, `displayLabel()` falls back to **tier 1, the SUB-CLASS**, whenever no
identity exists. So every value the vehicle classifier writes — `Car`, `van`,
`truck` — arrived at the gate wearing the word "label" and vetoed the demotion.
The classifier writes one on essentially every vehicle track, and a parked car
is the single most common motionless subject on this fleet.

Measured on the live fleet on 2026-08-20: **68 tracks a day** kept ten times the
importance they had earned, all of them scenery. Nothing in the code was
locally wrong — `label` meant "identity" when it was written, and it quietly
stopped meaning that in a different file.

The comment at the second call site made it worse rather than better. It read
*"the SCORER asks 'is this track identified' — it wants the finest thing known,
not one tier of it"*, which is true of the caption and false of the gate. A
leftover that describes the right design for the wrong consumer reads as
verification.

## Decision

`ScoringInput` carries the two tiers **separately**, and the static-track gate
reads **`identityLabel` — tier 2 only**.

- `label` is the DISPLAY caption (`subLabel ?? label`). It feeds the identity
  WEIGHT (0.05) and nothing else: a track somebody could name is worth a nudge
  over one nothing described, whichever tier named it.
- `identityLabel` is the tier-2 value alone — a recognised face or a read plate.
  It is the ONLY thing that exempts a motionless track from the demotion.

A sub-class says WHAT a thing is; only tier 2 says WHO it is. Only the second is
a reason to surface something that did not move.

## Consequences

- Every caller of `computeImportance` must decide, explicitly, which tier it is
  handing over. Passing `displayLabel()` to both fields is the defect this
  record exists to name; passing it to neither loses the caption weight.
- Parked vehicles carrying a classifier sub-class drop back below the key-event
  threshold. That is the intent, and it is visible: ~68 tracks/day on this fleet
  change salience by 10x on the first pass, plus every legacy row rescored on
  read by `rankKeyEvents`.
- A plate that IS read still exempts the vehicle, because the plate lands in
  `subLabel`. So does a named face. Nothing that was ever genuinely identified
  loses its exemption.
- The importance stored on a row is not recomputed by this change. Rows scored
  before it keep their old number until something rescores them; the on-read
  path (`rankKeyEvents`, for rows with no persisted importance) uses the new
  rule immediately.

## Enforcement

`key-event-scoring.spec.ts` pins all four cases directly against the exported
constants: tier-1-only is demoted by exactly `STATIC_IMPORTANCE_MULTIPLIER`,
tier-2 exempts, tier-2 exempts even with a tier-1 riding along, and an empty
tier-2 string is not an identity. The two call sites are pinned in
`track-close.spec.ts` and `key-event-query.spec.ts` — remove either
`identityLabel:` line and the corresponding spec goes red.

No guard script: the failure was a semantic drift inside one field, and a
name-based check cannot see it.
