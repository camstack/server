---
id: D1066
title: The hub registry row is the only stored switch of an instance, and a registry read never calls an addon
status: accepted
date: 2026-11-19
supersedes: D1015
applies-to:
  - server/backend/src/api/core/cap-providers.ts
  - server/backend/src/core/addon/instance-lifecycle.ts
  - packages/types/src/addon/record-integration-instances.ts
  - packages/types/src/addon/instance-switches.ts
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/migrations/body-switch-to-registry.ts
  - scripts/check-one-row-switch.ts
  - scripts/check-no-provider-call-in-registry-read.ts
---

## Context

D1015 moved the switch into the instance record body and made `integrations.list / get /
getByAddonId` project it from the addon (`projectSwitches`). Every integration read therefore
called every addon, and an addon whose own method called the hub closed a hub-to-addon call
cycle: the hub stalled 23-32 s in `hub-main` while a reolink runner was driven out of memory. A
read of the integration list depended on the slowest addon, and a switch could not be read while
its addon was down. The `info.fixed` exception (a hub-owned flag for rows with no instance)
was a second path to the same fact.

Tried first, in D1015: keep the body as the store and make the projection tolerant (`switchUnknown`).
Rejected after the fact: tolerance does not remove the dependency, it only hides the stall.

## Decision

The hub registry row, keyed by (addon id, integration id) like a device, is the ONLY stored on/off
of an integration instance, for every role. Every instance of every addon, services included, has a
row, created eagerly by `withInstanceLifecycle` on `createInstance` and removed on delete (a
services instance keeps the id the addon minted, marked `info.serviceInstance`). `integrations.get /
list / getByAddonId / listByAddon` are pure registry reads that never call an addon.
`integration-instances.setInstanceEnabled` stays the one door: the hub writes the row, then tells
the owner addon so `RecordIntegrationInstances.onSwitched` fires; a down addon does not fail the
write. The addon keeps no switch in a record body: it learns its rows from `integrations.listByAddon`
once on its own boot path (and again after a migration run), then from the hub's notification,
never inside a method the hub calls into. `hidesFromIntegrations` is a display filter on
`integrations.list` only and `getAvailableTypes` serves from the description cached at registration.
The `info.fixed` exception is gone: one path, one door.

`bodySwitchToRegistryMigration` (D987, ordered after `registrySwitchToBodyMigration`) backfills a row
for every existing record of every kind a `RecordIntegrationInstances` helper wraps, with the body's
current `enabled` (false and true), then removes the field from the body. A stated body wins over a
disagreeing row; an absent field never overwrites one; a rerun changes nothing.

## Consequences

- The hub no longer depends on an addon to answer an integration read, and a switch can be read and
  written while its addon is down.
- A hub that cannot answer at addon boot leaves that addon's instances reading as on until the hub's
  notification states them (no retry loop, D3). A migration that did not apply blocks the owner
  (`block-owner`, fail closed).
- A record created outside the hub door (for example a seeded example profile) has no registry row
  and reads as on.
- `integrations.listByAddon` is new; it is the addon's own read of its rows and does not hide any.
- A helper built after the addon's migrations ran gets its move on construction (the engine replaces
  an owner's catalogue on every declare, so the late run carries the whole declared set phased to
  the late ids), and `reapplyOff` tells the addon about every instance that is off.

## Enforcement

`scripts/check-no-provider-call-in-registry-read.ts` (wired into `.github/workflows/checks.yml`)
refuses a provider call in a registry read; `scripts/check-one-row-switch.ts` keeps a second way to
switch out; the projection-free spec in `server/backend` and the migration spec on real SQLite.
