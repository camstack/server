---
id: D1049
title: A device has one exposed name per export instance, and a rename never changes the exported id
status: accepted
date: 2026-11-12
supersedes:
applies-to:
  - packages/types/src/capabilities/device-export.cap.ts
  - packages/types/src/device/export-name.ts
  - packages/system/src/builtins/device-manager/export-name-fields.ts
  - packages/addon-export-alexa/src/endpoints/alexa-name.ts
  - packages/addon-export-alexa/src/migrations/alexa-name-to-exposed-name.ts
  - packages/addon-export-hap/src/exposed-name.ts
  - packages/addon-export-google/src/intents/sync.ts
  - packages/addon-provider-homeassistant/src/ha-export/exposed-name.ts
---

## Context

D875 gave Alexa its own device name: an `alexaName` key in the Alexa addon's per-device store,
a hand-written "Alexa name" field in its Export panel, used as the endpoint `friendlyName` and
never as the endpoint id. HomeKit, Google Home and Home Assistant had nothing: a device was called
on every platform what it was called in CamStack. Operators want "Porta" in HomeKit and
"Front door" in Alexa. Copying the Alexa field into three more addons would have meant three more
hand-written fields, three stores and three ways for a rename to re-pair or duplicate a device.
The Alexa name was also one per device, shared by every Alexa skill instance.

## Decision

The exported name is part of the `device-export` capability. `setExposedName({ instanceId,
deviceId, name | null })` saves it, `exposeDevice` may carry it (`exposedName`), and
`listExposedDevices` returns it. Blank or null means the device's own name. Each exporter stores
it in ITS per-device store (D865) under `exposedNames`, one entry per instance id
(`packages/types/src/device/export-name.ts`, which also holds the normalisation and the typed
refusal `export-name-refused: <reason>`). Each exporter validates with its platform's rule: Alexa
(letters, digits and spaces, up to 256, D875's rule), HomeKit (hap-nodejs' name rule, up to 64),
Google Home and Home Assistant (no control characters, up to 60 and 100). A name the platform
would refuse is never written, and a stored one it now refuses reads as no name. The name is a
label only: the Alexa endpoint id, the HomeKit accessory UUID, the Google SYNC id and the Home
Assistant device key are derived from the device id, so a rename updates the same device and
never re-pairs it. The UI field is derived: `device-manager` adds one "Name on <instance>" text
field per instance that exposes the device to the exporter's own Export panel and routes its key
(`export-name:<addonId>:<instanceId>`) to `setExposedName`. No exporter writes a name field by hand.
The Alexa-only name is retired by the phased migration
`export-alexa/2026-11-12-alexa-name-to-exposed-name`, which moves each stored `alexaName`,
unchanged, to the default Alexa instance and deletes the old key.

## Consequences

- `setExposedName` is a required method: every exporter, and the `exporter` scaffold, implements
  it. A cap change: `@camstack/server` must be published, and the four exporters redeployed.
- HomeKit renames by re-exposing the accessory in place (same UUID, pairing kept). Google learns
  a name on its next SYNC, which the hub cannot request (no HomeGraph key). Home Assistant gets
  it on the reconcile the save triggers; the name is part of the reconcile fingerprint.
- The old Alexa name was shared by every skill; the migration gives it to the default instance
  only. A second skill starts from the device name.
- Deleting the device clears the names with the rest of the per-device store (D865); no removal
  hook is needed.

## Enforcement

- `packages/types/src/__tests__/export-name.spec.ts`: save, clear, refusal before writing.
- `packages/system/src/builtins/device-manager/__tests__/device-aggregate.spec.ts`: the derived
  field and its routing to `setExposedName`, the refusal reported by name.
- Each exporter's spec pins its rule and that the exported id does not see the name;
  `alexa-name-to-exposed-name.sqlite.spec.ts` pins the migration with a marked value.
- `check-method-tiers` pins `setExposedName` to `admin`.
