---
id: D920
title: A device's vocabulary is one cap-keyed map outside the caps
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/device/cap-vocabulary/**
  - packages/types/src/device/device-do-actions.ts
  - scripts/check-cap-vocabulary.ts
  - scripts/lib/cap-vocabulary-check.ts
---

## Context

Automations and scripts must offer, for any device, what it can be made to DO
("Turn on {device}", "Move {device} to {preset}") and what it can be WATCHED
for ("When {device} opens", "When the temperature of {device} rises above
25 °C"), expressively and in the operator's language. What existed was
`device-do-actions.ts`: a curated list of 71 actions, English-only, with no
triggers, no events, no way to say where a value comes from (a PTZ preset was
a free-text "Preset id"), and nothing that noticed when a cap grew a method —
`vacuum-control.locate`, `cover.setPosition`, `climate-control.setTarget` and
most of `dishwasher` were simply absent. The trigger editor offered every
`EventCategory` value, system ones included, for any device.

Two other places were considered and rejected. Putting the wording INSIDE each
`*.cap.ts` (a `phrase` on every method and status field) spreads translations
and device-type nuance over 179 files, makes a binary sensor's door-vs-motion
wording a property of a cap that does not know its device's role, and turns
every rewording into a framework change shipped in the closure. Deriving the
phrases from the Zod schemas alone gives "Set state on=true" — correct and
useless.

## Decision

Every capability has exactly one entry in one map,
`packages/types/src/device/cap-vocabulary/`, keyed by cap name and typed
against the cap definitions (a method, status field or event the cap does not
declare, or a missing cap, is a TypeScript error). A device cap's entry
names its operator-facing ACTIONS (id, en/it label and phrase with
placeholders, icon, fixed args, open args with how values are offered: an
enum, a number range with unit, or a dynamic read of the same cap), its STATE
triggers (boolean, numeric, enum, free value), its EVENT triggers
(`EventCategory` it emits), every declared cap event (phrased or excused), the
operate methods it deliberately does not offer (`notOperatorFacing` with a
reason), and wording overrides by `DeviceType` and `DeviceRole` (a role
wins). A system cap's entry says why it is not a device's vocabulary.
Translations live inline as `{ en, it }`. Consumers resolve a device's
vocabulary by walking its bindings by cap NAME (never binding kind, D13) —
`actionsForDevice` / `triggersForDevice` — and the Do catalogue
(`DEVICE_DO_ACTIONS`) is a projection of the map, keeping the wire shape
`{ cap, method, args }` and every pre-existing action id.

## Consequences

- A new cap, method or event is not done until its vocabulary is: the type
  refuses a missing cap, the guard refuses an unphrased operate method or
  event.
- Wording, translation and device-type nuance change without touching a cap,
  and ship with `@camstack/types` like any other framework data.
- A third language means a third key on `L10n`, and the guard then demands it
  everywhere.
- The recipe trigger schema (`device-state`) compares by equality only; the
  numeric "rises above / falls below / changes by" phrases describe triggers
  the automation runtime cannot yet express — the rework that consumes this
  map has to add the operator.

## Enforcement

`scripts/check-cap-vocabulary.ts` (judge: `scripts/lib/cap-vocabulary-check.ts`,
spec: `scripts/__tests__/check-cap-vocabulary.spec.ts`) fails on a cap with no
entry, an operate method (not a read, not an admin configuration method) with
no action and no reason, a declared event with no phrase and no reason, a
placeholder with no arg, a label lacking `en` or `it`, an offered value, fixed
arg, number bound or state-field kind that disagrees with the Zod schema, an
icon outside the catalog, and a duplicated action id. The map's own type
(`CapVocabularyMap`) refuses a missing cap or a misspelt method, field or
event at compile time. `device-do-actions.spec.ts` pins every pre-D920 action
id and the saved step it must still select.
