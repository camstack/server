---
id: D769
title: The Alexa export declares only interfaces Amazon documents, and every endpoint is validated against Amazon's discovery rules before it leaves the hub
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/validate-endpoint.ts
  - packages/addon-export-alexa/src/endpoints/builder.ts
  - packages/addon-export-alexa/src/sync-engine.ts
  - packages/addon-export-alexa/src/directive-router.ts
---

## Context

Alexa does not reject one bad capability. It rejects the endpoint, and
sometimes the whole report. This addon paid for that three times: a
ModeController with a single preset dropped the camera from Discover; two
presets with the same name ("Invalid capability received") took the camera and
every floodlight and siren with it; an early SmartVision declaration made a
camera and all its children "unavailable". Each time nothing on the hub said
why.

The battery interface was a fourth, quieter case: `Alexa.BatteryLevelSensor`
is not in Amazon's interface list (checked 2026-10-08), so every battery
ChangeReport was a 202 the cloud discarded. No documented interface carries a
battery level — `Alexa.InventoryLevelSensor` is for consumables and
`Alexa.EndpointHealth` documents only `connectivity` — so battery is not
exported at all.

## Decision

`endpoints/validate-endpoint.ts` encodes Amazon's discovery rules: the
interface allowlist with each documented version (no undocumented or
deprecated interface), the base `Alexa` interface, endpoint-id charset and
length, name/description/manufacturer lengths, cookie size, at most 100
capabilities, no capability declared twice, `instance` and friendly names on
instanced controllers, at least two unique ModeController modes,
`EndpointHealth` next to every sensor interface, CAMERA first on an
RTCSessionController endpoint, `isAvailable` on SnapshotProvider.

It runs twice:

- in `endpoint-shape-validation.spec.ts`, over every shape the real builders
  emit for a matrix of devices — together with the runtime rule that every
  `retrievable` property is answered by `Alexa/ReportState`;
- at runtime, on every AddOrUpdateReport and every Discover answer: an
  endpoint that breaks a rule is WITHHELD and logged with the rule, so its
  valid siblings still reach Alexa.

A new capability lands with its devices added to the spec matrix.

## Consequences

- An interface Amazon adds or a version it bumps needs one line in the
  allowlist; until then the validator withholds the endpoint and says so.
- Battery state is visible in CamStack only.

## Enforcement

`endpoint-shape-validation.spec.ts`, `battery-not-exported.spec.ts` and the
withholding case in `sync-engine.spec.ts`.
