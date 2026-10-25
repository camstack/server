---
id: D864
title: Deleting a device cleans its data at delete time, store by store; the keychain is purged by device scope
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/removal-cleanup.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/keychain/keychain-service.ts
  - packages/types/src/capabilities/keychain.cap.ts
  - packages/types/src/keychain/secrets-access.ts
---

## Context

Deleting a device left data behind. The live case: the device-scoped secret
`secret://provider-dreame/device/4483/navigationAccessCode` stayed in the keychain
after device 4483 was deleted. Reading the removal path (`deviceManager.removeDevice`,
the only door every delete converges on — `remove`, the cascade, `removeByIntegration`
and the provider's `decommission` all end there) showed two defects:

- **The keychain was not in the path.** D787 stores a device secret under the
  DRIVER's name (`device/<id>` scope), so device-manager's own config clear never
  touched it, and device-manager cannot name the owner of a ref it never wrote.
- **The clean-up was one straight line.** The first step that threw skipped every
  later one, and because the device row was already deleted, the operator could not
  retry the removal (an unknown device is an idempotent no-op).

Tried and rejected: a boot-time sweep of orphans (forbidden — a boot purge destroys
data on a read that may be wrong), a `DeviceUnregistered` subscriber in the keychain
(events are telemetry and may be dropped, D8/D11 — loss would leave durable garbage),
and device-manager deleting the driver's refs one owner at a time (it cannot list
another owner's refs; `keychain.listMeta` is owner-checked).

## Decision

A device's data is cleaned AT DELETE TIME, on the RPC path that already deletes the
row, in independent steps; there is no boot sweep.

1. `removeDevice` runs one step per store it owns (`keychain-secrets`,
   `device-config`, `runtime-state`, `field-claims`, `bindings`). A step that throws
   neither skips the others nor fails the removal; it is logged and retried by a
   bounded in-memory reconcile (30 s, 2 min, 10 min, then it gives up with an error
   line). One info line per device, `tags: { deviceId }`, carries the counts per store.
2. Keychain values of a removed device go through `keychain.deleteDeviceScope`, the
   one owner-spanning delete: every value scoped `device/<id>`, whatever its owner,
   audited and announced as `delete` so every keeper drops its copy. Only the caller
   `device-manager` may use it. A device scope stops being anybody's when its device
   is gone; no other moment justifies crossing owners.
3. Any other addon's per-device data is cleaned by THAT addon, off
   `DeviceUnregistered` (existing subscribers listed below) — the kernel never
   deletes from another addon's tables.
4. Recordings, event media, analytics rows and history are NOT deleted by a device
   delete: they follow their retention.
5. What a lost retry leaves is visible and removable by hand: a device-scoped secret
   whose device row no longer carries its marker reads `orphan` on System ->
   Secrets, which already offers a confirmed "Delete N orphans".

## Audit — every store that keeps per-device data

Right action: **now** = deleted at delete time, **owner** = the owning addon's
`DeviceUnregistered` handler, **retention** = kept, follows its own pruning,
**tolerated** = a reference that reads as "missing" by design.

| Store | Owner | Keyed by | On delete today | Right action |
| --- | --- | --- | --- | --- |
| keychain `device/<id>` values | keychain (value owner = driver) | `secret://<owner>/device/<id>/…` | NOT cleaned (the bug) | **now** (this ADR) |
| `device-manager:devices` row (identity, name, location assignment, type, parent) | device-manager | id | deleted | now (existing) |
| device config (`addon-device-settings` `device-manager:<id>.`) incl. `_linkedDeviceIds` of the device | device-manager | id | cleared | now (existing, now isolated step) |
| `device-runtime-state` slice + state mirror | device-manager | id | cleared | now (existing, now isolated step) |
| field-claims index entry | device-manager | `(deviceId, cap)` | pruned | now (existing) |
| `deviceBindings` slice (wrapper activations) | device-manager | id | purged | now (existing) |
| native caps registry / `remoteNativeCaps` | capability registry | id | dropped | now (existing, in-memory) |
| other devices' `_linkedDeviceIds` / tracked opt-ins naming the deleted id | device-manager | camera id | stays; the linked-devices slot reads it as `health: missing` and the resolver drops it | tolerated (a fleet sweep per delete would cost more than the dead id) |
| stream-broker slot assignments, probe snapshots | stream-broker | `<deviceId>/<camStreamId>` | retract + purge on `DeviceUnregistered`; catalog poll sweep is the backstop | owner (existing) |
| orchestrator per-camera settings + per-device store, zones, rule state | pipeline-orchestrator | id | purged on `DeviceUnregistered` | owner (existing) |
| orchestrator `device-features` mirror | pipeline-orchestrator | id | not found in the handler | owner — open, see below |
| notification rules, timelapse/summary rules, mutes referencing the device | notification-center | rule id / device id | pruned by the `device-prunes` ledger (event + reload-tick reconcile) | owner (existing) |
| snapshot cache + variants | snapshot builtin | id | evicted on the event; staleness check backstops | owner (existing) |
| composer links | composer | id | `onDeviceUnregistered` | owner (existing) |
| exports (Alexa / HA / Google) | each exporter | id | unexpose / reconcile on the event | owner (existing) |
| `pipeline-analytics:*` (tracks, events, media, faces, plates, stats, scenes, scene-latch, stationary objects) | pipeline-analytics | `deviceId` column | NOT deleted; `deleteDeviceEvents` exists as an operator action | retention (operator's call) |
| `recorder:recording-configs`, segments, `recorder:segment-hours` | recorder | camera id | footage evicted first under disk pressure by the dead-device lane (D49-gated); config row has no removal hook found | retention for footage; config row open |
| `device-history` rows (`history.db`) | device-history | device id | departure tracker + retention | retention (history keeps a deleted device until its window ends) |
| `training` jobs / retrain frames referencing cameras | training / pipeline-analytics | camera id on the row | stay | retention (training datasets outlive the camera by design) |
| a driver's / other addon's own `addon-devices` and `addon-device-settings` rows | that addon | `<addonId>:<id>.` | stay unless the addon clears them (orchestrator does; audio-analyzer, motion-wasm do not) | owner — open, see below |

## Consequences

- A deleted device's keychain values disappear with it and an operator-visible log
  line says how many, per store.
- A failure in one store is isolated and retried a bounded number of times. The
  retry state is in memory by design; a process restart in the retry window leaves
  the orphan, which System -> Secrets then lists.
- `keychain.deleteDeviceScope` is a second owner-spanning door next to the
  operator's `deleteOrphans`. Its caller check is `device-manager` by name, which is
  identity against bugs, not against a malicious addon (same threat model as D787).
- Open for the operator: the generic "an addon's own per-device store is cleared
  when its device goes" hook (a `BaseAddon` default off `DeviceUnregistered`) was not
  added — several addons read their device store inside their own removal handler,
  and a blanket clear would race it. Each addon without a handler needs one written
  with its own ordering.

## Enforcement

`packages/system/src/builtins/device-manager/__tests__/device-removal-cleanup.spec.ts`
(scoped secrets and config rows removed, another device untouched, one failing store
isolated and retried, bounded give-up; removing the `keychain-secrets` step turns it
red) and `packages/system/src/builtins/keychain/__tests__/keychain-device-scope.spec.ts`
(every owner's value goes, other scopes stay, only `device-manager` may call).
