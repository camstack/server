---
id: D944
title: Customize attaches a fixed set of extensions; everything else is a built device
status: accepted
date: 2026-10-26
supersedes: D941 (derived advanced parameters only; the one card editor stays)
applies-to:
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/capabilities/advanced-parameters.ts
  - packages/types/src/capabilities/*.cap.ts
  - packages/addon-admin-ui/src/components/device/customize/**
  - scripts/lib/customize-project.ts
---

## Context

D936 made a `customize` declaration on a capability the override contract, and
D941 added an Advanced section that derives an override for every field of an
opted-in capability (`advanced: 'derive'`). Three things went wrong.

- **The whitelist answered the wrong question.** An inventory of every device
  state schema (planning `plans/2026-10-25-editable-parameters-inventory.md`)
  found 199 user-facing top-level readings; the opt-in plus its filters kept 9.
  A Dreame robot showed no Advanced at all. Widening the filter was the first
  idea; it ran straight into fields that commands also write (vacuum `state`,
  lock `state`, climate `mode`), where an override fights the next hardware
  read and lies to every exporter.
- **The operator's real cases are not overrides.** A pet feeder imported without
  consumables, a sensor whose battery arrives as a separate device, a climate
  whose room temperature is the mean of three thermostats. The first two ADD a
  function the device lacks; the third COMBINES devices into a new value. None
  replaces a value the device already reports.
- **The unified editor lost behaviour parameters.** The catalog generator
  (`scripts/lib/customize-project.ts`, `projectDeclaredSource`) copies only
  `transformKinds`, so threshold, dwell, scale and clamp never reach the editor:
  running's defaults are hard-coded in the form, battery and consumable clamps
  are silently dropped on a new save, doorbell has no edge choice and one source
  only, and motion's mode appears only after a sensor is added. Runtime still
  applies every stored parameter; only the editor lost them.

Separately, numeric readings carry their unit and precision as root siblings
(`unit`, `precision`, `temperatureUnit`, `pressureUnit`, …) and arrive in
whatever unit the provider used. That is the main reason anyone wants to
"customize" a plain value.

## Decision

1. **Customize attaches extensions from a fixed set, never overrides a native
   value.** The set today: battery, consumables, motion, doorbell, running. A new
   extension is added only by declaring it explicitly on its capability. An
   extension is offered only when the device does not provide that capability
   natively (`apply: 'add'`); the `replace` and `add-or-replace` modes on native
   capabilities, and the Advanced section with `advanced: 'derive'`, are removed.
2. **An extension declares its BEHAVIOUR with typed parameters, and the editor
   renders exactly that declaration.** Motion: per-source mode (in-addition,
   confirm, replace), several sources, cooldown. Doorbell: edge(s), debounce,
   several sources. Running: threshold, comparison, start and stop dwell
   (hysteresis). Battery and consumables: scale, offset, clamp. The catalog
   carries every parameter with its default; no default is written in a form.
3. **A new value made from other devices is a built device.** Build-your-self
   gains HELPER templates. A helper is an ordinary device: exported, notified
   on, automated, with history. A device shows a helper next to it by an
   operator-picked link (D356), not by replacing its own reading. The templates:
   - **Group** — members of ONE base device type, and every base device type has
     a group. Readings (temperature, humidity, pressure, illuminance, power,
     energy, battery, numeric sensor) aggregate by mean, median, min, max or sum.
     Binary sensors (motion, contact, occupancy, leak, smoke, …) aggregate by
     **any** or **all**. Actuators (switch, light, fan, cover, valve, lock, media
     player, climate) fan a command out to every member, and their active state
     is evaluated by an operator-picked criterion: **at least one** or **all**.
     A light group exposes only the capabilities every member shares
     (brightness, colour temperature, colour), so a command never reaches a
     member that cannot honour it. Members that are offline or unknown are
     excluded from the aggregate and counted, never read as zero or off (D393).
   - **Math** — threshold (with hysteresis), sum, difference, ratio, a simple
     expression on the kept expression engine, derivative (rate of change over
     a window).
   - **Integral** — the accumulated quantity of an instantaneous reading over
     time (power W → energy kWh, flow → volume), trapezoidal over the reading's
     history, with an optional reset period (never, daily, weekly, monthly). It
     is a monotonic meter between resets, so it feeds energy dashboards and
     cost helpers directly.
   - **Statistics over a time range** — min, max, mean, sum, count, change, of a
     reading over a range the operator picks: a rolling window (last 1 h, 24 h,
     2 d, 7 d, 30 d, or a custom duration) or a calendar period (today,
     yesterday, this week, this month). Computed from the device history
     (`docs/architecture/device-history.md`) and its rollups, never from an
     in-memory buffer that a restart would empty; a range longer than the
     retained history is refused when it is configured, not answered short.
4. **A numeric reading is stored in the base unit of its quantity, and unit and
   precision belong to the value's declaration, not to root siblings.** The
   provider converts on ingest (°F → °C, inHg → hPa, …). Display unit and
   precision are chosen when the value is read (a user preference), never by
   customization.
5. **One source selector** — destination → device → value — serves extensions
   and helpers: the common device selector (scrolls inside its container, shows
   the parent, offers only devices with a usable value), values grouped by
   meaning with the current reading and their compatibility (direct, with a
   conversion, incompatible behind "all fields").

## Consequences

- An operator can no longer change a value a device reports from the device's
  page. They build a helper and link it. A climate that must USE an external
  temperature (export it as its current temperature) is a future, explicitly
  declared extension on climate only.
- Removing `replace` / `add-or-replace` on native capabilities needs a
  migration of stored compositions that use them: list them on the live hubs
  first (dry run, counts), then drop or convert each.
- Base units touch every provider that sends another unit (Home Assistant, MQTT,
  Tuya, Homematic, weather, …), every exporter that expects a specific one, and
  stored history: a migration or a cut-over date per quantity.
- Time-range statistics and integrals depend on device history: a reading with
  no history declaration cannot be a source for them, and the selector says so.
  Retention bounds the longest range a helper may ask for.
- The editable-parameters inventory stays useful as the source of the helper
  selector's "meaning" groups; it no longer drives an override list.

## Enforcement

- A guard: a capability's customize target with `apply` other than `add` fails,
  except a declared future extension that names this record.
- A guard: an extension target whose transform carries a parameter the catalog
  does not project fails codegen (`customize-project.ts`).
- A guard (with point 4): a device state schema with a root `unit` /
  `precision` / `*Unit` sibling next to a numeric reading fails; the unit lives
  in the reading's declaration.
- Review only until those land.
