---
id: D655
title: The old Linked devices and Virtual doorbell sections are retired — the Extensions slots are the only editor of those stores
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-extension-linked-slot.ts
  - packages/ui-library/src/composites/extensions/**
  - packages/addon-admin-ui/src/pages/locations/rebuild-room-links.ts
---

## Context

[D648](adr-0648-a-device-extension-is-a-slot-declared-by-the-cap-that-owns-the-function-and-served-over-its-existing-store.md)
put a camera's linked devices and its virtual-doorbell trigger devices in one
Extensions widget, served by their owners over the stores they already had, and
KEPT the two hand-written sections (device-manager's "Linked devices",
virtual-doorbell's "Virtual doorbell") until a live measurement showed the two
surfaces agree. The operator authorised the retirement on that condition.

Measured on 2026-09-27, cameras 104, 101, 107, 102, 108, 103 and 636:
`deviceExtension.listSlots` returns exactly the linked-device ids and the
doorbell-source ids the old sections showed. The new read costs 0.15–0.22 s;
`deviceManager.getDeviceAggregate` costs 1.29 s.

What the parity measurement did NOT cover: the old "Linked devices" section had
a SECOND field, "Devices that produce tracked events"
(`_linkedDeviceTrackedIds`), and the `linked-devices` slot's value carried only
the pick list — although its own description already promised "the ones you opt
in produce tracked events on it". The opt-in is live: on 2026-09-27 camera 101
opts in device 4131 (`getLinkedDevicesBatch` over all 32 cameras, the only
one), and `pipeline-analytics` reads it through `producesTrackedEvents`.
Retiring the section as it stood would have left that store with no editor.

Two more things surfaced while removing the sections:

- `DEVICE_STORE_SECTIONS` existed only to split the linked-devices keys out of a
  `device-manager`-writer save; `migrate-hardware-state.ts` also read its key
  list to decide which config keys stay with a camera's NUMBER in a hardware
  swap.
- The Locations page's "Rebuild linked devices" wrote the list through
  `deviceManager.applyDeviceSettingsPatch` — one of the three methods
  `exposesDeviceSettings` adds — so removing the flag removed its write path.

## Decision

The device-manager and doorbell capabilities no longer declare
`exposesDeviceSettings`, and their providers no longer implement the three
contribution methods. A camera's linked devices, their tracked-event opt-in and
its virtual-doorbell trigger devices are edited ONLY through the
`linked-devices` and `doorbell-source` extension slots; the stores
(`_linkedDeviceIds`, `_linkedDeviceTrackedIds`, `doorbellSources`) and the
owners' write paths (`applyLinkedDevicesPatch`, `persistDoorbellSources`) stay.

1. **The opt-in moves into the slot.** `LinkedDevicesSlotValueSchema` gains
   `trackedDeviceIds`: a read always carries the stored opt-in AS STORED
   (absent key → `[]`, the resolver's NONE); on a write it is optional and
   ABSENT MEANS UNTOUCHED, so a card built before this change cannot erase it
   by saving the picks. A present list REPLACES the stored one. Each id must be
   a pick, a device the camera links by structure, or already stored
   (`refusedTrackedOptIns`): what was read can always be written back
   unchanged, and a NEW opt-in for a device the camera does not link is
   refused by name, nothing persisted.
2. **The card reaches the old section's set.** The old section offered a
   toggle for every RESOLVED link, tree children included. The slot row now
   carries `impliedSources` (optional on `ExtensionSlotState`): what the owner
   links by structure beyond the picks — the camera's tree children and the
   child a picked container stands for, never the container (D356). It is
   computed by the resolver's own `resolveLinkedDeviceIds` over the only rows
   it can reach (the picks, the camera's children and every container's
   descendants, one indexed `listByParentMany` per level), never the fleet;
   a spec pins it equal to `getLinkedDevices`. The card lists them as "Always
   linked", offers a toggle for each valid pick, each implied device and each
   stored opt-in no longer linked (so it can be removed), none for a picked
   container, and drops a pick's opt-in when the pick is removed.
3. **The Locations room rebuild writes through the slot** (`setSlot`,
   `device-manager:linked-devices`, picks only). It now meets the slot's
   validation — a new container, the camera itself or an unknown id is refused
   by name — and a refused camera no longer stops the others: each refusal is
   listed to the operator.
4. **The cross-refresh is gone.** `invalidateExtensionSurfaces` (D648) existed
   so a save through either surface re-read the other. With one surface, the
   widget re-reads its own `listSlots` after a save (`onSaved` → `refetch`) and
   `DeviceAggregateSection` invalidates only `getDeviceAggregate`, as it did
   before D648.
5. **What became dead went with it:** `buildLinkedDevicesContribution`, the
   doorbell addon's contribution/save/lookup, `DEVICE_STORE_SECTIONS` and the
   `device-manager`-writer split (`migrate-hardware-state.ts` now names its
   three role-scoped keys directly — the same three), the admin-ui's
   linked-devices enrichment in `FormBuilder` (and the `deviceId` prop threaded
   only for it), `LinkedDevicesResolvedView`, and their specs. `linkDeviceId`
   is untouched (D648: slice 3 only rewrites its comment).

## Consequences

- **D49's cold-start argument no longer holds, and the window it bounded is
  wider.** D49 opened the gate on a never-read camera because "a source can
  only be configured through this wrapper's own binding-gated settings
  surface". That surface is gone; the `doorbell-source` slot is offered on
  every camera (D648), bound or not. Configuring sources on a camera whose
  virtual doorbell was never bound can therefore ring it for up to two
  assignment-reload cycles (`never-seen`, then `unbind-pending`, both ring)
  before the mirror believes `unbound` — the same bound D49 accepted for an
  unbind, now reachable by a pick. The card says `inactive` once the reads
  agree. Not changed here; recorded in `binding-mirror.ts`. Also gone with
  the section: the two first-hand confirmations of the mirror D49 listed
  (`getDeviceSettingsContribution` and `applyDeviceSettingsPatch` were reached
  only through the binding). The addon's own `loadAssignments` cadence is now
  the mirror's only writer.
- **The old "Resolved links" preview is gone**; its content now lives in the
  card (the picks with their health, and the implied devices as "Always
  linked"). A resolution of a container pick is shown under the implied
  devices, not beside the pick.
- **A save from a page opened before the upgrade is refused, not lost.** It
  still carries `_linkedDeviceIds` / `_linkedDeviceTrackedIds` /
  `_linkedDevicesMode` on the `device-manager` writer; `applyGroupPatch`
  refuses the group by name (`LINKED_DEVICES_RESERVED_KEYS`) and logs it with
  `tags: { deviceId }`, where it would otherwise have reached the driver and
  been dropped. The old doorbell section's save (writer `doorbell`) already
  fails by name, because the cap no longer exposes device settings.
- **The reserved key set is ONE constant**, `LINKED_DEVICES_RESERVED_KEYS`,
  read by that refusal and by `migrate-hardware-state.ts` (which keys stay
  with a camera's number on a hardware swap).
- **Removed tRPC methods:** `deviceManager.getDeviceSettingsContribution`,
  `getDeviceLiveContribution`, `applyDeviceSettingsPatch`, and the same three on
  `doorbell`. Nothing in the server, the admin UI, the viewer or the Home
  Assistant component calls them after this change (the viewer stopped writing
  `_linkedDeviceIds` on 2026-09-22 and has a spec forbidding it).
- **Framework change**, like D648: types (cap + value schema), system (owners),
  ui-library (widget) and the server's generated routers. Live only in a
  published `@camstack/server` containing it; the admin UI must ship with it.
  An older admin UI against a new server loses its Locations rebuild (the
  method is gone); a new admin UI against an older server gets rows without
  `trackedDeviceIds` and therefore no toggle, and its rebuild's `setSlot`
  exists since D648.
- **Not changed, observed:** `migrate-hardware-state.ts` keeps only the
  linked-devices keys with the camera's number; `doorbellSources` swaps with
  the hardware. That predates this change.

## Enforcement

- `packages/system/src/builtins/device-manager/__tests__/camera-page-extension-sections.spec.ts`:
  the REAL aggregator over a real registry (device-manager, the virtual
  doorbell BOUND to the camera, both extension owners) answers a camera page
  with no `linked-devices` / `virtual-doorbell` section and no
  `_linkedDeviceIds` / `_linkedDeviceTrackedIds` / `doorbellSources` field,
  and with the `device-extension-widget`. Proven red by restoring the old
  caps, providers and aggregator split (both old sections came back) and by
  removing `deviceConfig` from `device-extension.cap.ts` (the widget half).
- `device-extension-linked-slot.spec.ts` (the opt-in): read, write-through to
  `producesTrackedEvents`, absent-is-untouched, explicit `[]`, refusal of a
  new unlinked opt-in, a read written back unchanged, a written opt-in
  replacing the stored one; the implied sources (tree child, a container
  pick's child, equal to `getLinkedDevices`) and opting a tree child in.
  Each proven red by disarming it in the owner.
- `device-aggregate.spec.ts`: a `device-manager`-writer save carrying the
  reserved keys is refused by name on the single and the batch path, the
  store is untouched, and a warn tagged `{ deviceId }` is logged. Red with the
  refusal disarmed and with the log demoted to debug.
- `migrate-hardware-state.spec.ts`: all three keys stay with the number on a
  swap. Red with the tracked key taken out of the reserved set.
- `doorbell-extension-slot.spec.ts`: a `setSlot` write is byte-for-byte
  `applyDoorbellSourcesPatch`, and a source written through it RINGS. Proven
  red by making `persistDoorbellSources` write nothing.
- `extensions-panel.test.tsx`: the toggle, the whole opt-in sent, a stale
  opt-in shown and removable, a tree child shown and opt-in-able, no toggle
  for a picked container or for a row without an opt-in, un-picking drops the
  opt-in, the panel's own re-read. Each disarm red.
- `rebuild-room-links.spec.ts`: the rebuild's write is the slot, picks only.
