---
id: D875
title: An outlet is an Alexa smart plug, the export table selects in bulk, and the Alexa name never changes the endpoint id
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/adapters/switch.ts
  - packages/addon-export-alexa/src/endpoints/alexa-name.ts
  - packages/addon-export-alexa/src/endpoints/generic-device.ts
  - packages/ui-library/src/composites/export-bulk-selection.ts
  - packages/ui-library/src/composites/device-export-panel.tsx
---

## Context

P2 of the Alexa plan (D869). Three small gaps remained after covers and climate:

- Every `switch` was displayed as SWITCH, so a plug sat in the Alexa app next to
  lamps and could not be told apart in "all plugs" routines. The source already
  knows (Home Assistant `device_class: outlet`) but the mapping dropped it.
- The Export table selected row by row. Exposing "all Homematic blinds" or "all
  outlets" meant hundreds of clicks.
- A device could only be called what CamStack calls it. Renaming it in CamStack
  to suit Alexa renames it everywhere.

## Decision

**Plugs.** `DeviceRole.Outlet` (`outlet`) is a switch sub-role. The Home
Assistant mapping sets it for `switch.*` with `device_class: outlet`; the switch
adapter publishes SMARTPLUG for it, LIGHT still wins for a dimmable one. Other
providers set the same role when their source says outlet (Homematic's `switch`
kind does not distinguish plugs from relays, so it stays SWITCH).

**Bulk selection.** The shared export table (`DeviceExportPanel`, every exporter)
gets Role and Provider filters and "Select N shown" / "Deselect shown": it acts
on every row the search, type, role and provider filters leave, across pages, and
keeps selections outside the filter. Nothing is hidden by default (D869 operator
decision); an empty filter is no filter. The pure rules live in
`export-bulk-selection.ts`.

**Alexa name.** A per-device `alexaName` in the standard per-device store (D870),
edited in the device's Export tab, is the endpoint `friendlyName` (generic
devices, cameras and the camera's detection sensors' prefix). It defaults to the
device name, blank clears it, and it is validated per Amazon's friendlyName
rule ("Up to 256 alphanumeric characters and spaces. Don't include special
characters or punctuation", Alexa.Discovery objects): letters of any script,
digits and spaces, at most 256 characters. A
refused name throws before anything is written. The endpoint id stays
`<deviceId>__dev`, so a rename is an `AddOrUpdateReport` for the SAME endpoint
(`pushDevice` right after the save; the reconcile signature ignores names on
purpose) and Alexa shows no duplicate.

## Consequences

A stored name that no longer validates is ignored (the device name is used)
rather than pushed to be refused by Amazon. A name that cannot be read (store
down) also falls back to the device name until the next successful read: a
rename can briefly revert in Alexa rather than block discovery. Accessory
children keep deriving their names from the device name.

## Enforcement

`alexa-name-and-plug.spec.ts` (category, override, same endpoint id, discovery,
validation errors; disarmed by reverting each fix), `export-bulk-selection.test.ts`
and `device-export-panel-entry.test.tsx` (bulk), the Home Assistant mapping spec.
