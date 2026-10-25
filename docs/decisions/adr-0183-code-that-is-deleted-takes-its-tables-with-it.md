---
id: D183
title: Code that is deleted takes its tables with it
status: superseded
superseded-by: D901
date: 2026-08-19
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/integration-registry.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
  - packages/types/src/interfaces/integration-registry.ts
  - server/backend/src/core/addon/integration-visibility.ts
---

> **Superseded 2026-10-22 by [D901](adr-0901-physical-tables-are-a-shrink-only-list-and-new-state-is-a-record-kind.md).**
> `RETIRED_COLLECTIONS` and the boot purge are deleted: every table they listed is
> gone from the operator hubs, and a removed table is now dropped offline by the
> operator in the change that removed it. The physical tables are a shrink-only list.

## Context

The `IntegrationRegistry` was two registries in one file. The INTEGRATION half
is live: 14 rows on the reference hub, read by the `integrations` cap provider,
by the REPL sandbox and by the boot backfill. The DEVICE half —
`createDevice` / `getDeviceByStableId` / `listDevices` / `listCameras` /
`updateDevice` / `deleteDevice` and a `setDeviceSetting` KV — was declared on
`IIntegrationRegistry`, implemented over two SQLite tables, wrapped method by
method by the visibility filter, exercised by its own tests, and called by
nothing. Measured on the production database: `devices` and `device_settings_kv`
held **0 rows while 974 devices were live**. Its `dev_NNNN` id-space could not
have been reconciled with the numeric ids every track, rule, binding and
recording refers to even if a caller had wanted to.

That is the expensive shape of dead code, not the cheap one. It did not merely
sit there: it type-checked, it had coverage, it had `@durable` records that
`docs/reference/storage.md` published as real storage, and it appeared in the
schema of every hub — so the answer to _where do per-camera settings live_ had
two candidates, one of which was a lie. `docs/design/2026-08-03-storage-table-map.md`
had to spend a section per table proving they were dead, and the 2026-08-19
flatten investigation re-derived the same fact from scratch.

Deleting the code alone would not have fixed it. The tables outlive the code
that created them: a hand `DROP` cleans one machine once, and the next restore
of any earlier backup brings the schema back. The existing retirement machinery
could not express this either — `purgeRetiredSettingsKeys` drops keys inside a
live row and `purgeRetiredSettingsRows` drops rows inside a live collection.
Emptying a retired table leaves the table, and the table is the part that
misleads.

## Decision

**A feature removed from the code takes its tables with it, declaratively.** A
retired table is listed in `RETIRED_COLLECTIONS` (`retired-collections.ts`) in
the same change that deletes its last declaration, and `purgeRetiredCollections`
drops it at every boot of the settings engine — so a restored backup converges
instead of resurrecting the schema. The drop reports the rows it destroyed:
zero is `info`, non-zero is `warn`, because "nothing read this" is a claim about
the code and the count is the only evidence of what it cost on that machine. A
drop that faults is warned about and retried next boot; housekeeping never
fails a boot.

Unlike the key and row purges, this one is **not role-gated**. Retired keys live
in the hub-central settings store, so cleaning them on an agent is work that can
never find anything; a table is materialised by whatever engine the declaring
code booted next to, so every node has its own copy to drop.

The instance: the device half of the integration-registry is gone — the methods,
the `PersistedDevice` / `CreateDeviceInput` / `DeviceIdentity` types, the
visibility passthroughs, the tests, and both tables. **The device authority is
the `device-manager` capability** ([D182](adr-0182-a-fleet-is-rows-not-a-blob-and-a-per-device-question-costs-one-row.md)),
and a device method on the integration registry means creating a second one.

## Consequences

- `IIntegrationRegistry` is integrations only. An addon that wants to persist a
  device uses `deviceManager.registerDevice`; there is no longer a second door
  that looks like it would work.
- `deleteIntegration` no longer cascades to devices, because it has no device
  children. The live cascade is unchanged and lives where it always ran:
  `integrations.delete` calls `deviceManager.removeByIntegration`.
- The engine grows exactly one DDL method, `dropRetiredTable`, which also evicts
  the two memos that outlive a table (`structuredTables`,
  `declaredCollections`). Dropping behind their backs would leave a ghost: a
  later declaration of the same name memoised as "already materialised" against
  a table that no longer exists.
- Listing a table here while something still declares it produces a drop and a
  re-create on every boot — churn no test would catch. The list is only for
  tables whose declaring code has been deleted in the same change.
- Nothing has to happen at cutover. The purge is idempotent, and on a hub that
  has already dropped the tables it is silent.

## Enforcement

Tests, and the shape of the code:

- `packages/system/src/builtins/sqlite-storage/__tests__/retired-collections.spec.ts` <!-- drift-ok: deleted 2026-10-22 (D901) -->
  runs against the real `SqliteSettingsBackend` on `:memory:` — a drop with rows,
  an idempotent second pass, an absent table, a re-declaration after the drop
  (the ghost regression, verified to fail when the memo eviction is removed), an
  agent role, and a fault that does not stop the next spec.
- `purgeRetiredCollections` takes no `env` parameter, where its sibling does, so
  the hub gate cannot be re-introduced by copying a signature.
- The device half cannot come back by accident: `IIntegrationRegistry` no longer
  declares it, so any re-implementation is a type error at the class, and
  `docs/reference/storage.md` regenerates from the `@durable` records that were
  deleted with the tables.
