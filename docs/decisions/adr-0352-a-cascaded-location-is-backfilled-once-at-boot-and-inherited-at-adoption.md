---
id: D352
title: A container's cascaded location is backfilled once at boot and inherited at adoption — container subtrees only, and misalignment is never silent
status: accepted
date: 2026-09-05
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/location-alignment.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-linked-devices.ts
  - packages/system/src/builtins/device-manager/device-manager.addon.ts
---

## Context

D252/D329 made `setLocation` cascade a location onto every descendant's own
`location` column, and both said out loud: **nothing retroactive**. A parent
located before the cascade shipped does not align its descendants until the
operator re-saves it. That consequence was carried as acceptable and turned out
not to be. Measured on the live fleet 2026-09-04: **40 containers, 373
children** at `location: null` under a located container — each of those
containers wholly invisible to AUTO-mode linking (the container itself is
deliberately never a link; its children never matched), and not one log line
anywhere. Camera 101 showed one siren where two locks, a switch and a door
contact belonged. The data was repaired by hand; the mechanism still
guaranteed the hole would reopen, because the cascade only fires on
`setLocation` and **a child adopted after the parent was located is the same
hole again** — an HA re-sync that grows an entity gives nobody a reason to
re-save the container.

The alternative tried first (before D252) was read-time
inheritance — rejected then and again now; D252 records why (a live-resolved
location is invisible everywhere except the one call site). The fix lives at
write time, like the cascade itself.

One scoping question was settled by measurement, not taste. The hand repair
deliberately covered only the 40 containers and left 6 located CAMERAS with 7
location-less accessories (sirens 585/588/589/591/616/3220, floodlight 594).
Should an automated pass fill those too? Verified with the real
`resolveLinkedDeviceIds` over the real fleet snapshot: filling all 7 changes
**no camera's resolution today** — but only because every affected room holds
exactly one camera. Adding a synthetic second Hall camera and filling siren
591 made that camera list its neighbour's siren as a companion (a
location-matching candidate whose parent is a camera falls through to
`ids.add`; only a Container parent routes through the one-child expansion).
That is precisely the companion-list noise this panel was cleaned of twice. A
camera's accessories are already fully reachable through the structural
children-of-self rule, so a location buys their own camera nothing.

## Decision

The write-time model is completed on three sides — **for container subtrees
only** — and the broken state loses its silence:

1. **One-shot boot backfill** (`runLocationBackfillAtBoot`,
   `location-alignment.ts`): at device-manager boot, every row with
   `location: null` whose parent chain reaches a located ancestor **that is a
   `DeviceType.Container`** is written that nearest located ancestor's
   location — once per install, guarded by an addon-store marker
   (`locationBackfillVersion`) that only advances when every planned write
   landed. The nearest located ancestor DECIDES: a located non-container on
   the way up blocks the fill. Runs under `withMetaWriteLock`, re-checks each
   row is still null before patching, and fills **null only** — an automated
   pass carries no operator intent, so unlike the operator's cascade (which
   stays type-agnostic per D329: an operator re-saving a camera accepts the
   trade explicitly) it never overwrites an explicit different location and
   never manufactures cross-camera companions.
2. **Adoption-time inheritance** (`registerDevice`,
   `device-meta-actions.ts`): a registering row whose own location is null and
   which is newly adopted or re-parented inherits the nearest located
   **container** ancestor's location onto its own column, and pulls it down
   onto its own null-location descendants (out-of-order adoption registers
   children before parents). Same per-row event contract as the cascade,
   bounded by one adoption's subtree.
3. **Detection, every boot and every resolve** — same container scope: the
   boot pass re-scans the fleet read-only and WARNS per misaligned container
   ancestor (`tags: { deviceId: <ancestor> }`, `misalignedDescendantIds`);
   and `getLinkedDevices` warns (deduped per camera-container pair per
   process) when a container matching the camera's location is skipped with
   no location-aligned children. A camera-child null state is neither
   repaired NOR warned: a state deliberately left alone must not be nagged
   about forever.

Boot backfill events are **coalesced**: one `DeviceMetaChanged` per repaired
ancestor, never one per row. The viewer invalidates its meta-sensitive query
heads on every event of this category (deliberately broad), so one event per
subtree already carries the full effect for every derived-state consumer,
and the backend meta mirror re-warms the fleet at `SystemAddonsReady`, which
follows this pass. A fleet-wide repair must not fire hundreds of client
invalidations (events are telemetry — D8; the rows are the truth).

## Consequences

- D329's "Nothing retroactive" consequence no longer holds **for
  containers**; its decision (the operator cascade, no type predicate) is
  untouched, and so is D252's rejection of read-time inheritance — the
  resolver still compares own columns only.
- The live 7 camera-accessory rows stay `location: null` **on purpose**, and
  the narrowed planner was verified to fill 0 rows on the current fleet — the
  hand repair of 2026-09-05 is preserved exactly.
- A location-less child under a located **container** is now an anomaly (a
  partially-failed cascade, a hand-edited ledger), named in the log every
  boot until re-saved. The one-shot does not re-repair a re-entered anomaly —
  deliberately, so an automated pass can never fight an operator's later
  edit.
- A location-less child under a located **camera** is a normal, permanent
  state: linked structurally to its own camera, invisible by location to
  every other — and if the operator wants it in a room, re-saving the camera
  cascades it (D329), accepting the cross-camera exposure explicitly.
- `registerDevice` pays an ancestor walk (row reads bounded by tree depth)
  only on first registration or re-parenting of a location-less child.
- A clean boot pays no extra fleet read: detection reuses the warm-boot
  `listAll` the ownership cache already required.
- The pre-cascade legacy state can no longer be produced via
  `registerDevice` + `setLocation` (both now align container subtrees) — a
  test that wants it must seed the ledger row directly, which is also the
  only way the state can exist in production.

## Enforcement

`packages/system/src/builtins/device-manager/__tests__/location-alignment.spec.ts`:
the pure planner (nearest ancestor wins and blocks, container-only, camera
subtree untouched, fill-null-only, cycle guard), the backfill across a
simulated reboot (repair + ONE coalesced event per ancestor + per-ancestor
log), the one-shot marker (a re-entered anomaly is warned about, not
rewritten), the camera-child state (neither repaired nor warned),
adoption-time inheritance including the camera refusal and out-of-order
registration, and the deduped resolver warn — all RED-proven against the
prior behavior. The D252/D329 invariants stay pinned by
`device-linked-devices.spec.ts` ("no read-time inheritance", the re-save
end-to-end — reseeded onto the raw row, same assertions).
