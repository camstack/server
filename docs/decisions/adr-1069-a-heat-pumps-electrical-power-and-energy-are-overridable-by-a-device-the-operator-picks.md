---
id: D1069
title: A heat pump's electrical power and energy are overridable by a device the operator picks
status: accepted
date: 2026-11-20
supersedes:
applies-to:
  - packages/types/src/capabilities/heat-pump-status.cap.ts
  - packages/types/src/generated/customize-catalog.ts
  - packages/addon-provider-bosch/src/homecom/**
---

## Context

planning#476. A Bosch HomeCom heat pump reports `power.electricalW` as `null`: the
cloud has no instantaneous power. Its `energy.electricalKwh` is a native value
the operator would still rather take from a dedicated meter (the Enpal heat-pump
power-meter child). Without electrical power the instant COP, the hero pills and
the recorded series are empty. Adding `HeatPump` to the power-meter device types
was rejected: it would show a second card and record the same series twice
(D1026, "no value is recorded twice").

## Decision

Amends D1026. `heat-pump-status` lists `power.electricalW` and
`energy.electricalKwh` in `customize.overridable`, each with its own scalar
`replace` target (`electrical-power`, `electrical-energy`; D984, D1034). The
operator picks the source device by hand (D356); the unit is checked at the
link (`W` for power, `kWh` for energy). The replaced value IS the cap field, so
the COP, the pills and the history use it with no copy. The source is read live
and nothing is kept (D224). The fields stay read-only: no write is forwarded.

## Consequences

A source confirmed unreachable RELEASES the field back to the native reading
(D663 S1b): for Bosch power that is `null`, shown as "—", never 0 (D393); for
energy it is the native lifetime meter. A read that merely failed HOLDS the last
value (D49). The Customize table is derived from the catalog, so the only
admin-ui change is the row titles in the locale files. A different meter for
thermal power or energy is not offered: only these two leaves are overridable.

## Enforcement

`heat-pump-replace.spec.ts` (catalog, unit check, plan) and
`heat-pump-replace-runtime.spec.ts` (served slice, COP, release) in the types
and system packages; `check-customize-declaration` and `check-customize-coverage`.
