---
id: D497
title: A stationary BIRTH has its own plausibility bar, and an entry that could not be born may not absorb a neighbour
status: superseded
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-birth-guard.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
---

## Context

> Superseded by [D508](adr-0508-stillness-has-one-authority-per-occasion-and-size-is-answered-by-reach-not-by-birth.md) on 2026-09-16: the area bar refused the operator's own car (0.360) while the ghost measured 0.361, and the oversize case is now answered by the matcher's reach (`OVERSIZE_AREA_FRAC`), not at birth. The artifact rule this record kept is the whole birth bar now.

On 2026-09-14 device 102 (the operator's parking lot) minted a stationary entry
at 08:33 with a **1669x1796 box in a 3840x2160 frame** — 2,997,524 / 8,294,400 =
**0.361 of the frame**. It is the dawn "envelope exploded" false positive, and a
third of the camera's view is not a parked object.

The birth was guarded, by `isPlausibleThumbnailBox`. That guard answers the
right question for a THUMBNAIL — "is this crop the whole washed-out scene?" —
and refuses only a NEAR-full-frame box (≥ 0.85 of the area, or ≥ 0.95 of one
dimension). 0.361 sailed through it.

It did not stop at being wrong about itself. An entry that large reads as a
container: `entrySwallowsDetection` calls any much-smaller contained box a
FRAGMENT of the entry, and the scene-sized escape hatch that exists for exactly
this case — `SCENE_BOX_AREA_FRAC = 0.55` — sits ABOVE 0.361. So the
duplicate-collapse pass (D495) folded a genuinely different parked motorcycle
into the exploded row and deleted the motorcycle's row.

The obvious move, lowering `SCENE_BOX_AREA_FRAC`, is the wrong one: that
constant was measured against device 3829's SUV at ~0.78 of 4K and it decides
what the suppression MATCHER holds on every camera. Changing it changes what the
filter suppresses; the defect is about what may be CREATED.

## Decision

A birth asks `isPlausibleStationaryBirthBox`, not the thumbnail guard. A box
covering **`BIRTH_MAX_AREA_FRAC` = 0.30** or more of the frame may not become a
stationary entry, and the refusal is logged with `tags: { deviceId }` plus the
`areaFrac` it failed on. The near-full-frame and full-dimension artifact rules
are kept, not replaced — the birth bar is a superset of the thumbnail guard.

And an entry that could not be born TODAY may not ABSORB a neighbour:
`promote()` and `collapseDuplicates()` ask the occupancy question
(`findParkedOccupant`) only of entries that clear the birth bar.

0.30 is chosen so that: the measured 0.361 birth is refused with ~20 % of
margin; the bar sits below `SCENE_BOX_AREA_FRAC` (0.55), so nothing can be born
into the band [0.30, 0.55) where a row is big enough to swallow every small box
as a "fragment" and too small for the scene-sized guard to disarm it — that band
is the whole mechanism of the 102 motorcycle loss.

## Consequences

- A genuine parked object closer to the lens than 30 % of the view no longer
  earns an entry on that camera. Device 3829's SUV (~0.78) would not be re-born.
  The trade is deliberate: such a row is already neutered as an entry by the
  scene-sized guard, while a false one at 0.36 actively destroys its neighbours.
- **Existing oversized entries are NOT retired.** They have been confirmed by
  frames over time — evidence a birth never had — and they cannot be re-born
  under the bar, so a retirement would be permanent and would hand the object
  back to the tracker forever. They are refused exactly one thing, absorbing,
  and otherwise live out their TTL. `load()`'s hydrate purge stays on the
  near-full-frame rule for the same reason.
- `SCENE_BOX_AREA_FRAC` keeps its meaning and its measurement.

## Enforcement

`pipeline/stationary/__tests__/stationary-birth-bar.spec.ts`: the predicate on
the measured 102 numbers, the registry refusing to absorb the motorcycle into
the exploded row, a control that a normal row still collapses its duplicate, and
a structural check that `birthStationaryFromEvidence` asks the birth bar and
logs the refusal with the device tag.
