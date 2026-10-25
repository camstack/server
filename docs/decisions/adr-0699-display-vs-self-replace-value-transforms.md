---
id: D699
title: Display overrides stay on setDisplay; value transforms are self-replace on the customization composition
status: accepted
date: 2026-10-02
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/device/customize/override-row/OverrideFieldRow.tsx
  - packages/addon-admin-ui/src/components/device/customize/override-row/merge-override.ts
  - packages/addon-admin-ui/src/components/device/tabs/DisplaySection.tsx
  - packages/types/src/composition/presets/numeric-transforms.ts
  - packages/types/src/composition/cards/classify-field.ts
---

## Context

Operators need two different things for a numeric sensor: show °F / one decimal
in the UI without lying to exporters, and publish a converted or scripted value
that HA-MQTT, rules and history all see. An earlier instinct was a second meta
field (`valueTransform`) beside `DeviceMeta.display`. That would have been a
second authority over the claimed slice — the same class of failure D62 forbids
("a store nobody reads", or worse, two stores that disagree).

Operator 2026-09-30 also ruled that transforms of a device are NOT assignment
cards: they must not pick other devices' fields, and "Convert unit" must not
appear on cameras just because a camera has a numeric field somewhere.

## Decision

Keep the display / value split:

- **Display** (unit, precision, icon, label, hidden) writes only through
  `deviceManager.setDisplay` / Overview `DisplaySection`. The stored slice is
  unchanged; `resolveSensorDisplay` converts for render.
- **Value** (unit convert, expression script, invert) writes a self-`replace`
  feature on the device's ONE customization composition (D663), reading the
  native shadow. Removing the customization restores the native slice exactly.
- Never introduce a parallel `meta.valueTransform` (or similar) field.

Amended by D941 (2026-10-25): the Customize "Numeric transforms" card is gone.
Convert unit and a formula over this device's own field are entry kinds on the
shared override row. Invert is that formula (`!v` bound to the native field),
not a separate control.

Convert unit is offered on a numeric row only when that field's unit meta has
another unit in the same dimension.

## Consequences

- Export and rules see display overrides as unchanged; they see value transforms
  as the claimed number + unit field.
- Script and plain unit convert are mutually exclusive in v1 on the same field.
- Invert is the boolean twin (`!v`) on invertible source caps only.
- Composed-device creation reuses the same primitives via templates; it is not
  a second transform authority.

## Enforcement

- Spec + plan under (planning repo: superpowers) (2026-10-02 numeric device transforms).
- Tests: `cards.spec.ts` (convert-unit round-trip), `OverrideFieldRow.spec.tsx`,
  `DisplaySection.spec.tsx` (dimension-filtered units).
- Review only for "no meta.valueTransform" until a guard is worth the cost.
