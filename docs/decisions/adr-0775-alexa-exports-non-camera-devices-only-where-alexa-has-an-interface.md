---
id: D775
title: The Alexa export publishes non-camera devices as one endpoint each, only for caps Alexa has an interface for
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/generic-device.ts
  - packages/addon-export-alexa/src/handlers/generic-state.ts
  - packages/addon-export-alexa/src/handlers/lock-controller.ts
  - packages/addon-export-alexa/src/handlers/discovery.ts
---

## Context

HomeKit exports locks, contact / motion / occupancy / smoke / CO / leak /
temperature / humidity / light-level sensors, switches and lights through one
cap → service table (`addon-export-hap` `cap-service-table.ts`). The Alexa
export published cameras, doorbells and alarm panels only, so none of the
house's sensors could trigger an Alexa routine.

Amazon has no third-party interface for smoke, carbon monoxide, leak or light
level (device-apis/list-of-interfaces, 2026-10-08). Publishing a leak sensor as
a "motion sensor" would make routines possible and every other surface wrong:
the Alexa app would say "motion" for a flooded floor.

## Decision

- A device of a non-camera type (light, switch, siren, sensor, lock, presence,
  thermostat, generic) exposed through the existing exposure model (the export
  picker or the device's Export tab) becomes ONE endpoint, `<id>__dev`, with an
  interface per cap Alexa has one for: `lock-control` → LockController
  (SMARTLOCK), `contact` → ContactSensor, `motion` / `presence` (occupancy) →
  MotionSensor, `temperature-sensor` → TemperatureSensor, `humidity-sensor` →
  HumiditySensor, `switch` (+ `brightness`) → PowerController
  (+ BrightnessController; LIGHT or SWITCH). Every one carries EndpointHealth
  (D770).
- Smoke, CO, leak, light level and battery are NOT exported; a device with
  only those publishes nothing, and the log says why.
- One slice → property mapping (`genericPropertyFor`) serves both ReportState
  (reading `deviceState.getCapSlice`) and the proactive reports (D776); a
  generic motion sensor goes through the held-motion path (30 s rule).
- Lock / Unlock need `create` on the device (D767) and answer `lockState` read
  back from the cap; `JAMMED` is a state, not an error (Amazon).

## Consequences

- Voice unlock is governed by the Alexa app's own opt-in; this skill neither
  adds nor removes it.
- A future Amazon interface for smoke or leak is one row in
  `generic-device.ts` plus one case in `generic-state.ts`.

## Enforcement

`generic-devices.spec.ts` and the R5 scenarios in
`endpoint-shape-validation.spec.ts` (Amazon's discovery rules, and every
retrievable property answered by ReportState).
