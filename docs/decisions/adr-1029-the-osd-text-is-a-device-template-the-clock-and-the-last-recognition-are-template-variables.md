---
id: D1029
title: The OSD text is a device template; the clock and the last recognition are template variables
status: accepted
date: 2026-11-10
supersedes:
applies-to:
  - packages/addon-osd-manager/src/**
  - packages/types/src/capabilities/osd-manager.cap.ts
  - packages/system/src/builtins/device-manager/device-template/**
---

## Context

The OSD manager had its own little language next to the device-template engine
(D1021/D1025): parser tokens (`{t.value} {h.full}`), a per-binding display unit,
decimals and value map, a slot template (`${value} ${unit}`), and three extra
source kinds (`clock`, `device-state`, `latest-recognition`). Every one of them
re-implemented formatting the engine already does, with a second binding shape
(`pick`, container, `capName`, `valuePath`) in place of the device aliases the
other editors use, and a second set of units. A text could not say "damp when the
humidity is high" because the old language had no condition.

## Decision

A slot's text is a device template. `OsdSourceSchema` is `none | static | template`;
a named template is `{ id, name, text }` and is the unit of reuse across cameras.
Rendering goes only through `deviceManager.renderDeviceTemplates`.

Three names are template variables, not sources: `now` (server time, `time` filter),
`camera` (reserved alias for the device the caller renders for, so a text copies
between cameras; `thisDevice` on render/check) with `camera.lastPerson` and
`camera.lastPlate` supplied by the caller.

The manager re-renders on events: `checkDeviceTemplates` reports the devices a text
reads (`reads`) and whether it reads the clock (`readsClock`); the manager subscribes
to their state changes and re-renders a slot at most once per
`SLOT_RERENDER_THROTTLE_MS`, and on the minute for a clock text. A refused render
keeps the last good text and logs once with `tags: { deviceId }`.

An owned D987 migration rewrites every stored binding and named template.

## Consequences

- Behaviour differences the operator may see after the migration: `round` rounds
  where the old code truncated; a clock in a custom timezone follows the server zone
  (the migration notes it); a template that prints `—` no longer blanks the overlay,
  it keeps the last text; the safety-net tick is 60 s (was 10 s) because events and
  the minute timer drive freshness; a device whose own alias is `camera` is shadowed
  inside an OSD text.
- A migrated text that kept the old tight `20°C` form uses a
  `format('%s') | replace(...)` chain, longer than a hand-written one; the operator can
  simplify it.
- A converted text over 1024 characters makes the migration fail rather than truncate.
- The migration reads per-device settings, device state and aliases, which
  `MigrationApiV1` cannot reach, so the addon stays on the old
  `defineAddonMigrations` seam, listed in `scripts/migration-ports-surface-pending.json`
  (shrink-only).
- The viewer does not read OSD schemas (its own `osd-source-fields` mirror covers
  live fields only) and is unchanged.

## Enforcement

`bindings-to-templates.sqlite.spec.ts` (a marked slot and a marked named template
render the same text after the migration, on real SQLite),
`template-slots.spec.ts` (hub render, refusal policy, dependency subscription, throttle,
minute timer), `device-template-actions.spec.ts` (`thisDevice`, `now`),
`check-device-template-grammar` and `check-migrations-well-formed`.
