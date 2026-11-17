---
id: D1059
title: A device's identity is declared by its provider as typed identifiers, not written into metadata
status: accepted
date: 2026-11-17
supersedes:
applies-to:
  - packages/types/src/device/device-identifiers.ts
  - packages/types/src/device/declare-identifiers.ts
  - packages/system/src/builtins/device-manager/device-identifiers-action.ts
  - packages/system/src/builtins/device-manager/device-row-store.ts
  - scripts/check-device-identifiers-declared.ts
---

## Context

A device's MAC, serial and vendor uid lived only in `metadata`, a free-form
`Record<string, unknown>` that any caller of `setMetadata` may overwrite —
the operator included. Each provider spelled the values its own way
(`AA-BB-…`, `aabb.ccdd…`, a bare serial with no manufacturer, `"unknown"`),
under its own key (`mac`, `serialNumber`, `uid`). Nothing could match two
devices by identity, because there was no identity to match: only display
text that looked like one.

## Decision

A device's identity is a typed, separate field, `identifiers`, on the
persisted device row. Its keys are closed: `mac` (several), `serial`
(`<manufacturer>:<serial>`), `machine-uuid`, `vendor-uid` (`<vendor>:<id>`),
`hostname` and `ip`. Each entry carries its `origin` (`read` from the device,
or `derived`) and `readAt`. How much a key proves is a function of the key
(`identifierStrength`: hardware keys strong, network names weak) and is never
stored. Values are normalised once, by `normaliseIdentifiers` (in
`@camstack/types`, re-exported by `@camstack/sdk`); a malformed or placeholder
value is refused and logged with the device tag, never stored.

There is one writer: the provider that owns the device, through
`deviceManager.setIdentifiers`, normally via `BaseDevice.declareIdentifiers`
or `declareDeviceIdentifiers`. The device-manager compares the transport's
caller stamp with the row's `addonId` and refuses anyone else, an operator
session included. The operator reads identifiers in Device Info → Hardware and
never edits them. A declaration replaces the previous one; an empty one is
not sent, so a probe that learned nothing never erases what an earlier probe
declared.

## Consequences

- `metadata` keeps the keys providers already write (display), but it is no
  longer where identity is read from.
- The row gains a nullable JSON column `identifiers` — an additive change;
  rows written before it read as "nothing declared".
- A declaration equal to the stored one emits nothing, so providers may
  declare on every connect.
- Providers still to migrate: unifi and unraid (being rewritten elsewhere),
  the providers that know an identity only on a discovery candidate
  (matter-broker, bosch shc/homecom, ecowitt, dreame, dreo, petkit, tuya), and
  those that hold it only in config (amcrest, gree, wyze, onvif).

## Enforcement

`scripts/check-device-identifiers-declared.ts` fails a package that writes a
MAC / serial / uid key into device metadata and never calls
`declareIdentifiers` / `declareDeviceIdentifiers`. `setIdentifiers` refuses a
non-normalised declaration (`invalid`) and a caller that does not own the
device (`not-owner`); both are covered by
`packages/system/src/builtins/device-manager/__tests__/device-identifiers.spec.ts`.
