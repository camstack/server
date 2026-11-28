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
`@dominevo/types`, re-exported by `@dominevo/sdk`); a malformed or placeholder
value is refused and logged with the device tag, never stored.

There is one writer: the provider that owns the device, through
`deviceManager.setIdentifiers`, normally via `BaseDevice.declareIdentifiers`
or `declareDeviceIdentifiers`. The device-manager compares the transport's
caller stamp with the row's `addonId` and refuses anyone else, an operator
session included. The operator reads identifiers in Device Info → Hardware and
never edits them.

A declaration is merged into what is stored, kind by kind
(`mergeIdentifiers`): a kind it carries replaces the stored one, a kind it
lacks was read and found absent and is removed, and a kind the provider lists
in `unread` — it tried to read it and the read FAILED — keeps its stored
value, so a failed read never erases a fact (D49). A declaration that carries
no value is still sent when it read some kind — that kind was found absent and
is removed; only a declaration where every kind is `unread` is not sent. An entry whose value and origin are unchanged keeps its stored
`readAt`, which is therefore when that value was FIRST read; a provider
re-declaring the same values on every boot writes nothing and emits nothing.

## Consequences

- Providers DUPLICATE their identity into `identifiers`; nothing moved out of
  `metadata`, which keeps the keys providers already write (display), but it is
  no longer where identity is read from.
- A populator whose probe can fail partway (a camera's network read) must list
  the kinds that read would have produced in `unread`; otherwise its next boot
  erases them. When the probe cannot say WHICH sub-read failed (Reolink's
  `getNetworkInfo` swallows each one), every kind its answer lacks is `unread`:
  such a provider never removes that kind, it only replaces it.
- A hub or NVR child declares no MAC or IP: the channel's network read may
  answer with the hub's own address, and a child carrying it would match the
  hub.
- The row gains a nullable JSON column `identifiers` — an additive change;
  rows written before it read as "nothing declared".
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

## Amended 2026-11-18 — attached identifiers (D1063)

A device may also declare the identifiers of what is ATTACHED to it — a PoE
port the MAC and IP of the client wired to it — through
`setAttachedIdentifiers` (`BaseDevice.declareAttachedIdentifiers`). They are
stored in their own column (`attachedIdentifiers`), under the same rules as
`identifiers` (one writer, `unread` keeps the stored value), and never count
as the device's own identity: they only feed `poe-power` identity links. See
[D1063](adr-1063-two-devices-are-linked-only-on-identifiers-their-providers-declared.md).
