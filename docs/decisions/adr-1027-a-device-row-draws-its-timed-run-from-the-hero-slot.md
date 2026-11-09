---
id: D1027
title: A device row draws its timed run from the hero slot
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/types/src/device/hero/hero-row.ts
  - packages/types/src/device/hero/hero-model.ts
  - packages/ui-library/src/composites/device-controls/timed-run-row-control.tsx
  - packages/ui-library/src/composites/device-item/actions.tsx
---

## Context

A timed run (D993) turns a heater or a pet fountain on and switches it off at
a deadline. The device page already shows that run. The list row did not: it
drew only the primary control, so a stove that was heating showed a power
switch and no time left.

The same control would be useful on any device that already has a `switch`
cap. Offering it there now would put Run on lights, fans and sirens before
the switch capability is one cap (#462). That opt-in waits.

## Decision

The device row is a projection of the hero model (D1023). When the model
carries a `timedRun` slot and the caller may act on it, the row draws Run
(the one-tap duration) while idle and Stop while armed, and the status line
ends with the time left. The slot is the only source: the row computes no
deadline of its own. `timed-run` stays offered only to `Heater` and
`PetFountain` (`TIMED_RUN_DEVICE_TYPES`). A timed run on any other switch
waits for the switch-cap unification (#462).

## Consequences

A type that is not in `TIMED_RUN_LIMITS` has no slot, so the row draws no
Run control even if a `timed-run` binding is present. Extending the run to
every switch is a later change, with #462, not a per-type default on this cap.

## Enforcement

`hero-row.spec.ts` asserts Run, Stop and the time left from the slot.
`build-hero-model.spec.ts` asserts a switch is offered no timed run.
`timed-run-row-control.test.tsx` draws the same control.
