---
id: D1097
title: A timed run is offered on every device that has a switch, through the one wrapper
status: accepted
date: 2026-11-24
supersedes:
applies-to:
  - packages/types/src/capabilities/timed-run.cap.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/device/device-kind.ts
  - packages/types/src/device/switch-run-limits.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/system/src/builtins/core-blocks/timed-run/**
  - packages/ui-library/src/composites/device-card/connected/use-switch-power.ts
---

## Context

D993 made a timed run a hub-owned wrapper cap, bound by device type, and D1033
narrowed that to pet fountains and heater-role switches. The result: a plain
relay, a plug, a fan or a siren had a `switch` and no "on for N" (an automation
could hold a switch on for a time, D1092, but the operator could not from the
card). Two limit tables (`TIMED_RUN_*`) also repeated `switchRunLimitOf`.

## Decision

`timed-run` binds to every device that has a `switch` binding, from any
provider (a native, a composer graft, `registerPowerSwitch`), and to pet
fountains by type. The cap declares it with `bindsWhenDeviceHas: ['switch']`
(`capability-definition.ts`); `getBindings` derives the binding on each call
(`capAdmitsDevice`), so a device that gains or loses its switch after boot
gains or loses it with no registry and no timer (D3). `switch.setState` is
untouched and nothing intercepts it. The limit is `switchRunLimitOf(type, role)`
only; `timedRunLimitOf` is total and the duplicate tables are gone. Over the
maximum is refused, never clamped (D993). The hero model offers the `timedRun`
slot and the `run-for` row wherever the cap is bound; the base cards that
already draw a switch timer (plug, fan, heater) draw it for any switch.

## Consequences

An unresolved device type never gains the binding by fail-open. The timed-run
service reads the device's bindings to know whether to serve it, and announces
its status once when a switch appears after boot. Amends D993 (binding rule)
and D1027 (a switch IS offered a timed run).

## Enforcement

`bindings-store.spec.ts` (switch after boot, camera graft, unregister),
`device-kind.spec.ts`, `build-hero-model.spec.ts`, `timed-run-service.spec.ts`,
and `default-active-device-types.spec.ts` (a default-active cap must declare a
type list or `bindsWhenDeviceHas`).
