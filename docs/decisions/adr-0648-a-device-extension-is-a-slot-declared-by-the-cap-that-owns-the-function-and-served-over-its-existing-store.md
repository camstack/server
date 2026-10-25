---
id: D648
title: A device extension is a SLOT declared by the cap that owns the function and served by that owner over its existing store — the common place is a contract, never a store
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/types/src/device-extension/**
  - packages/types/src/capabilities/device-extension.cap.ts
  - packages/types/src/generated/extension-slots.ts
  - packages/system/src/builtins/device-manager/device-extension-linked-slot.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - packages/ui-library/src/composites/extensions/**
  - scripts/generate-extension-slots.ts
  - scripts/check-extension-slots.ts
---

## Context

"What is this camera extended with by other devices" had three answers in three
places, each a hand-written settings section over its own store: the camera's
linked devices (`_linkedDeviceIds`, device-manager), its virtual-doorbell trigger
devices (`doorbellSources`, virtual-doorbell), and — asked for next — the HA
entities of a pet feeder that should become the feeder's OWN consumables. The
first two could not be seen together, and the third had no place to live at all.

What was tried before, and failed, is recorded in the entity-extensions survey
and design of 2026-09-26 (the operator's local design notes, not in the
repository): the June "device links" plan put a binding without a provider and a
field written onto another provider's cap into the kernel, and its deletion left
`status.itemArray` / `status.empty` behind with no live caller. A generic
"extensions" store was the obvious next shape, and it is the same defect again:
a second store beside the authority that already owns each function — D62's
"two knobs, one of them writes a store nobody reads".

Three things surfaced while wiring slice 1 that the design did not know:

1. `scripts/lib/parse-cap.ts` named a cap by "the first `export const x = {`" in
   its file. A slot descriptor declared above the cap made every proxy generator
   emit `typeof DOORBELL_SOURCE_SLOT` as the doorbell capability, and the types
   build failed. The parser now prefers the `*Capability` export.
2. The D554 dispatcher turned a throwing source into a row only for
   `listSources`, and only on the fan-out path: a device whose ONLY owner threw
   answered with an error, and an owner that threw on `listSlots` simply lost its
   rows. Either would have let the section say "no extensions" about a device
   nobody could read (D315).
3. `applyLinkedDevicesPatch` — the linked-devices section's save — validates
   nothing: its picker never offers a container, and the Locations page writes
   the list through it. "The two surfaces share their validation" was not true
   of the existing path.

## Decision

1. **A slot is declared by the capability that owns the function**
   (`extensionSlots` on its `*.cap.ts`, D4): `linked-devices` in
   `device-manager.cap.ts`, `doorbell-source` in `doorbell.cap.ts`. The
   descriptor and its value schema are named exports; `npm run codegen` folds
   every declaration into `generated/extension-slots.ts` (the id enum, the
   table, the discriminated union of values keyed on `slot`, and the host device
   types). Adding a kind is a descriptor, one
   `defineExtensionSlotProvider('<id>', …)` in the owner, and codegen.
2. **`device-extension` is a contract, not a store.** A device-scoped wrapper
   collection (the D554 shape): its providers are the slot owners, a device's
   owners are its bindings, `listSlots` fans out, `listCandidates` / `setSlot`
   route by the `slotRef` prefix (`<source>:<slotId>`, the D554 separator).
   It declares no config method and persists nothing (guarded).
3. **Each owner serves its slot over the store it already has, through the
   write path its existing surface uses.** `linked-devices` reads with
   `parseLinkedDevicesConfig` and writes with `applyLinkedDevicesPatch`;
   `doorbell-source` reads with `parseDoorbellSources` and writes with the
   addon's one `persistDoorbellSources` (which the settings save now also
   calls). No new store, no migration. A write through either surface is read
   back by the other, byte for byte.
4. **A slot's own validation refuses NEW illegitimate picks by name before
   persisting** — the host itself, a container (never a pick, D356), an id no
   device has. An id already persisted is kept (and shown with its health); the
   OLD section's save path is not hardened in slice 1, so it changes no
   behaviour while both surfaces coexist.
5. **An owner that cannot answer is a ROW.** The dispatcher's per-cap failure
   rows (`CAP_FAILURE_ROWS`) turn a throwing `device-extension.listSlots` into
   `{ state: 'unreachable', addonId, reason }`, on the one-owner path too. The
   widget claims "no extensions" only from an answered empty list.
6. **A gate owned by another authority is reported, never written.** The
   doorbell slot reports whether the wrapper is bound to the camera
   (`activation`, from `getBindings`, naming `setWrapperActive`); a failed read
   is `unknown`, never `inactive`. A `setSlot` is not evidence of that binding
   and does not confirm the D49 mirror.

### Operator decisions taken after the design, and where they leave room

- **Consumables gain an optional `remaining { value, unit }`** — slice 2. The
  contract does not constrain `ConsumableItemSchema`; the graft slot's value
  schema is the place a unit is authored.
- **Battery: Home Assistant will supply its battery through a graft, and a
  battery graft REPLACES HA's automatic pick** — slice 2 or later. The
  descriptor already carries `shape: 'graft'`, `projects` and a per-slot
  `enabled`, and a graft is served by the host's own provider, which is the one
  authority deciding between its automatic pick and the graft.
- **The hand-written "Linked devices" and "Virtual doorbell" sections are
  retired after slice 1's live measurement**, not before: slice 1 keeps both.
- **`linkDeviceId` is kept.** Slice 3 only rewrites its stale comment; it is the
  accessory-child → parent marker the orphan reconcile prunes by.

### Deviations from the design text

- `ExtensionSlotState` carries a top-level `state: 'ok'` and the unreachable row
  is its own arm (`state: 'unreachable'`), instead of an `availability` object on
  every row: TypeScript narrows a union on a top-level discriminant, not a
  nested one, and an unreachable owner cannot fill `slot` or `value`.
- `slotRef` is `<source>:<slotId>`, not `<source>/<slotId>`: `:` is the prefix
  rule the D554 scalar router already implements, so no dispatcher change was
  needed to route by it.
- `device-extension.deviceTypes` is DERIVED by codegen (the union of every
  slot's host types, today `camera`), so the section appears only where a slot
  is offered rather than on every device page saying "no extensions".

## Consequences

- Every camera now has two more derived bindings (`device-extension` →
  device-manager, virtual-doorbell), persisted nowhere (D554 step 0). The
  bindings UI lists them.
- A device page's Extensions section costs one `getBindings` in the dispatcher
  (measured up to 5.24 s on the live hub, 2026-08-30) and, per owner, reads by
  id only: device-manager labels the picked ids with ONE indexed ledger read
  (`rows.getMany`), never a fleet listing; virtual-doorbell reads the host once,
  labels its sources with ONE `listAll({ deviceIds })`, and answers the
  wrapper's activation from its D49 mirror — a second `getBindings` only for a
  camera the mirror has never seen, and no read at all for a camera with no
  sources. Only `listCandidates` (the editor opening) lists the fleet. Each skip
  is pinned by a spec that counts the reads.
- The General tab shows the two stores twice during slice 1. A save through
  either surface re-reads both (`invalidateExtensionSurfaces`, used by the
  Extensions card and by `DeviceAggregateSection`); without it a stale old
  section wrote its old list back and silently unlinked what the card had just
  added.
- A new doorbell source must be a device carrying a source cap
  (`listDeviceIdsByCaps(SOURCE_CAPS)`), which also refuses containers and ids
  no device has; an already-saved source is kept.
- Framework change: a new cap, a descriptor field and a generated module in
  `@camstack/types`, a dispatcher change in the server. Live only in a published
  `@camstack/server` that contains them (D16); slice 2's HA addon must check the
  minimum server version at boot.
- `scripts/lib/parse-cap.ts` now reads `name:` and `scope:` from the
  capability's OWN block. The first-in-file rule had silently misclassified
  two existing caps in the generated proxies: `camera-pipeline-config` (a
  docblock said `scope:'system'`, the cap is `device`) and
  `notification-rules` (a `system` cap read as `device`). Both regenerated.
- **Parked, for the first caller:** after that reclassification the
  generated `DeviceProxy.cameraPipelineConfig` dispatches per binding, while
  `capability-router-map.ts` still marks `camera-pipeline-config` a
  singleton. Nothing calls the proxy member today; whoever calls it first
  must reconcile the two. The router map is deliberately left unchanged in
  slice 1.
- **The virtual-doorbell card is READ-ONLY.** Its `activation` is
  `ringVerdict(mirror, durable)` (`binding-mirror.ts`), the one pure function
  the ring gate (`ringsDespiteUnboundMirror`) also decides with, so the card
  says exactly what a press would do: `bound` rings; `unbind-pending` and
  never-seen ring (the gate errs open); `unbound` consults the durable
  authority read-only — `bound` rings, `unreadable` is `unknown` ("could not
  verify", a press still rings), and only a durable `unbound` is "inactive".
  The card never refreshes or writes the mirror: the addon's own
  `loadAssignments` cadence remains its only writer, single-flight, so
  overlapping triggers count one read. An intermediate version (round 2) made
  the card refresh the mirror; a page refetch during a store blip could then
  have silenced the gate's input — that is what this rule forbids.
- `scripts/lib/parse-cap.ts` finds the `*Capability` export first. A cap
  file whose capability does not follow the naming convention still works
  through the old fallback, as long as it is the first object export.

- **The `doorbell-source` slot is retired (D671 slice 6, 2026-10-01).**
  `device-extension` serves one slot, `linked-devices`; its generic `activation`
  field stays in the contract with no producer (see D676's owed decision). The
  virtual-doorbell owner of that slot, and the spec this record names for it
  (`doorbell-extension-slot.spec.ts`), are deleted.

## Enforcement

- `scripts/check-extension-slots.ts` (CI): unique ids, a graft projects its own
  deviceNative cap, exactly one owner per slot in an addon whose manifest
  declares `device-extension`, no owner of an undeclared slot, the generated
  module in sync, no store-shaped contract method, no `slot` key in a value,
  host types present. Fixture spec
  `scripts/__tests__/check-extension-slots.heavy.spec.ts`; proven live by dropping
  `device-extension` from virtual-doorbell's manifest and by adding a
  `saveSlots` method (both red).
- `scripts/check-device-scoped-wrapper-mounts.ts` names `device-extension` (and
  `videoclips`) as expected per-device collections; proven red by removing
  `kind: 'wrapper'` from the cap.
- `server/backend/src/__tests__/cap-routers/device-extension-dispatch.spec.ts`:
  fan-out, routing by `slotRef`, an unclaimed ref refused, an unreachable owner
  as a row (also as the only owner). Proven red by removing the failure-row
  entry (2 of 8 fail).
- `packages/system/src/builtins/device-manager/__tests__/device-extension-linked-slot.spec.ts`
  and `packages/system/src/builtins/doorbell/__tests__/doorbell-extension-slot.spec.ts`: <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
  byte-equivalent writes through both surfaces, read-back both ways, refusals,
  candidates, `unknown` activation. Proven red by bypassing each shared write
  path, by disabling the pick validation and by reading a failed bindings call
  as `inactive`.
- `packages/types/src/__tests__/device-extension-contract.spec.ts`: the union
  accepts each slot and refuses the wrong one, the mount is `device-scoped`, the
  host-type gate. `packages/ui-library/src/composites/extensions/__tests__/extensions-panel.test.tsx`:
  the four D315 states, an only-owner failure never reads as absence.
