---
id: D596
title: An offered control carries a WARNING; an absent one carries a reason
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/types/src/interfaces/camera-switches.ts
---

## Context

`CameraSwitch` had one field for "something is not right here":
`unavailableReason`, which always came with `available: false`. So any truth
about a switch could only be expressed by REMOVING the control.

The privacy mask is where that broke. A camera that can store zones and has
none drawn resolved to `not-configured` — no control, with copy telling the
operator to go and draw a zone. The reasoning was sound in isolation: flipping
the master enable with no zones blanks not one pixel, and a control that
visibly does nothing teaches the operator the switch is broken (D62).

What it missed is the fleet. **Every camera in this deployment has zero privacy
zones** — that is the default state of the feature, not an edge case. So the
whole fleet showed the mask greyed out with an explanation, and the only
reading available to the operator is "my cameras cannot do this". The switch is
the entry point to the feature; greying out the one button that starts it is a
worse lie than a toggle that blanks nothing.

The viewer had already worked around it: `isZonelessPrivacyMask` re-read the
hub's `not-configured` and drew a live toggle anyway, with a warning. That is a
client disagreeing with the server about one hardcoded switch id — and the
write it enabled was then REFUSED by `camera-switch-service.ts`, because the
service quite correctly refuses to write an unavailable switch. The operator
got a toggle that always failed.

## Decision

`available` means the control is OFFERED and the write will be accepted.
Anything else true about an offered control is a `warning` — a code that
travels WITH the control, never instead of it. `unavailableReason` stays what
it always was: the explanation rendered in place of a control that is not
offered. The two never coexist on one row.

A privacy mask on a camera that CAN mask and has zero zones drawn is therefore
`available: true, warning: 'no-privacy-zones'`. The master enable is a real,
persisted camera setting; it simply has nothing to act on yet, and saying so
beside a working control is the honest surface.

`not-configured` is deleted. It had exactly one producer and this replaces it.

## Consequences

- The zero-zone write now reaches the camera. `camera-switch-service.ts` needed
  no change at all — it gates on `available`, which is the point of having one
  authority for that question.
- **`configuredRegions === null` stays unavailable and must.** Zero zones is an
  answer the camera gave; an unreadable status is the absence of one, and a
  toggle there would write to a camera whose state nobody can see (D315). The
  orchestrator and derivation suites both pin this pair apart.
- The viewer now reads `row.warning`. Its `not-configured` derivation survives
  as a fallback for a hub that has not been updated, fenced behind
  `!row.available` so it can never be a second opinion on a current hub.
- An unrecognised warning code renders `warnUnknown` rather than nothing:
  silence beside a live control is the same gap D62 exists to close.
- Train: `@camstack/types` must be published and a `@camstack/server` carrying
  it installed before the hub sends `warning`. Until then the viewer's fallback
  is what runs — and the write stays refused, because that refusal is in the
  orchestrator's copy of the derivation.

## Enforcement

Tests, not a guard. `packages/types/src/interfaces/__tests__/camera-switches.spec.ts`
pins all three privacy-mask states (zones / no zones / unreadable);
`camera-switch-service.spec.ts` pins that the zero-zone write is ACCEPTED and
touches only `patch.enabled`, and that the unreadable-count write is still
refused. The viewer's `camera-switches.spec.ts` pins both hub shapes and that
every key `switchWarningKey` can return exists in `en` and `it`.
