---
id: D1042
title: Switch is the one on/off control, built from the cap's power hint
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/device/power-switch.ts
  - packages/types/src/capabilities/capability-definition.ts
  - scripts/power-hint-guard.ts
---

## Context

"Power on / off" was spread over several caps: `switch.setState` for a plug, `media-player.turnOn` / `turnOff`, `climate-control.setMode('off')`, `humidifier.setOn`, `water-heater.setOperationMode`, `pet-fountain.setPump`. Every consumer (the hero, the exporters, automations) had to know which cap a device used and how to read "on" out of it; the hero kept its own order of sources (`resolveOwnPower`). A first idea was a kernel scan that grafts a `switch` onto every device with one of those caps: that is a shadow registry (D3) and a second copy of the power fact (D224). The plug that FEEDS a device (`power-source`) is a different thing and must never be read as the device's own power (#462, operator amendment).

## Decision

A cap that powers a device declares how, once, in its `*.cap.ts` (D4), as `power: CapabilityPowerHint`:
`{kind:'field', field, set}` (humidifier `on`/`setOn`, pet fountain `pumpRunning`/`setPump`),
`{kind:'methods', field, offValues, on, off}` (media player `state` / `turnOn` / `turnOff`),
`{kind:'mode', field, offValue, set, lastField}` (climate-control `mode`, water-heater `operationMode`, restoring `lastActiveMode`).
The OWNER addon registers the device's `switch` through the one helper `registerPowerSwitch(this, cap, provider)` right after registering `cap`. The helper computes `switch.on` from the owner slice at read time; a value the owner has not reported is `null` (D393). Turning a mode device on restores the last non-off mode the hub mirror keeps; with none it refuses with the typed reason `no-last-mode` and never guesses. An owner that does not serve the hinted methods gets no switch. The `switch` runtime slice is a projection the helper writes only when the derived value changes, so mirror, hero and exporters read one shape. The dishwasher has no hint (its PowerState is an appliance action, not the device's power). Old methods stay until P2.

## Consequences

- `switch.deviceTypes` is not widened: a native registration is not gated by it.
- The `switch` slice of a hinted device is derived, never written by anyone else; a provider must not also register its own `switch` on that device.
- A provider not yet moved is listed by path, with the reason, in `PENDING_POWER_SWITCH` (composer; the Echo permanently, it has no power control). Matter and Homematic thermostats register their switch. The list can only shrink.
- `fan-control` has no on/off member, so it has no hint; fans keep their native `switch`.
- The timed run moving into `switch` (P1b) builds on the type + role limits of D1033 and is not part of this record.

## Enforcement

`scripts/check-power-hint.ts` (rules in `scripts/power-hint-guard.ts`, spec `scripts/__tests__/check-power-hint.spec.ts`): a hint names members the cap has, a hinted cap carries no second on/off field or setter, and every file registering a hinted cap calls `registerPowerSwitch` for it unless listed. Behaviour: `packages/types/src/device/__tests__/power-switch.spec.ts`.
