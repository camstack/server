---
id: D1033
title: A type is a set of controls; same controls is a role
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/device/device-type.ts
  - packages/types/src/device/device-kind.ts
  - packages/types/src/device/device-control-resolution.ts
  - packages/types/src/device/base-device-provider.ts
  - packages/types/src/capabilities/timed-run.cap.ts
  - packages/ui-library/src/composites/device-controls/control-registry.tsx
  - packages/ui-library/src/composites/device-meta.ts
  - packages/addon-admin-ui/src/components/device/customize/identity-model.ts
  - packages/addon-export-alexa/src/endpoints/adapters/climate-model.ts
---

## Context

Two device types described the same set of controls. A `thermostat` and a
`climate` both carry `climate-control`; a composed `heater` was a smart plug
(`switch`) plus a temperature reading. The difference was what the thing IS,
not what it can do. Every consumer had to list both types, and the lists drifted:
the Alexa export called every `climate` an air conditioner, so a Home Assistant
thermostat imported as `climate` would have been published as one. The composed
heater needed its own creation path, editor branch, hero and HomeKit category
just to show a plug as a heater. The operator also asked whether an
integration can correct a device's type and role on its own, without a
migration.

## Decision

A device TYPE is the set of controls it offers; two kinds of thing with the
same controls are one type with different ROLES. So `thermostat` and `heater`
are retired. Every thermostat or air conditioner is a `climate` device with a
`climate-*` role: `climate-ac`, `climate-thermostat`, `climate-floor`,
`climate-radiator`, `climate-heater` or `climate-heat-pump-circuit`. A plug-in
heater is a `switch` with role `switch-heater`, and a plug powering a fan is a
`switch` with role `switch-fan`. A switch-fan renders as a fan with on/off only;
speed and oscillation appear only when a `fan-control` cap is present. Whatever
depended on the old type now reads the role:
- the card, row and hero resolve by `(type, role)`;
- `timed-run` is offered to a switch-heater with the heater limit (180 min,
  quick run 30);
- Alexa publishes `climate-ac` as AIR_CONDITIONER and every other climate
  device as a THERMOSTAT; a heat-pump circuit is exported like a thermostat.

A provider states the default role; the hub fills a missing role and never
replaces one already set.

## Consequences

- Stored rows are not migrated. A stored `thermostat` row decodes as `climate`
  (`canonicalStoredDeviceType`). The provider re-stamps the type on its next
  `registerDevice` or accessory spawn, and fills the role only where the row has
  none. A stored `heater` row stays unknown and renders as a generic device; the
  operator deletes the composed heaters.
- One type may now hold more than one device class (Bosch SHC: a radiator valve
  and a room climate). `BaseDeviceProvider.deviceClassForRow` picks the class
  from the stored row, not from the type alone.
- A climate device with no role yet is treated as a thermostat everywhere.
- Home Assistant reconcile re-derives the climate role through `setRole` when
  the entity's modes change, which overwrites an operator's choice. This was
  already true before this record.
- A new kind of thing with an existing control set is a new ROLE, never a new
  type.

## Enforcement

Specs:
- `device-kind.spec.ts` (the stored-type alias);
- the role-fill specs in system;
- the provider role specs (HA, Homematic, Bosch SHC and HomeCom, Gree);
- `climate-adapter.spec.ts` (Alexa category by role);
- the ui-library and admin-ui control-resolution specs.

There is no guard against a new duplicate type; that is review only.
