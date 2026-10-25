---
id: D902
title: Five system tables are records kinds only, with no settings-store fallback; device-runtime-state stays a settings-door table
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - server/backend/src/core/agent/cluster-node-history-store.ts
  - packages/system/src/builtins/local-auth/oauth-session-manager.ts
  - packages/system/src/builtins/backup-orchestrator/schedule-store.ts
  - packages/system/src/builtins/backup-orchestrator/destination-policy.ts
  - packages/system/src/builtins/backup-orchestrator/seed-marker-store.ts
---

## Context

`cluster-node-history`, `oauth_sessions`, `backup_schedules`,
`backup_destination_policies` and `backup_seed_markers` were listed as physical
`declareCollection` tables on `camstack.db` (`docs/reference/storage.md`), and a
move to `ctx.records` was approved for them. Reading the code showed the move
had already happened in records phases 4 and 6: each owner has had a records
kind (`cluster-agent/node-history`, `local-auth/oauth-sessions`,
`backup-orchestrator/schedules`, `destination-policies`, `seed-markers`) since
2026-10, its rows were adopted on both operator hubs, and the legacy tables were
dropped offline (D900). What was left was a SECOND path in every store: when no
kind was bound, it fell back to the settings-store, `declareCollection`d the old
table and wrote there. That is why the generated storage map still listed them.

The fallback was not harmless:

- `ClusterNodeHistoryStore` is constructed at boot and its kind is bound later,
  when the addon registry wires the records provider. Any topology pass in that
  window `declareCollection`d `cluster-node-history` on the hub again and wrote
  rows into it that nothing would ever read once the kind was bound.
- The backup specs ran the orchestrator WITHOUT `ctx.records`, so they verified
  the legacy table path and not the records path production runs.
- The OAuth sweep (`reapRevoked`) filtered the kind on `revokedAt`, which the
  kind did not index. The engine refuses an unindexed filter, so the sweep threw
  on every hub, every day — and, sharing one `try`, the login-session, audit and
  device-credential reaps after it never ran. The fallback's spec drove the
  settings-store filter compiler on a hand-made `oauth_sessions` table and was
  green throughout.

`device-runtime-state` was on the same list. It is not a builtin's own table: it
is one of the four canonical key/value collections of the settings door
(`system-settings`, `addon-settings`, `addon-device-settings`,
`device-runtime-state`), reached by every device-owning process through
`ctx.settings.readDeviceRuntimeState` / `writeDeviceRuntimeState` (D870).
Records are owner-scoped to the transport-stamped caller (D881), and the writer
of that blob is the settings door on behalf of whichever process hosts the
device. Moving it is a change of the settings door, not of one store.

## Decision

The five tables are records kinds ONLY. Each store takes its kind handle and
nothing else; there is no `declareCollection`, no settings-store resolver and no
legacy row mapper. A store whose kind is not bound yet is UNAVAILABLE: it
writes nothing and answers every read as unanswered (`null` /
`store-unavailable`, D315) — it never creates a table. The backup orchestrator
without `ctx.records` keeps no schedules or policies and says so once at
initialize. The `oauth-sessions` kind gains a `revoked` index on `revokedAt`
(an additive redeclaration), so the daily sweep is index-served; it stays the
owner's sweep, because an active session has no lifetime of its own and an
engine TTL would expire working links. `device-runtime-state` stays a
settings-door table; it moves, if ever, with the other three canonical
collections.

## Consequences

- No row moves and no script is needed: the rows already live in `records` on
  both operator hubs (adopted in phases 4/6, D900). A `cluster-node-history`
  table that the boot window re-created on a hub holds only stale snapshots; it
  is dropped by hand offline with the other leftovers (`DROP TABLE` plus its
  `_collection_declarations` row), and the history re-fills itself from the
  kind.
- Every spec of these stores now runs on the real records engine
  (`makeRecordsWorld`, `makeBackupRecords`); the fakes that implemented the
  settings-store surface are gone.
- The OAuth sweep and the reaps after it run again on the next hub boot with
  this closure. That is a behaviour change: revoked links older than 30 days,
  dead login sessions, old audit rows and dead device credentials that piled up
  while the sweep threw are deleted on its first pass.

## Enforcement

- `packages/system/src/builtins/backup-orchestrator/__tests__/backup-config-lives-only-in-records.spec.ts`:
  the real addon, with and without `ctx.records`, leaves no `backup_*` table on
  a real settings backend (failed on the old code with all three present).
- `server/backend/src/core/agent/__tests__/cluster-node-history-store.spec.ts`
  ("before the kind is bound"): no `cluster-node-history` table, every read
  unanswered (failed on the old code).
- `packages/system/src/builtins/local-auth/__tests__/oauth-sessions-records-only.spec.ts`:
  the sweep deletes only rows revoked before the horizon, through the engine
  (failed with `records/unindexed-filter` before the index), and the auth
  schema creates no `oauth_sessions` table.
- `scripts/check-records-index-served.ts` proves the new index serves the
  sweep; `check-records-no-unindexed-where` no longer reports it.
