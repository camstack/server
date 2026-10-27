---
id: D951
title: Power and energy are a feature of the electrical device, not a sensor beside it
status: accepted
date: 2026-10-27
applies-to:
  - packages/types/src/capabilities/power-meter.cap.ts
  - packages/types/src/composition/customize/scalar-merge.ts
  - packages/types/src/composition/customize/scalar-decode.ts
  - packages/addon-provider-homeassistant/src/ha-meter-fold.ts
  - packages/addon-provider-homeassistant/src/ha-meter-carrier.ts
  - packages/addon-provider-homeassistant/src/ha-container-reconcile.ts
  - packages/addon-admin-ui/src/components/device/customize/source-selector/source-selector-siblings.ts
  - packages/addon-admin-ui/src/components/device/customize/scalar/**
---

## Context

A metered plug reached CamStack as a switch and, next to it, a power sensor, an
energy sensor, a voltage sensor and a current sensor, each its own device with
its own `power-meter` cap holding one field. The operator saw six rows for one
object, could not tell which sensor belonged to which load, and the cap's
`deviceTypes` (sensor and a few appliances) said the reading belonged to a
sensor. The same split existed in every provider that reads electrical data
from a device that also has a control.

Customize (D944) could not repair this by hand either: it assigns ONE source
per capability, and a cap with four readings stores them in one feature, so a
second assignment replaced the first. Its source picker listed the whole fleet,
with no hint that the right answer sat in the same container.

## Decision

1. **`power-meter` is a feature of any electrical device.** `deviceTypes` is
   sensor plus the loads that draw metered mains power: switch, light, fan,
   climate, thermostat, humidifier, water heater, media player, washer, dryer,
   dishwasher, vacuum, lawn mower, pet feeder. A cover, lock, valve or camera is
   left out; nobody meters their draw. The slice and its base units (W, kWh, V,
   A) are unchanged, so history and every reader keep working.
2. **A provider that knows the grouping folds the readings into the load.** The
   Home Assistant import gives the first normal control of a load type the
   `power-meter` cap and the entity ids it reads (`meterEntities`); that child
   subscribes to them and writes each push into its field. **The sensor
   children are kept**, flagged `foldedInto`, sectioned as Diagnostic: nothing
   is deleted (D865), device ids do not change, and an existing adoption folds
   on its next reconcile through the same derived-spec rebuild. A device with
   meters and no load is untouched.
3. **"Power and energy" is a Customize extension.** One scalar target per
   reading (`watts`, `kwhTotal`, `volts`, `amps`), each `apply: 'add'`, each
   sourced from another device, offered on every device type of (1) except a
   bare sensor. Targets of one cap share one stored feature: each owns its value
   path and its companions (`scalar-merge.ts`), a decode compares only the owned
   slice, and removing a target keeps the others. A field's unit is the slice's
   `unit` when it publishes one, else its quantity's base, so a meter slice
   (no single unit) fits the target of its own quantity and refuses the others
   by name.
4. **Every extension's source selector suggests the host's siblings.**
   `siblingSuggestions` takes the candidates the destination already accepts
   (type, cap, quantity: `partitionSourceDevices`) and returns those in the
   host's container, siblings before devices under the host, then by name. It
   knows no extension and no kind, so a new extension gets it with no UI
   change. A suggestion is a presentation, never a link (D356). The room
   suggestions of D749 stay on Linked devices alone.

## Consequences

- Other providers (Homematic, Matter, MQTT, Bosch, Shelly-like) keep publishing
  their sensors as before until each adopts `foldMeterEntities`' idea; the cap
  already accepts their load types, and Customize covers the manual case today.
- The folded sensor children still exist, so an automation or a viewer that
  reads them keeps working. Hiding them is a later, explicit step.
- A cap with several scalar targets pays one card per reading on Customize.
- Giving `volts` and `amps` a `label` puts them in `CAP_RUNTIME_FIELD_UNITS`
  (D944: unlabelled quantities are readings, not convert-unit sources).
- A live hub needs `@camstack/system` and `@camstack/server` published (cap
  change), then the Home Assistant addon and the admin UI deployed.

## Enforcement

`power-extension.spec.ts` (merge, owned slice, removal), `ha-meter-fold.spec.ts`
and `ha-meter-fold-child.spec.ts` (switch plus sensors give one device with a
power-meter), `source-selector-siblings.spec.ts` (ranking, fit, no kind literal
in the function), `scalar-target-save.spec.ts` and `power-extension-fit.spec.ts`
(admin-ui). Provider coverage beyond Home Assistant: review only.
