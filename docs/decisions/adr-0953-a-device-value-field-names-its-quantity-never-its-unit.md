---
id: D953
title: A device value field names its quantity, never its unit
status: accepted
date: 2026-10-27
applies-to:
  - packages/types/src/capabilities/**
  - scripts/check-device-field-quantity-names.ts
  - scripts/lib/quantity-field-names.ts
---

## Context

D944 fixed one base unit per quantity and moved the unit off the slice onto the
declaration (`.meta(readingMeta(quantity))`). The field NAMES stayed behind:
`power-meter.watts`, `temperature-sensor.celsius`, `battery.percentage`,
`media-player.positionMs`, `color.mireds`. A name that spells a unit is a
second, silent declaration of it. It is wrong the moment a display preference
or a provider converts, it forks the same quantity across caps (`percent`,
`percentage`, `percentageStep`), and every consumer re-learns which spelling
belongs to which cap. A boot-time or read-time alias was rejected: it would keep
two names alive forever and hide a stale writer.

## Decision

A device-scoped capability names a value field after its QUANTITY (`power`,
`energy`, `voltage`, `current`, `temperature`, `humidity`, `illuminance`,
`level`, `speed`, `signal`, `position`, `colorTemperature`). The unit is the
D944 base of that quantity, converted and labelled at the display edge. A
rename is a hard cut: every writer and reader changes in the same piece of work,
there is no alias, and stored data is moved once by the offline script
`scripts/migrations/2026-10-27-quantity-field-names.ts`, run by hand with the hub
stopped (D679, D693).

Durations stay as they are (`...Ms`, `...Sec`): a duration is configuration, not
a device reading, and has no quantity name besides itself.

## Consequences

Cap methods that took a unit-named input changed their input name too
(`brightness.setBrightness { level }`, `fan-control.setPercentage { speed }`,
`media-player.seek { position }`, the mired branch of `color.setColor`
`{ colorTemperature }`). Stored state the offline map cannot reach must be
re-saved by hand: persisted automation and action args, composition
`fieldPath` values written as free text, notification-rule triggers keyed by
field, customize `targetId` values, and provider configs keyed by the old meter
names (Home Assistant `meterEntities`, mqtt-ha `meter`, ESPHome `slots`).

## Enforcement

`scripts/check-device-field-quantity-names.ts` walks every device-scoped cap's
status and history fields and fails on a unit name or a unit suffix. An
exception lives in `scripts/lib/quantity-field-name-allowances.txt` with a
reason; an entry without a reason, or one that no longer matches a field, fails.
Wired into `.github/workflows/checks.yml`.
