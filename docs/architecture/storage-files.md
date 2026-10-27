---
title: The engine's database files — owned files, serving threads, placement
last-verified: 2026-10-22
applies-to:
  - packages/system/src/builtins/sqlite-storage/owned-sqlite-file.ts
  - packages/system/src/builtins/sqlite-storage/placement-router.ts
  - packages/system/src/builtins/sqlite-storage/file-host-worker.ts
covers:
  - packages/system/src/builtins/sqlite-storage/owned-sqlite-file.ts
  - packages/system/src/builtins/sqlite-storage/placement-router.ts
  - packages/system/src/builtins/sqlite-storage/placement-errors.ts
  - packages/system/src/builtins/sqlite-storage/file-host-client.ts
  - packages/system/src/builtins/sqlite-storage/file-host-handlers.ts
  - packages/system/src/builtins/sqlite-storage/file-host-protocol.ts
  - packages/system/src/builtins/sqlite-storage/file-host-worker.ts
  - packages/system/src/builtins/sqlite-storage/vector-provider.ts
  - packages/system/src/builtins/sqlite-storage/database-snapshot-provider.ts
  - scripts/migrations/2026-10-27-quantity-field-names.ts
  - scripts/migrations/quantity-field-migration.ts
  - scripts/migrations/quantity-field-stores.ts
  - scripts/migrations/quantity-field-rewrite.ts
  - scripts/migrations/quantity-field-renames.ts
  - scripts/migrations/hub-liveness.ts
---

# The engine's database files

`sqlite-settings` is the ONE relational engine behind the data door (D44). It is
one runner process, and it can own SEVERAL SQLite files, each served by its own
thread (D851):

| `DataStoreDatabase` | File (in `<dataDir>/addons-data/sqlite-settings/`) | Served by |
| --- | --- | --- |
| `settings` | `camstack.db` | the runner's main thread, exactly as before |
| `events` | `events.db` | a dedicated worker thread (sqlite-vec loadable) |
| `history` | `history.db` | a dedicated worker thread |

Today only `settings` exists on any installation: no collection names another
file, so `events.db` and `history.db` are never created. The layer is inert until
a collection asks for one (the later phases of
(planning repo: superpowers/plans/2026-10-15-lts-device-history-and-events-db.md)).

## The pieces

- **`OwnedSqliteFile`** (`owned-sqlite-file.ts`) — one object per file, owning
  what D447, D452, D679 and D693 already required per file: a serving thread, a
  WAL checkpointer, a `-shm` lock canary, the idle-gated WAL maintenance (plus
  `incremental_vacuum` on a file that was created incremental) and the owner's
  verified snapshot. `InlineOwnedFile` serves `settings` in place;
  `WorkerOwnedFile` hands the connection to a worker.
- **The worker host** (`file-host-worker.ts`, `file-host-client.ts`,
  `file-host-protocol.ts`) — the worker runs the same `SqliteSettingsBackend`
  class (and, when asked, the sqlite-vec index) over its own connection. A
  request is `{ id, kind: 'data' | 'vector' | 'control', op, input }`; the
  answer is `{ id, ok, result | error }`. A typed error keeps its class across
  the thread (`placement-errors.ts`, rebuilt by name). Vector payload buffers are
  TRANSFERRED, data rows are cloned. At most 512 calls are in flight per worker;
  past that a call is refused with `DatabaseBusyError` (logged once a minute),
  never queued. A worker that errors or exits unasked logs ONE error naming the
  database and the last op, then fails the RUNNER (`process.exit(1)` →
  `CrashSupervisor`, D5/D6); there is no in-process thread restart.
  **A thread is never forced down.** `terminate()` or `process.exit` on a live
  file-host thread segfaulted the whole process on macOS arm64 (SIGSEGV in the
  isolate's teardown GC, Node 24.17; with and without tsx, with the connection
  already closed). `stop` therefore closes the connection, answers and closes
  the port, and the client waits for the thread's own `exit`; `terminate()` is
  only the fallback after 5 s. Never add a `terminate()` to a stop path.
- **`PlacementRouter`** (`placement-router.ts`) — the `data-store-provider` the
  door sees. It maps every collection to its file.

Every log line a file produces carries `tags: { database }`. A worker has no
logger: it posts its lines and the main thread writes them through the runner's
logger under the scope `Db/<databaseId>`.

## Placement

A collection's file is declared by its owner on `declareCollection` (`database`,
absent = `settings`) and persisted in THAT file's own `_collection_declarations`.

- At boot the router opens every file that EXISTS and rebuilds
  `collection → file` from those tables. A collection declared in two files is a
  boot error naming both (`DuplicatePlacementError`) — a corrupt layout is not
  served.
- A file that does not exist is created by the FIRST declaration that names it
  (`auto_vacuum = INCREMENTAL` set before the first table). A file that exists is
  never converted at boot: changing the mode of a populated file is a full
  `VACUUM`, the ops script's job.
- `declareCollection({ database: X })` for a table that already lives in file
  `Y ≠ X` — by declaration OR merely by `sqlite_master` — throws
  `CollectionPlacementError` naming the offline split. The engine never moves a
  table (D853); the refusal turns an accidental deploy to an unconverted hub into
  a loud failure of one addon instead of a silent empty file beside the real rows.
- An undeclared collection — the canonical KV set and its
  `<addonId>:<canonical>` variants — is `settings`.
- A `transact` spans one file; ops that resolve to two are refused whole with
  `CrossDatabaseTransactError`, before anything is written.
- The retired-collection purge runs against every open file.

## Door extensions that came with it

Fixed on the door (D44), not worked around:

- `declareCollection` takes `primaryKey: string[]` (composite) and
  `withoutRowid`. A composite-keyed collection has no `id`: it is written with
  `insertMany` / `upsertMany` / `transact`, read with `query` / `count` /
  `aggregate`, trimmed with `deleteWhere`; `get` / `set` / `insert` / `upsert` /
  `update` / `delete` and a `transact` guard refuse it (`CompositeKeyError`). Its
  query records carry `id = JSON.stringify([...keyValues])`.
- `upsertMany({ conflict, records })` and a `transact` op of the same name — one
  transaction, one prepared statement. Every record of a batch names the same
  columns (a record that omitted one would bind NULL over it), and a batch that
  does not is refused whole.

## Backups: one snapshot per file

`database-snapshot` (`DatabaseSnapshotProvider`) lists EVERY file the router has
open, read at call time — a file created at runtime is listed from the moment it
opens, so no backup can leave it out (D693). `writeSnapshot({ databaseId })` copies
one file through its own connection. A second call for the same file joins the
first; different files run one after the other (the disk reserve check is per
copy). Which files an archive carries, and on which cadence: `backups.md`.

## Records (D881)

A kind declared with `database: 'events'` puts its rows in the `records` table of `events.db`; one
declared for `settings` puts them in `camstack.db`. The same worker protocol carries the calls
(`kind: 'records'`), and the table, `_record_kinds` and `_record_sequences` are created by the first
declaration that reaches the file. `history.db` never hosts records. Everything about the API, the
secret fields and the guards: [records.md](records.md).

- **A kind's file is fixed.** Each file numbers its kinds (`kind_id`) and rows (`rid`) on its own, so
  the same id routinely means two different kinds in the two files. A kind whose release declaration
  moved to the other file is refused at `declare`: the engine never moves data (D853). The offline
  rehome that moved the operator hubs' gallery and event ledgers into `events.db` was deleted with
  the rest of the records migration (D900); a future move is written, and run by hand, for that
  move.
- **A `transactFamily` lives in one file.** The gallery (`identities` + `identity-samples`,
  `vehicles` + `vehicle-samples`) and the four retrain ledgers sit in `events.db`, beside the vec
  indexes; `declare` refuses a family split across files.
- **A declaration reads no legacy table** (D900): the adoption boot guard is gone with the records
  migration.
- **The boot declares the same three tables on every role** (`pa-boot-declare.ts`):
  pipeline-analytics declares `tracks`, `media`, `object-events` and nothing else. An agent's settings store forwards to the hub (D332), so the old agent-only legacy declares
  recreated the shells ON THE HUB. A legacy table is dropped by hand, offline, on the operator's hubs
  (`DROP TABLE` plus its `_collection_declarations` row in the same file).

## Offline migrations

A change to what is STORED (a renamed field, a re-keyed row) is not migrated at
boot. It is a standalone script in `scripts/migrations/`, dated, run by hand
with the hub stopped. It never opens a live file (D679, D693, D328).

The first one is `2026-10-27-quantity-field-names.ts` (planning issue #260,
`power-meter.watts` becomes `power`, and so on; the map is
`quantity-field-renames.ts`). It covers every place a `(cap, field)` pair is
persisted, found by reading the code that writes it:

| File | Store | What names the field |
| --- | --- | --- |
| `camstack.db` | `device-runtime-state` | the cap-slice keys and the `$owned` claims (D663) |
| `camstack.db` | `addon-settings`, `addon-device-settings`, `system-settings`, `<addonId>:addon-devices` and the other scoped copies | OSD bindings (`capName`/`valuePath`), exporter and provider bindings |
| `camstack.db` | `records`, every kind | compositions, customizations, helpers, recipes, notification rules (`cap`/`fieldPath`, `kind: 'fields'`) |
| `history.db` | `device-history:metrics`, `series` | the key `cap:<cap>.<field>`; `raw` and the rollups follow the series id |

A field is rewritten only when its cap matches the map, so `battery.voltage` and
`power-meter.voltage` are different pairs. Beyond the `(cap, field)` references
above, the same rule (always the `(cap, method)`, `(cap, event)` or `(cap, field)`
context, never a bare key) also covers:

- a Customize `{ cap, targetId }`, whose target id IS the field;
- the argument keys of a stored call `{ cap, method, args }` for
  `brightness.setBrightness`, `fan-control.setPercentage`, `media-player.seek`
  and `color.setColor`, and the payload keys of a stored event
  `brightness.onBrightnessChanged`, `color.onColorChanged` and
  `battery.onStatusChanged` (the status nested under `status`);
- a `<cap>.<field>` or `cap:<cap>.<field>` text, as a value or as an object key
  (prose with whitespace is left alone);
- the provider configs keyed by field names: Home Assistant `meterEntities`,
  MQTT discovery `meter` and ESPHome `slots` / `slotUnits`, each only next to the
  sibling keys that identify its shape;
- `presence.batteryPercent`, which moved to `battery.level`: the stored runtime
  value is removed (the battery owner repopulates it), its history series moves to
  `cap:battery.level` when that device has no battery-level series and is dropped
  when it has one (counted as `moved` / `dropped`); references inside
  compositions and rules are only counted.

The `args` of a `cap` action on any other method, and free expression code, are
not rewritten; the dry run lists them as advisories. When a new-name entry already
exists the new value wins, and a history series merges point by point (the
existing point wins); both are counted.

Runbook:

1. Stop the hub and wait for it to exit. The script refuses while a process
   holds the files, while a file changed in the last 30 s, and when it cannot
   tell (`--assume-stopped` is the operator's explicit override).
2. `npx tsx scripts/migrations/2026-10-27-quantity-field-names.ts --data-dir <dir>`
   is a dry run: a per-store, per-`(cap, field)` count table, nothing written.
3. Add `--apply --backup-dir <dir>`: each file is copied (with `-wal`/`-shm`)
   and checksummed, then rewritten in one transaction. The script recounts
   inside that transaction (old keys 0, new keys equal old plus new before,
   minus merges) and runs `PRAGMA integrity_check`; any mismatch rolls the file
   back and exits 1 with the backup left in place.
4. Start the hub. A second `--apply` changes nothing.

## What is not here

- **P5 (2026-10):** `vector-store` and sqlite-vec tables (`vec_indexes`, …) are
  served from the **events** worker (`loadVectorExtension: true` on `events.db`
  only). Event ledgers declare `database: 'events'`; the operator hubs were split
  offline (P7/P8, D853) and the split tools are gone (D900) — a hub on the old
  layout refuses mismatched placement with `CollectionPlacementError`.
- There is no migration code anywhere (D853).

## A deleted device's data (D865)

`history.db`, the recorder's footage index (`recorder:segment-hours`) and the
analytics collections hold data keyed by device id. When a device is deleted, the
owners remove it through the `device-removal-hook` capability (tombstone-driven, see
`device-model.md`): the recorder evicts the camera's segments through the segment store
(audit reason `orphaned-device`), pipeline-analytics runs its event and track cascades,
device-history deletes the series. Per-device settings do not belong in a collection of
their own: they live in `addon-device-settings` (one row per field, for every process,
D870) and are cleared centrally (`scripts/check-device-settings-standard.ts`). The
per-camera state the broker and the notification centre kept in side collections
(`probeSnapshots`, `brokerProfile`, `rtspTokens`, `notificationMuted`) is a key of that
store too. One table per kind of setting, for every process: per-device
`addon-device-settings`, addon-level `addon-settings` (`<addonId>.<field>`), sections in
`system-settings`; the per-addon scoped blob tables (`<addonId>:addon-settings`,
`:addon-devices`, `:sections`) are retired and dropped on the operator hubs; the one-shot
migration that moved and dropped them was deleted on 2026-10-22.
`storageAdmin.listTables` lists tables (rows, bytes, owner) without creating any, and a
read of an unwritten scoped table answers absent. Modules:
`kernel/device-settings-store.ts`, `addon-settings-store.ts`, `sections-store.ts`.

## What the census found, and where each table stands (D871)

- **`notification-center:*` device rows** (liveness, device alerts, system state, snooze
  counters, occupancy, track groups, artifact index) are removed by the notification
  centre's share of the `device-removal-hook`, tombstone-driven. Rows of devices deleted
  before tombstones were pruned once by an operator script (D871; deleted with D900, the
  table is a records kind now). Node rows stay.
- **`pipeline-analytics:stats-5m-v2` / `pipeline-orchestrator:stats-5m-v2`** are the
  composite-key, `WITHOUT ROWID` successors of `stats-5m`: the four key columns ARE the
  key (no TEXT `id`, so no autoindex), written with `upsertMany`. A key cannot change in
  place, so the old tables were copied once by an operator script and dropped by hand on the
  operator hubs (D871; the script left with D900). Read plan proved in
  `lts-composite-key-over-real-sqlite.spec.ts`.
- **`vec_object_clip`** (MobileCLIP) was declared and read by nothing; it was dropped by hand
  on the operator hubs (D871).
- **`device-manager:tombstones`** is declared at device-manager init, not by the first
  delete.
- **`cluster-node-history`, `oauth_sessions`, `backup_schedules`,
  `backup_destination_policies`, `backup_seed_markers`** are records kinds only (D902): their
  settings-store fallbacks are gone, so no boot path can `declareCollection` them again. A
  `cluster-node-history` table a hub re-created in the boot window before D902 holds stale
  snapshots only and is dropped by hand offline. **`device-runtime-state`** stays a canonical
  key/value collection of the settings door (with `system-settings`, `addon-settings`,
  `addon-device-settings`).
- **`pipeline-analytics:ops-log`** gets one retention row per sweep, per-device counts in
  `detail` (see `post-analysis.md`).

## Traps

- **A worker needs its built entry.** `dist/file-host-worker.js` is a top-level
  entry of `packages/system` (`vite.config.ts`), found through the package's own
  `exports["./package.json"]` like the checkpoint and snapshot workers. A spec
  points the host at the TypeScript source with `--import tsx`.
- **The guard sees the new files.** `scripts/check-sqlite-files-not-opened-by-fs.ts`
  matches by suffix and identifier (`events.db`, `historyDbPath`), and the worker
  reaches the driver only through the backend class — it is not a connection file.
