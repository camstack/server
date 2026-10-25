---
id: D294
title: "An addon's settings view resolves its backend PER CALL — the door's own owner is built before the door"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/kernel/config-manager.ts
  - packages/system/src/kernel/settings-door-view.ts
---

## Context

`storageMigration.start` failed on the live hub the first time it was ever
called:

```
POST storageMigration.start → [ConfigManager] SettingsStore not initialized -- call setSettingsStore() first
```

`plan` returned cleanly on the identical input, which was the misleading part.
`plan` persists nothing. `start` writes the durable job
(`storage-migration-coordinator.ts:365`), and that is the FIRST time this
capability has ever touched a store.

The throw is `ConfigManager.setAddonConfig` (`config-manager.ts:329`), reached
through `BaseAddon.state()` → `ctx.settings.writeAddonStore`. `ctx.settings`
comes from `ConfigManager.createSettingsView`, which had two backends and chose
between them **once, when the view was constructed**:

- the sync `ISettingsStore` handle, wired by `setSettingsStore`;
- the async `settings-store` door, wired by `setSettingsDoor`.

Both are wired from `onProviderRegistered('settings-store')`
(`addon-registry.service.ts:2794`, `:2816`). `settings-store` is owned by
`storage-orchestrator` (D44). `createAddonContext` — and therefore that addon's
settings view — is built at `addon-registry.service.ts:1590`, and the
registration that wires the door happens at `:1607`, after `initialize()`
returns. **The door's own owner is the one addon that can never see the door at
view-construction time.** It got the sync backend by elimination.

That was survivable until D181 isolated `sqlite-settings` into its own process
(2026-08-24). The `data-store-provider` in hub-main's registry became a UDS
proxy, which is not an `ISettingsStore`, so `setSettingsStore` stopped being
called on the hub at all — only `setSettingsDoor`. From that day the storage
orchestrator held a backend that would never be wired: every
`writeAddonStore` threw and every `readAddonStore` answered `{}` **in silence**,
which is why `storageMigration.status` had always returned `null` and looked
like "no job has ever run" rather than "this addon cannot read its own store".

Every other in-process builtin was unaffected: `INFRA_CAPABILITIES` boots
`storage-provider` (filesystem-storage, which stores nothing) and then
`storage` (the orchestrator itself); everything else is constructed after the
door exists. The blast radius was exactly the addon that owns the door.

**What does not work as the fix.** Making `setAddonConfig` fall back to the door
the way `set()` does (`config-manager.ts:249`) — that fallback is
fire-and-forget, because the method is synchronous, so a durable job would
"succeed" without landing. Nor a lazily-wired store inside `persist()`, nor a
second store handle in the coordinator: `storage-orchestrator` already reaches
the engine directly for its LOCATION table, and a second such path for the
migration job would be the shadow registry the kernel rules forbid.

## Decision

`ConfigManager.createSettingsView` returns a facade that resolves its backend on
**every** call. The sync `ISettingsStore` still wins when one is wired; the door
is used the moment it exists, whether that is before or after the view was
built. No addon's persistence may depend on the order in which its context and
the settings-store provider happened to be constructed.

## Consequences

- Both concrete backends now satisfy `SettingsViewBackend`, which requires
  `readDeviceStoreBatch`. The optional form stays on the public
  `AddonSettingsView` for the one implementation that genuinely cannot batch —
  a forked runner's UDS view — so `device-queries.ts#readDeviceConfigs` keeps
  its fallback. The store-backed batch is the per-device read in a loop with the
  same per-device tolerance, and costs no extra round trips because the sync
  store is already resident.
- The door-backed view is memoised per view and rebuilt if the door handle is
  replaced, so a re-registered settings-store provider is picked up rather than
  pinned.
- `storage-orchestrator` now reads its own addon store for the first time since
  2026-08-24. A durable migration job written before this fix does not exist —
  none was ever written.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/storage-migration-durable-state.spec.ts`
drives `StorageMigrationCoordinator.start` through the real chain in the
production order — real `createDurableState`, real
`ConfigManager.createSettingsView` built BEFORE `setSettingsDoor`, real
`createDoorSettingsView` — over an in-memory engine that actually stores. The
existing coordinator suite injects a closure-backed `MigrationState`, which is
precisely why 28 green tests never touched this: a fake supplied the durability
production could not. Reverting the per-call resolution turns that spec red with
the verbatim production error.
