---
id: D339
title: A migration swaps hardware-scoped state with the device and forgets the broker's copy
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/migrate-device.ts
  - packages/system/src/builtins/device-manager/migrate-hardware-state.ts
---

## Context

`deviceManager.migrateDevice` existed to move the NUMBER: recordings on disk
(`<deviceId>/profile/…`), the hour ledger, the media store, zone ownership and
all four ecosystem exports key on the numeric id, so a camera replacement swaps
the two device rows and everything keyed on the number comes along.

On 2026-09-01 an operator replaced a Hikvision (id 618, 192.168.x.x) with a
new Reolink via `migrateDevice { sourceId: 108, targetId: 4362 }`. `swapIds`
moved the rows correctly — `addonId` and `stableId` followed the hardware —
and NOTHING else moved:

- The per-device CONFIG blob stayed with the number: device 108 (Reolink
  hardware) carried `host=192.168.x.x, port=80,
  deviceCache.model="DS-2DE2A404IW-DE3/W"` — the Hikvision's address,
  credentials and cached model — and was dialled at a dead address forever.
  Device 4362 wore the Reolink's config on Hikvision hardware. The proof the
  blob belongs to the hardware: writing the Hikvision config onto the Reolink
  was REJECTED by the Reolink driver's own zod schema (`motionSensitivity: 60`
  vs max 50).
- The stream broker still held `mid → native:slot-3` for 618 — a raw slot only
  the Hikvision had — and the `derived:Mid to low` feeder, defined against the
  old profile layout, respawned every ten seconds forever (observed at attempt
  2732). No log line named the stale assignment as the cause.

Two wrong turns are part of this record. First, the initial fix reset the
stream profiles by writing `_profileMap: {}` into the device config via
`deviceManager.setStreamProfileMap` — a key that is the LEGACY spelling of the
assignment: the admin UI stopped writing it (`StreamsTab.tsx` writes
`streamBroker.assignProfile` directly) and nothing reads it, so the reset would
have fixed nothing. Second, `streamBroker.unassignProfile` looked like the
reset primitive and is the opposite of one: it marks the slot MANUAL
(`auto: false`), which pins the stale choice and blocks
`computeInitialAssignment` from re-deriving on the new hardware's catalog.
Only the permanent-removal purge (`purgeAssignments`) deletes the entry, and
before this record it was reachable only through the `DeviceUnregistered`
event.

## Decision

**Role-scoped state follows the NUMBER. Hardware-scoped state follows the
DEVICE.** Concretely, `migrateDevice` must, in order, after `swapIds`:

1. **Swap** the per-device config blobs and runtime-state blobs
   (`swapHardwareState`), carving out the device-manager section keys
   (linked-devices — role) which stay with the number, and dropping the legacy
   `_profileMap` from both. A failure here THROWS: rows swapped with configs
   unswapped is the incident, and it must never be reported as a success.
2. **Forget** the broker's hardware state for BOTH ids over RPC
   (`streamBroker.forgetDeviceHardware`): every derived-stream definition is
   deleted (persisted, plus live feeder teardown and the pending queue), the
   profile-slot assignment entry is PURGED (never unassigned), the probe
   snapshots and the persisted RTSP token rows of the device's brokers are
   dropped. Inside the override blob the same rule recurses: the
   camStreamId-keyed maps (`hwaccel`, `sourceParser`, `sourceParserArgs`) go
   with the hardware; `audioMuted`, `preBuffer`, `preRollMs` and the debug
   flags are the operator's choices about the camera at this number and stay.
   An RPC, never an event — a dropped event (D8) leaves a feeder respawning
   forever.

Everything else in `docs/reference/storage.md`'s device-scoped collections is
role-scoped and stays put: tracks, faces, scenes, scene-latch, audio/sensor
events, stationary objects, the notification-center rows, recording configs.
Two mirrors self-correct by design and need no migration action:
`pipeline-orchestrator:device-features` (replaced on the first differing read
after the respawn) and `stream-broker:probe-snapshots` rows (the authoritative
flush drops rows for brokers the manager no longer holds — the forget merely
forces it).

## Consequences

- A replacement camera comes online at its own address, with its own probed
  catalog, and the broker derives its assignment fresh; no derived feeder
  survives to chase streams the new hardware does not have.
- The migration now depends on the stream-broker addon exposing
  `forgetDeviceHardware`; against an older broker the RPC fails and is
  REPORTED per id (loud log with a remedy), never silently skipped, and the
  migration still completes.
- Operator-authored derived streams and manual slot choices on BOTH ids are
  deliberately lost — they described hardware that is no longer behind the
  number. The target id (the outgoing box) is usually removed right after.
- Driver-private per-device rows other addons may keep under their own
  namespaces are NOT covered; the listed storage collections are.

## Enforcement

`migrate-device.spec.ts` pins the ordering (hardware swap after `swapIds`,
before any switch-up; both ids forgotten before the respawn) and that a failed
swap throws while a failed forget is reported. `migrate-hardware-state.spec.ts`
pins the split (driver keys swap, section keys stay, `_profileMap` dropped,
runtime blobs swap). `forget-device-hardware.spec.ts` pins the broker side —
including that the assignment entry is PURGED, not unassigned, and that the
deletion is persisted. Each was proven RED against the reverted fix.
