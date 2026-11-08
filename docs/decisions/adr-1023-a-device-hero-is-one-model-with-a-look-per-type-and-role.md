---
id: D1023
title: A device hero is one pure model with a look per type and role, filled by capabilities and served read-only
status: proposed
date: 2026-11-08
supersedes:
applies-to:
  - packages/types/src/device/hero/**
  - packages/types/src/capabilities/hero-layout.cap.ts
  - packages/system/src/builtins/core-blocks/hero-layout-service.ts
  - scripts/check-hero-look-exhaustive.ts
  - scripts/check-cap-hero-contributions.ts
---

## Context

A device's hero was decided in three places (device type, control kind, web card)
and drawn by about twenty-eight hand-written cards, each reading its own caps with
its own look; the viewer then built a fourth decision. The failure was silent twice:
a type whose card existed but was routed to "Controls coming soon", and a Remote
button only a media player could have, so an infrared device of another type had no
remote on its page. Watts were drawn by three cards in three looks.

The first design also carried operator overrides (hide, order, pin) and a layout
editor. The operator dropped them: layouts are fixed, so there is nothing to store,
edit or reconcile.

## Decision

One pure model in `@camstack/types` (`buildHeroModel`) is the hero of every device;
both clients draw only what it returns. It is extended per `DeviceType`, with a
`DeviceRole` only refining a type.

- **Look.** Each type (and role, or `inherit`) declares an icon and, for every
  hero state, a tone, a background and ONE animation, as exhaustive records
  resolved role, then type, then default. A member without a look does not compile.
- **Rows.** A fixed layout per type lists only ROW ids (a status plus the actions
  the device supports). A row whose caps are not bound is absent.
- **Reserved slots**, outside every layout so none can hide them: the remote button
  (cap `remote`; the remote is a separate sheet), a consumables icon, ONE consumption
  value (power in W if a power meter exists, else the running state), the device's
  own power with a timed run beside it, and the power supply.
- **Own power and power supply are never merged.** Own power is fed by one resolver
  (`switch.setState`, or the media player's `turnOn` / `turnOff` when it declares the
  power feature). The power supply is fed only by `power-source`, confirms Off while
  running, offers restart and never carries a timer.
- **Capabilities contribute**, typed against each cap's own status schema (D14). A
  slice that is absent or does not parse is "not answered": unknown is never off
  (D315, D393), and the model says so.
- **Served read-only** by the `hero-layout` cap, provided by core-blocks:
  `getHeroModel` builds from `getBindings` and the cap slices, `getLayout` names a
  type's rows. It stores nothing.

## Consequences

A new device cap needs a hero decision (a contribution or a stated reason) and a new
type or role needs a look, or a guard fails. Looks are opinionated, so a provider
cannot restyle its devices, only contribute facts. The renderers, the migration of the
per-type cards and the viewer are later phases; this record covers the model and the
cap. A caller states whether it may act (`canActuate`) and receives what to hide in
`gated`; the actuating methods stay guarded on their own.

## Enforcement

`satisfies Record<DeviceType, ...>`, `satisfies Record<DeviceRole, ...>` and
`Record<HeroState, StateLook>`; `scripts/check-hero-look-exhaustive.ts` and
`scripts/check-cap-hero-contributions.ts` (Checks workflow); specs under
`packages/types/src/device/hero/__tests__` and
`packages/system/src/builtins/core-blocks/__tests__/hero-layout-service.spec.ts`.

## P2 — the scene and the list row come from the same declaration

The hero and the device ROW in a list are one declaration per type, served by the
same cap. `hero-scene.ts` names a **scene** per `DeviceType` (refined by role,
exhaustive like the looks): the closed id says WHICH picture is drawn (air flow,
rising heat, drum, spray arm, …), a closed `mode` and a `level` in 0..1 say what it
is doing when the device told us (`null` otherwise, never a guess). Motion and
backdrop stay the state look's `animation` / `background` tokens: the scene adds no
second vocabulary for them. `HeroModel` gains `scene`, `facts` (the top line),
`sideTiles` (at most two per side); `consumables` already existed.

`projectDeviceRow(model)` is a pure selection from the model: mini-scene, name plus
one status line (joined by " · " by the client), the type's primary inline control
(the device's own power, else the first control of the first row; none when the
caller may not act), and one trailing fact (power, else battery, else consumables).
It computes nothing the hero does not hold. `getRowModels({ deviceIds ≤ 500,
canActuate? })` returns one row per id, in order, `null` for an unknown device, so a
list of hundreds is ONE call. Same auth and role as `getHeroModel`.
