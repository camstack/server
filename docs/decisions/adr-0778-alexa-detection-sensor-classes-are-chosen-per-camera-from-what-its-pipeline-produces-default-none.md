---
id: D778
title: Alexa detection-sensor classes are chosen per camera from what its pipeline produces, and none is the default
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/detection-sensors/**
  - packages/addon-export-alexa/src/export-alexa.addon.ts
---

## Context

D772 gave every exposed camera one `Alexa.MotionSensor` endpoint per detection
class its pipeline emits — Person, Vehicle, Animal, Package — behind one
integration switch that was on by default. On the operator's account that put
four sensors per camera into the Alexa app, most of them never used, and a
"Package" sensor appeared only where a package zone made it meaningful. The
operator wants to pick, per camera, which classes become sensors, and to start
from none.

A first draft defaulted to `package` only; the operator rejected that: no class
is sent unless chosen, and a class is offered only where the camera can
actually produce it.

## Decision

- What a camera MAY offer is its pipeline's answer, unchanged:
  `DetectionClassSource` over `pipelineAnalytics.listEventKinds` (the
  timeline's answer). `package` is in it only on a camera with an enabled
  package zone / package detection. No camera list is hard-coded.
- What it PUBLISHES is the operator's selection, a multiselect on the device's
  Export tab (device-settings aggregate, `applyDeviceSettingsPatch`), saved in
  this addon's per-device store under `alexaDetectionSensorClasses`.
- Published = offered ∩ saved. A key never written publishes nothing.
- Migration is the default itself: a D772 camera has no saved key, so its next
  reconcile builds no sensor and the sync engine deletes the four recorded
  `__det_` endpoints (the existing `mayRetire` path). A saved selection keeps
  exactly what it names.
- A selected class the camera stops producing (package zone removed) leaves the
  intersection after `DetectionClassSource`'s 15-minute confirmation and its
  sensor is deleted the same way. The selection itself is kept.
- The integration switch stays, as the master gate: off removes every sensor of
  every camera at once.

## Consequences

- After deploy, every existing detection sensor is deleted from Alexa, with the
  routines built on it, until the operator selects classes again. That is the
  requested behaviour, and it is said on the settings page.
- The selection survives unexposing and re-exposing a camera (it is not part of
  the `exposed` entry).
- The device settings page reads the camera's event kinds to render the
  choices.

## Enforcement

`detection-sensor-selection.spec.ts`: the intersection, the never-saved
default, the options offered, and a discriminating migration test — a D772
camera with no saved key loses all four sensors, one with a saved `person` keeps
only that one.
