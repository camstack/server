---
id: D1004
title: "One creation entry point: a composed device is created naked, facets attach through Customize"
status: accepted
date: 2026-11-03
supersedes: D944 (the appliance template part only; the fixed extension set, the helper templates and the one source selector stay)
applies-to:
  - packages/addon-admin-ui/src/components/device/customize/**
  - packages/addon-admin-ui/src/components/composition-editor/**
  - packages/addon-admin-ui/src/components/device/hero/**
  - packages/types/src/composition/customize/**
  - packages/types/src/capabilities/*.cap.ts
---

## Context

Creating a device by hand had two doors. The build-yourself dialog offered
templates, among them appliance and heater templates that pre-attached power
metrics, a power source, consumables and a running state. The Customize tab
attached the same things to an existing device (D944, D915, D951). The two
paths drifted: the template carried its own copy of the running threshold and
dwell, and a device built from a template could not be edited the way a native
device of its type is. A composed device's Customize tab also hid the lists a
native device gets (the helper branch returned early, the free branch skipped
scalar caps), so the facets a template attached could not be changed later.

## Decision

1. **A built (composed) device is created naked.** Creation picks a type and,
   where the type needs it, the one thing without which the device is
   meaningless. It attaches no facet.
2. **Facets attach through Customize, for every composed device.** Power
   metrics, power source, consumables and running are Customize extensions,
   offered by the capabilities' own customize declarations and
   `assignmentAvailability`, exactly as motion sensors and doorbell are on a
   camera. A composed device shows the same lists a native device of its type
   gets, and an assignment is stored in the composed device's own block.
3. **Aggregators stay as helpers.** Group, statistic and math remain their own
   creation templates (D944 point 3): they make a new value from other devices,
   not a facet of one device.
4. **Media player:** created with media-player commands only when the source
   has them, otherwise naked; an infrared remote is attached through Customize
   (D964).
5. **Heater:** created naked, with the control source picked at creation.
6. **Running** is migrated into the Customize catalog format with the same
   threshold and the same start and stop dwell as the template carried; no
   default is written in a form (D944 point 2).
7. **Hero:** the generic `DeviceHeroRunningLine` wins over any per-type running
   line. Power-meter becomes a generic hero widget, one section like
   consumables (D915), drawn for any device that has the capability.

## Consequences

- The appliance and heater template code is deleted (phase 5): the helper kinds
  are the aggregators only, and the creation form builds a naked device. The
  migration keeps a private read-only schema of the old `helper` specs, the only
  place that still names them.
- A remote attached through Customize to a naked media player adds the
  `media-player` feature with every command served by the remote, so the device
  gains its media-player commands (D964).
- Stored compositions made from the appliance and heater helper blocks are
  rewritten by the `core-blocks` migration `2026-11-03-helper-to-customize`
  (D987 procedure body): running, power meter and power source recompiled in the
  Customize catalog format with the same threshold, dwells and plugs, a heater's
  `switch` forward kept, the `helper` spec dropped, the block id unchanged. It
  ran on every node before the templates were deleted.
- A facet an operator wants on a built device costs one Customize step instead
  of a template choice.

## Enforcement

A catalog-wide admin-ui spec: for every Customize target in the catalog, a
composed device of a compatible type exposes it (a helper device included).
Reintroducing an early return in `ComposedCustomizeBody` fails it. Three
guards, wired into `checks.yml`: `check-helper-kinds-are-aggregators` (the
helper spec declares exactly the aggregator kinds), `check-single-composition-creator`
(one non-test caller of `createComposition`, `lib/create-composition.ts`) and
`check-no-hero-self-drawn-power` (no hero card, in ui-library or admin-ui, draws
watts). A remote attached to a naked media player is covered by a
`RemoteConfigDialog` spec. The migration has a real-SQLite
spec (`helper-to-customize.spec.ts`) that marks threshold, dwells and plugs.
