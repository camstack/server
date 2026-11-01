---
id: D987
title: A migration runs at boot under its owner — one ledger per database file, one transaction per migration, a verified snapshot first
status: accepted
date: 2026-10-31
supersedes: D853
applies-to:
  - packages/types/src/migrations/**
  - packages/types/src/capabilities/migrations.cap.ts
  - packages/system/src/builtins/sqlite-storage/migrations/**
  - packages/system/src/builtins/sqlite-storage/sqlite-snapshotter.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
  - packages/types/src/addon/base-addon.ts
  - scripts/check-migrations-well-formed.ts
  - scripts/check-migrations-well-formed.ts
---

## Context

D853 said the product carries no code that converts a stored shape: conversions are
offline scripts, run once, by hand, against a stopped hub. That held while one
installation had history. It does not hold any more. Every shape change since
(retired settings keys, device blobs, the quantity field names, the Reolink
hub-device move) grew its own carry-over: a marker key (`migratedEnabled`), a boot
purge, a retry ladder on timers, or a script that opens a database from outside the
process that owns it. Each one is different, none records that it ran, none is
visible when it fails, and a restored backup silently reverts the data to the shape
the code no longer reads.

The first attempt at a framework put the ledger beside the data (a file) and the
data in a database: a crash between the two re-ran or skipped a migration. A
ledger row has to commit in the SAME transaction as the data it describes.

## Decision

**A migration is code that ships with the version that needs it and runs at boot,
under the process that owns the data, in a boot order the framework decides. Its
identity (`<owner>/<date>-<slug>`), its order (`seq` within an owner, `dependsOn`
across owners) and its outcome are recorded in a `_migrations` ledger inside the
SAME SQLite file as the data it touches** (`camstack.db`, `events.db`, `history.db`),
reached only through the owner's connection or worker (D679). For each migration:

1. The data change and its ledger row commit in ONE `db.transaction`. A failure rolls
   the data back and is recorded in a separate transaction as `failed`.
2. A migration whose dependency is `failed` or `blocked`, or whose predecessor in the
   same owner failed, is `blocked` and not attempted. The hub always finishes booting.
3. Before the first pending migration of a file runs, the owner writes a verified
   pre-migration snapshot of that file (the D693 snapshot, purpose `pre-migration`),
   to `<db>.pre-migration/`, last 3 kept, never swept by the backup sweep. If the
   snapshot is refused, nothing runs on that file: its migrations are `blocked` with
   reason `snapshot-refused`. `events.db` is snapshotted only when a migration touches it.
4. A ledger id this code does not know (a newer database restored under older code)
   is `skipped-newer`: nothing is written and a warning is raised.
5. After `restorePreMigration` the migrations that snapshot predates are `held`: they
   do not rerun until the operator retries or a new code version ships.
6. The ledger is the authority for what failed. The Alert Center reconciles one
   critical alert per failed id from `migrations.listLedger`; an event is only a hint (D11).

This supersedes D853: its "no migration code" rule is reversed. It amends D693: a
snapshot has a second purpose, the safety copy taken before a migration, and a
separate directory so the backup sweep cannot delete it.

## Consequences

- Operators no longer run conversion scripts against a stopped hub; offline scripts
  and one-off marker keys are folded into migrations in later phases.
- A pending migration costs one verified copy of its file, on the live disk, before
  it runs; a disk without space for it keeps the old shape instead of a half-moved one.
- `_migrations` is a table consumers must not read directly; the cap is the surface.
- A restored backup carries its ledger, so what it lacks runs again at the next boot.
- `blocked` is sticky until the failing id is fixed or retried: that is deliberate.

## Enforcement

`scripts/check-migrations-well-formed.ts` (unique ids, `seq` increasing per owner,
no `dependsOn` cycle, known `dependsOn`). Specs on real SQLite: a failing second of
three migrations rolls back its data, records `failed` and blocks the dependent; a
refused snapshot applies nothing; a restored older snapshot converges; a
`skipped-newer` id writes nothing; the data-store provider is not returned before
migrations finish; a hold survives a restore. The in-transaction rollback spec is
red when the per-migration transaction is removed.

## Amendment M3 — addon catalogues, plan and procedure bodies

`sqlite-settings` boots first and cannot see addons, so an addon's catalogue is
**owner-driven**: the addon calls `declareOwner`, then `startMigration` and
`finishMigration` per step through `ctx.api` (`BaseAddon.runMigrations`, bound with
`defineAddonMigrations(ADDON_MIGRATIONS, ports)`; the catalogue lives in
`packages/<addon>/src/migrations/index.ts`). Same ledger, same file, same
pre-migration snapshot, same rollback; the engine orders steps across owners by
`dependsOn`.

- A `plan` body reads and returns edits (`setKeys`, `deleteKeys`, `putRow`,
  `deleteRow`); the ENGINE applies them in the same transaction as the `applied`
  row. `precondition` is `preconditionOf(canonical JSON of what the plan read)`;
  a mismatch refuses the apply. A hub-owned plan is `plan(db)`.
- `upsertRecord` / `deleteRecord` are refused by name: the records engine owns the
  derived columns (`device_id`, `at`, `expires_at`, `rev`), so a record migration is a
  procedure through the records cap.
- A `procedure` body calls the owning addon through a typed port
  (`IntegrationMigrationPorts` for the integration case: create with
  `originStableId` and keychain `secretKeys`, re-stamp children keeping `deviceId`
  and `stableId`, sibling gateway, retire the hub by tombstone). The ledger records
  the reported outcome (`done` | `already-done`); a procedure must be idempotent
  because a crash between its effect and the row reruns it.
- `onFailure: 'block-owner'` makes `runMigrations` throw, so the addon refuses to
  start; `tolerate` never throws. The hub always finishes booting.
- A failed procedure marks same-owner and cross-owner dependents `blocked`.

Known limits: a dependency on another addon's migration that has not run yet is
`blocked(dependency-pending)` until the next boot or a retry; `retry` of an
addon-owned id clears its rows and the owner reruns at its next boot (the engine
cannot call a possibly absent process); `dryRun` is hub-only; events and history
files accept plan edits only while open at declare time. `check-migrations-well-formed`
now also checks body kind against body, ownership, the manifest owner and that an
addon with a catalogue calls `runMigrations(`. Specs: `migration-m3.spec.ts` (real
SQLite; removing the transaction in the addon plan path turns the rollback spec red).
