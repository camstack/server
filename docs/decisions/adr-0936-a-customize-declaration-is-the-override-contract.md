---
id: D936
title: A customize declaration on the capability is the override contract
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/capabilities/customize-catalog.ts
  - packages/types/src/capabilities/battery.cap.ts
  - packages/types/src/capabilities/running-state.cap.ts
  - packages/types/src/composition/customize/override-draft.ts
  - packages/types/src/generated/customize-catalog.ts
  - scripts/check-customize-declaration.ts
  - scripts/check-customize-bespoke-card.ts
  - scripts/lib/customize-declaration.ts
  - scripts/lib/customize-bespoke.ts
---

## Context

Each simple device assignment shipped as its own card and its own builder:
battery, consumables, running-state, doorbell, and motion's camera-sensor
list. A second card that stored the same fact under another name would be a
second authority. The approved design treats motion and doorbell as the two
event shapes (`pulse` and `span`) of one declaration, and leaves the composer
and the existing write (a composition claim, or `setCameraSensors`) as the
only evaluators.

## Decision

A capability that can be overridden declares `customize`: scalar, keyed array,
or event (`pulse` or `span`). The declaration is the contract. Codegen
projects `CAP_CUSTOMIZE_CATALOG` with field kinds, nullability and allowed
transforms, and no Zod. A saved assignment is an `OverrideDraft`; effective
authority is `CustomizeAssignmentStatus`. Both types are `z.infer` of their
schemas. Battery, running-state, consumables, doorbell and motion all
declare it. [D944](adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md)
limits every target to `apply: 'add'` and removes `advanced: 'derive'`.

Identity, numeric self-transforms and linked devices stay outside. They are
different authorities, not copies of this card.

## Consequences

- Admin UI reads the catalog, not the cap module. A declared cap has no
  bespoke card or builder.
- A pulse cannot declare a duration, and a span cannot declare a counter.
  `camera-sensors` is only a span whose event is `onMotionChanged`.
- The stored result is still a `Composition`, or the camera-sensor list motion
  already writes.

## Enforcement

`scripts/check-customize-declaration.ts` judges every declaration against the
cap's runtime schema and the vocabulary map. `scripts/generate-customize-catalog.ts`
refuses to emit when that judge is not empty. Both run from codegen and the
cap pre-commit hook; the guard is also on the Checks workflow.
`scripts/check-customize-bespoke-card.ts` refuses a component or builder named
after a declared cap outside the generic scalar, keyed-array and event folders.
A new override goes through that compile path.

## Completed

Completed 2026-10-25 — all five overrides generic; old cards deleted; no compatibility layer.
