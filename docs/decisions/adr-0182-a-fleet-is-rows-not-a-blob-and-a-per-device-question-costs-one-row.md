---
id: D182
title: A fleet is rows, not a blob — a per-device question costs one row
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-row-store.ts
  - packages/system/src/builtins/device-manager/device-meta-store.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-queries.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts
---

## Context

[D181](adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md) named the
cost and capped one instance of it. This record removes the instance.

The device-manager kept its whole fleet in three JSON values on its
`addon-settings` row set — `deviceMeta` (467 KB, 974 devices), `deviceMetadata`
(87 KB, 870), `deviceIndex` (70 KB, `Record<addonId, stableId[]>`). 625 KB of
that table's 627 KB. As a hub BUILTIN the addon's `ctx.settings` is
`ConfigManager.createSettingsView`, so:

  - every read was `getAllAddon('device-manager')` — all six keys read and
    `JSON.parse`d, synchronously, on hub-main's event loop, to answer *what is
    device 102 called*;
  - every write was `setAllAddon(id, { ...existing, ...patch })` — a DELETE and
    re-INSERT of all six rows, so renaming one camera rewrote 625 KB.

The first fix was `readAll()`: one read serving three projections instead of
three. It took `listAll` from 3× to 1× and left the 625 KB exactly where it was
— which is the part worth recording, because it looked like the fix and a V8
profile of the 2026-08-19 boot still had hub-main 99.9% busy for 76 s with 64%
of it inside `getAllAddon`.

Two more things were structurally impossible under the blob and are gone with
it. `listAll` and `getChildren` resolved a `deviceIndex` stableId against
`deviceMeta` with `.get(...)!` — a non-null assertion that THREW the whole
listing whenever the two disagreed. And `removeLocation`'s cascade
read-modify-wrote the entire map OUTSIDE `withMetaWriteLock`, so a
`registerDevice` in that window had its freshly-written row replaced by the
pre-read snapshot.

## Decision

The device fleet is one row per device in `device-manager:devices`, declared
through `settings-store.declareCollection` with typed columns. A per-device
question is a primary-key lookup; a per-addon, per-parent or per-integration
question is an indexed `where`; a write names the columns it changes and
touches nothing else. There is no `deviceMeta`, no `deviceMetadata`, no
`deviceIndex`, and no dual-read: the code reads and writes rows only.

`deviceIndex` is not migrated. `addonId` and `stableId` are columns, so an
addon's device list is a query; the one bit it carried that is NOT derivable —
membership meaning "`registerDevice` has run at least once", which is how
`registerDevice` tells a first registration from a meta refresh — is the
`registered` column, because `allocateDeviceId` writes a row WITHOUT
registering.

## Consequences

- **A NULL column is an ABSENT field.** The blob could tell `linkDeviceId: null`
  ("explicitly cleared") from a missing key ("never set"); a column cannot.
  Every reader in the repo already gated on `typeof === 'number' | 'string'`, so
  nothing branched on the difference — but a future field that needs the
  distinction must carry its own sentinel, not assume the storage keeps it.
- **`metadata` is a column of the device row, not a second collection.** The
  split existed only because a blob write is whole-value and a lifecycle writer
  that had to preserve `metadata` would eventually clobber `setMetadata`. Column
  writes cannot do that.
- **`withMetaWriteLock` still exists and is still required.** Column-scoped
  writes removed the cross-field clobber; they do not order a same-field
  read-modify-write (`setMetadata`'s merge, `setName`'s cascade,
  `registerDevice`'s preserve-or-adopt). `removeLocation`'s cascade now runs
  under it.
- **Fleet reads must pass an explicit `limit`.** `settings-store.query` imposes
  a silent 2 000-row default cap and the reference hub is at 974 devices;
  `DEVICE_ROWS_FLEET_LIMIT` is the engine's hard ceiling so a truncation is a
  loud failure rather than a shrunken fleet.
- **A column added later must be nullable or carry a `defaultValue`.** Anything
  else is non-additive, and `declareCollection` answers non-additive by DROPPING
  the collection.
- **The cutover is not automatic.** `scripts/migrate-device-manager-blobs.mjs`
  is an offline pass the operator runs with the hub STOPPED. The blobs are
  retired as whole rows (`RETIRED_SETTINGS_ROWS`) by the device-manager itself
  at the first boot that finds `device-manager:devices` non-empty — never
  before, because until then they are the only copy.

## Enforcement

- `packages/system/src/builtins/device-manager/__tests__/meta-store-read-amplification.spec.ts`
  pins the read shape: one `get` per device question, one bounded `query` per
  fleet question, no retention, and the drop-work warning when a patch matches
  no row.
- `.../__tests__/location-registry.spec.ts` pins the cascade under the lock — it
  fails when the lock is removed.
- `.../sqlite-storage/__tests__/retired-settings-keys.spec.ts` pins that the row
  purge REFUSES while its successor collection is empty.
- The blob shapes are unrepresentable: `AddonStore` no longer declares
  `deviceMeta` / `deviceMetadata` / `deviceIndex`, so a reintroduction is a type
  error rather than a review catch.
