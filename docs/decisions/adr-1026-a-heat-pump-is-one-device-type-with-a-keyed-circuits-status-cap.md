---
id: D1026
title: A heat pump is one device type with one status cap that carries its circuits as a keyed array
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/types/src/capabilities/heat-pump-status.cap.ts
  - packages/types/src/capabilities/heat-pump-control.cap.ts
  - packages/types/src/device/hero/hero-contributions-heat-pump.ts
  - packages/addon-provider-bosch/src/homecom/**
---

## Context

planning#476. A Bosch HomeCom gateway already published a heating circuit as a
`climate-control` device and the hot-water circuit as a `water-heater` device.
Nothing carried the heat pump itself: the system modes (silent, away, additional
heater, holiday), the compressor and its power, and every circuit at a glance.
The operator wants one device that shows all of it, whatever the vendor, and the
design (mockups, 2026-11-09) fixes four things: the number of circuits is whatever
the gateway reports; every circuit is visible with its own label and icon; the
COP is instantaneous and empty when it cannot be known; and no value is recorded
twice.

## Decision

1. **`DeviceType.HeatPump`** (`heat-pump`) is generic: nothing in it names a vendor.
2. **One main, read-only cap `heat-pump-status`** carries the whole picture. Its
   `circuits[]` is a keyed array (`id`), N entries, each with `kind`
   (`heating | dhw | cooling | solar`), `label`, `icon`, the current and target
   temperature and the mode. A circuit is never a separate device that must exist
   to be seen. A value the gateway did not report is `null`, never `0` (D393).
3. **The settable parameters are typed methods on `heat-pump-control`**, one per
   parameter, never a generic `set(key, value)`: the system modes (silent
   off/auto/on, away off/on, additional heater off/manual/auto, holiday
   off/hm1..hm8, each independent and with its real values) and, per circuit,
   the operation mode, heat/cool mode, summer/winter, comfort and eco setpoints and
   the maximum flow temperature; for hot water the operation mode, the temperature
   level, the charge duration and extra hot water as an action. The allowed values and
   the min/max/step are read from the gateway into the status (`allowed`, `min`,
   `max`, `step`); no limit is written in code.
4. **The COP is computed at read time and never stored**: thermal over electrical
   power, only when both are known and the unit draws power. It is a pure function
   of the slice (`heatPumpInstantCop`); no field of the cap holds it.
5. **History goes through the cap's `history` block** (D850, D917). `circuits[]` is
   declared with `items` (key `id`, label `label`), which gives one series per
   circuit; the power and temperatures are gauges, the circuit mode an enum
   (D896), the energy totals lifetime counters whose kWh per period is computed at
   read time (D944). A value another device already records is not given a second
   series.
6. **The hero** (D1023) shows the compressor scene, every circuit as a row with its
   label and icon, the power as pills (the COP pill only when it is known), and a
   "System" group with one segmented control per mode. Rows gain an optional
   `label`, `group` and `pills`; nothing else of the hero model changes.

## Consequences

- A vendor providing a heat pump implements two caps; a second vendor needs no UI
  work. A vendor with no gateway limits publishes `allowed: []` and the control is
  not drawn.
- The summary devices of planning#476 (energy system, composition from children)
  are not decided here: composition targets of this cap are an open question,
  answered in the issue.
- A resource path the HomeCom addon reads for the system modes and the power is
  recorded in one table and was written from the public resource tree, not a live
  census; the first live read corrects the table, not the cap.

## Enforcement

`check-cap-history-declared` (the `history` block), `check-method-tiers`,
`check-export-coverage`, `check-capability-union-complete` (codegen), the specs of
the cap's schema, of the hero contribution and of the HomeCom mapping.
