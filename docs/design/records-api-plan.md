# `records`: a third storage API, and 157 tables brought down to 17

Status: approved plan (operator, 2026-10-18; decisions at the end). Analysis date: 2026-10-18.
**Closed 2026-10-22:** migration complete on both operator hubs; the migration-only APIs and
scripts are deleted ([D900](../decisions/adr-0900-the-records-migration-is-closed-no-kind-adopts-and-the-product-carries-no-adoption-code.md) — `dropCollection` and the D870 drop list stay, see its Consequences).
Built: phases 0 and 1 ([D881](../decisions/adr-0881-records-are-the-third-storage-api-and-a-secret-field-is-a-feature-of-the-kind.md), [records.md](../architecture/records.md)); deviations are listed there.
Base: `main` = deployed 1.2.587. Live inventory: `storageAdmin.listTables` on the
production hub (`https://<hub-ip>:4443`), 157 tables, 1 187 MiB in `camstack.db`.
Inputs: `AGENTS.md` (D3, D8/D11, D49, D447, D613, D679/D693, D865, no boot purges),
`docs/architecture/storage-files.md`, `docs/reference/storage.md` (§3a classes,
write triggers, retention), D850 (device-history), D851/D852 (per-file threads,
events.db), D853 (no migration code in the product), D870, D871, the D872 decisions
(memory note of 2026-10-17: a manifest per package, storage creates the tables,
orphans dropped after 14 days, System → Data), and
(planning repo: superpowers/plans/2026-10-15-lts-device-history-and-events-db.md).

Every performance claim in §0 and §2 was measured on the SQLite build the hub ships
(better-sqlite3 12.8 → **SQLite 3.53.2**). The scripts are in this scratchpad's
`exp/` folder (`eqp.cjs`, `tracks.cjs`, `cover.cjs`).

---

## 0. The operator's questions, answered first

**"Do none of these need their own tables to query?"** Some do. Of the 120
relational tables (157 minus 37 sqlite-vec tables), **7 must stay their own table**,
and an 8th (`object-events`) is a measured borderline. The reasons are specific to
those tables, not general:

| Stays | Why a JSON blob does not work there |
| --- | --- |
| `pipeline-analytics:tracks` | Heavy rows (226 MB / 129 k rows ≈ 1.75 KB; `positions` and `snapshots` are most of it), 45 columns, the cascade root of retention, a "slim" projection that skips the heavy columns, and whole-table scans (`retrainStatus`, `favourited`, `benchPinned` across every device; per-class statistics). Measured: an unindexed aggregate over JSON rows is **5.4× slower** (694 ms vs 129 ms over 130 k rows, warm cache), because a JSON field cannot be read without loading the whole blob, overflow pages included. A column can. |
| `pipeline-analytics:media` | 1.02 M rows, 8 indexes, a UNIQUE slot constraint, and **scheduled** `SUM(sizeBytes)` per location, device and kind (storage occupancy and eviction). That is exactly D447: on the synchronous settings thread, a scheduled aggregate has to be served from an index. Expression indexes can do it (see below), but eight partial expression indexes over a million rows in a shared table is the place where one silently mismatched expression turns into a full scan. Its cost grows with the row count. |
| `recorder:segment-hours` | "The four aggregate columns are what this table IS" (D523): `SUM(bytes)`, `SUM(segments)`, `MIN/MAX` per location from a covering accounting index, plus an hour-row upsert on every finalized segment. That read decides how much footage exists, and it runs on a schedule (D447, D148). |
| `keychain:secrets`, `keychain:keys` | The root of every secret. They must never be reachable by generic tooling: not by the D872 automatic orphan drop, not by `dropCollection`, not by a generic `deleteWhere`. Losing `keys` with `secrets` intact makes every value undecryptable. A security root does not share a B-tree with 60 other kinds. |
| `device-manager:devices` | The identity directory. Every process looks devices up by primary key with no cache, it has 4 secondary keys (`addonId+stableId`, `integrationId`, `parentDeviceId`, `type`), integer id allocation, and a cascade when an integration is deleted. Moving it gains one table and risks every device. |
| sqlite-vec indexes (3 vec0 tables + `vec_indexes`) | They are virtual tables with their own 12 shadow tables each. A JSON column cannot hold a KNN index. |
| *(borderline)* `pipeline-analytics:object-events` | Technically fits `records` (§2). It stays its own table until an N100 measurement of insert cost with two expression indexes says otherwise (Phase 7). |

The settings layer (`system-settings`, `addon-settings`, `addon-device-settings`,
`device-runtime-state`) is a separate API by the operator's decision (D870), and
`_collection_declarations` is the engine's own catalog. Neither belongs to `records`.

**"Would a JSON blob be blocking?"** Not for the access patterns that more than 90%
of these tables have. Measured on 3.53.2:

1. **Lookups by key, by device, and by device + time range cost the same as real
   columns**, because `device_id` and `at` ARE real columns in `records`. The newest
   50 motion events of a device over 900 k rows take 0.09 ms
   (`SEARCH records USING INDEX rec_dev_at`). The density histogram and the
   retention count use a **COVERING** index and never touch JSON.
2. **A lookup or aggregate on a JSON field is as fast as a real column when it has a
   partial expression index.** By `trackId`: 0.02 ms. `SUM(sizeBytes)` per
   location over 300 k media rows: 2.47 ms with the expression index, against
   2.01 ms on a dedicated table and **79.4 ms without the index**. The VDBE program
   for `SUM(data->>'$.bytes') … WHERE data->>'$.loc' = ?` is
   `SeekGE → DeferredSeek → Column(cursor=index)`: the table row is never read, so
   the index is effectively covering (SQLite's indexed-expression optimization,
   ≥ 3.41). **Trap:** `EXPLAIN QUERY PLAN` still prints `USING INDEX`, not
   `USING COVERING INDEX`. A D447 proof for a records aggregate must therefore
   inspect the opcodes (no `Column` on the table cursor), not the plan text.
3. **Where JSON does cost:** (a) unindexed scans and aggregates (5.4× on heavy rows,
   ~30× on narrow rows when the alternative is an index); (b) projection: no
   "slim" read of a heavy row; (c) bytes: JSON repeats the keys in every row, which
   is +100–150 B per narrow row (≈ +100 MB if `media` moved); (d) a field that an
   expression index does not match **character for character** is silently a full
   scan. The backend's own comment on `share_view_tokens` already records that
   failure once.

The design turns (d) from a hazard into a refusal: `records.query` accepts
predicates **only on declared index fields**, and the predicate and the index are
rendered by the same function. An unindexed filter does not compile. That keeps
D447 true by construction, and it is the reason the tables in the "stays" list
stay: they need ad-hoc filters, scans or projections that a records kind would refuse.

---

## 1. The `records` API

### 1.1 Where it sits

Three APIs over the same door (D44), one per kind of data:

| API | Holds | Table(s) |
| --- | --- | --- |
| `ctx.settings.*` (D870) | operator intent: per-device, addon-level, sections | `addon-device-settings`, `addon-settings`, `system-settings` |
| `ctx.records` (new) | an addon's own facts and documents: ledgers, audit rows, config documents, mirrors | `records` (one schema, one physical table per database file that hosts kinds: `camstack.db`, `events.db`) |
| device-history (D850) | numeric series over time, with rollups | `history.db` (its own data model) |

Plus the tables that stay their own (§3), which keep `declareCollection`.

The rule that sends data to one of them:

- A number over time (something you would chart): **device-history**. Never records.
- A fact or a document with an id, read by key, by device, or by device + time:
  **records**.
- A relational ledger with scans, heavy projections, scheduled aggregates over more
  than ~100 k rows, or more than 2 secondary keys: **its own table**.
- Bytes (any size): files plus `ctx.peerBytes` (D613). Never a record field.

### 1.2 Physical schema (one per database file)

```sql
CREATE TABLE records (
  rid        INTEGER PRIMARY KEY,      -- internal rowid; never leaves the engine
  kind_id    INTEGER NOT NULL,         -- → _record_kinds.kind_id  (owner + kind)
  id         TEXT    NOT NULL,         -- caller's key, unique within the kind
  device_id  INTEGER,                  -- D865 removal + per-device reads; NULL = not device-scoped
  at         INTEGER,                  -- the domain clock (ms): observed/created/opened
  expires_at INTEGER,                  -- engine TTL; NULL = none
  rev        INTEGER NOT NULL DEFAULT 1,  -- bumped on every write (CAS)
  updated_at INTEGER NOT NULL,         -- wall clock of the last write
  data       BLOB    NOT NULL,         -- JSONB (SQLite ≥ 3.45)
  UNIQUE (kind_id, id)
);
CREATE INDEX records_kind_device_at ON records(kind_id, device_id, at);
CREATE INDEX records_kind_at        ON records(kind_id, at);
CREATE INDEX records_expires        ON records(expires_at) WHERE expires_at IS NOT NULL;

-- per kind, from the manifest, created by storage at install/update (never at runtime):
CREATE [UNIQUE] INDEX rx_<kindId>_<name> ON records(<json exprs…>) WHERE kind_id = <literal>;

-- engine catalog (inside the existing declarations catalog, or a sibling table):
CREATE TABLE _record_kinds (
  kind_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
  database TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  state TEXT NOT NULL,          -- declared | orphaned | dropped (D872 lifecycle)
  orphaned_at INTEGER, UNIQUE(owner, kind)
);
```

Choices, with their reasons:

- **`kind_id INTEGER`, not `(owner TEXT, kind TEXT)`.** Measured: the text-prefixed
  `(owner, kind, device_id, at)` index cost 76 MiB for 900 k rows (≈ 85 B/entry).
  The integer version cost 4.0 MiB for 130 k rows (≈ 31 B/entry). Owner and kind
  are still the public identity; the integer is internal.
- **A rowid table with `UNIQUE(kind_id, id)`, not `WITHOUT ROWID`.** Rows can be up
  to the kind's `maxDataBytes`, and SQLite advises against WITHOUT ROWID for large rows.
- **`kind_id` is compiled as a LITERAL**, never a bound parameter (it is an integer
  from the engine's own catalog, so this is not injectable). That is what lets the
  planner prove a partial index `WHERE kind_id = 17` is usable. In the experiment
  the bound version also worked, but only because a bound EXPLAIN re-plans; a
  statement cached before binding would not be able to.
- **JSONB storage**: `data->>'$.f'` reads a JSONB value without a text re-parse. The
  door keeps answering plain JSON objects.
- **The JSON expressions** for the partial indexes and for the predicates come from
  ONE function, the existing `fieldExprFor` (§0, point d).

### 1.3 Operations (`ctx.records`, also on the door for runners)

All calls are scoped to the caller's own kinds (§1.6). Every result is three-way in
the D870 sense: present / absent / the call THROWS. A failed read is never `[]` or
`undefined`.

| Op | Semantics |
| --- | --- |
| `get(kind, id)` / `getMany(kind, ids ≤ 1000)` | primary-key read |
| `put(kind, { id, deviceId?, at?, expiresAt?, data }, { ifRev? })` | upsert; returns `{ rev }`. `ifRev` gives compare-and-set: a mismatch throws `RevConflictError`, it does not overwrite |
| `putMany(kind, records ≤ 1000, ≤ 4 MiB)` | one transaction, one prepared statement (as `upsertMany`) |
| `patch(kind, id, partial, { ifRev? })` | `UPDATE … SET data = json_patch(data, ?)` in ONE statement (RFC 7396: `null` removes a field). A merge never reads, so two writers patching different fields cannot lose each other's write (the D870 rule) |
| `delete(kind, id)` / `deleteMany(kind, ids)` | |
| `query(kind, { deviceId?, atFrom?, atTo?, where?, order?, limit ≤ 1000, cursor? })` | `where` names **declared index fields only**. `order` is `at` (default), `id`, or a declared index. A keyset `cursor` (opaque: `(at, rid)`) replaces `offset`. Answers `{ records, nextCursor }` |
| `count(kind, filter)` · `histogram(kind, { deviceId?, from, to, bucketMs })` · `aggregate(kind, { sum/min/max: indexedField, groupBy?: indexedField })` | index-served only. The engine refuses at compile time any aggregate it cannot serve from `records_kind_*` or from a declared index (the D447 rule, enforced instead of described) |
| `deleteWhere(kind, { deviceId?, atBefore?, where? })` | batched (5 000 rows per statement, yields between batches, so the serving thread is not held); answers `{ deleted }` |
| `deleteDevice(deviceId, { kinds? })` | every kind of the caller declared `deviceRemoval: 'delete'`, one transaction per kind; the D865 hook body |
| `transact(ops[])` | atomic over the caller's kinds **in one file** (`CrossDatabaseTransactError` across files, as today) |
| `allocateId(kind)` | a monotonically increasing integer sequence per kind (replaces `int_NNNN` "resume from the highest" and similar counters) |

There is no `scan`, no `offset`, no unindexed `where`, no raw SQL.

### 1.4 Concurrency and atomicity

- One serving thread per file (D851) serialises every statement, so each op is atomic.
- Read-modify-write goes through `ifRev`. `patch` covers the common case and needs no read.
- Multi-record invariants (an identity and its samples; a retrain collection and
  its frames) go through `transact`. A family whose rows must agree lives in ONE
  file; the manifest refuses a `transactFamily` that spans two.
- Writers from agents reach the hub through the door like every settings write
  today. Records exist only on the hub: no persistence on agents (operator rule).

### 1.5 Size limits

- `data` ≤ 64 KiB by default. A kind may declare `maxDataBytes` up to 1 MiB; the
  engine refuses anything larger with `RecordTooLargeError` (named, logged once per
  minute per kind). Bytes are never record fields: files plus `ctx.peerBytes` (D613).
- Batches ≤ 1 000 records and ≤ 4 MiB.
- Row bounds are declared per kind (`maxRows`, `maxRowsPerDevice`). The engine trims
  them on write through the `(kind_id, [device_id,] at)` index: oldest `at` first,
  ties broken by `rid`. That replaces 8 hand-written rings (track-groups,
  recorder ops-log, benchmark runs, track-purity/relations, debug-note-archive,
  keychain audit, birth-decision ledger…).

### 1.6 Declaration (D872 manifest) and access

Each package declares its kinds in `src/storage.ts` (`defineStorage`), built into
`dist/storage.json`, next to its tables:

```ts
export default defineStorage({
  records: {
    'motion-event': {
      database: 'events',
      class: 'ledger',                       // replaces the @durable annotation (one authority)
      writeTrigger: 'one row per motion EPISODE, keyed per (deviceId, source)',
      device: 'required', at: 'required',
      indexes: [],                           // (kind, device, at) is built in
      retention: { owner: 'device-window', reason: 'swept with the track window (D61)' },
      deviceRemoval: 'delete',
      maxDataBytes: 4096,
    },
    'object-event': { /* … */ indexes: [{ name: 'track', fields: ['trackId'] }, { name: 'frame', fields: ['frameId'] }] },
    'api-key': { database: 'settings', class: 'config', indexes: [{ name: 'prefix', fields: ['tokenPrefix'], unique: true }], retention: { none: 'explicit revoke only' } },
  },
})
```

- **Only `sqlite-storage` creates anything** (D872): the reconciler, at
  install/update and before the runner spawns, inserts the `_record_kinds` row and
  creates the partial indexes. Changes are additive only: a changed index is a new
  name, and the old one becomes orphaned. Anything else refuses the update (D853).
  No DDL at runtime, ever.
- **Owner = the transport-stamped `callerAddonId`** (as device-history's
  `not-owner`), never a field in the input. A kind is readable and writable only by
  its owner, from any process or node of that addon. Other addons go through the
  owner's capability (addons never import each other). This delivers on day one the
  "owner-only writes" that D872 deferred, and adds owner-only reads.
- **Admin**: `storageAdmin.listKinds` (rows, bytes estimate, class, retention,
  state) for System → Data, and `storageAdmin.readRecords` (admin tier, audited,
  read-only) for diagnosis. The migration op `storageAdmin.adoptRecords` is in §4.
- **Orphans (D872)**: a kind declared by no installed package version becomes
  `orphaned` (the same registry rules as tables: hub + every node roster + system
  manifest; abort on an empty or unreadable registry, D49). It is dropped after 14
  days and ≥ 3 passes with a verified `database-snapshot` < 24 h:
  `DELETE … WHERE kind_id = ?` in batches, then its `rx_` indexes, then the
  catalog row. The job is scheduled and audited, never on the boot path.
  **Keychain kinds are excluded** from the automatic drop (their tables are not in
  `records` anyway; the same exclusion applies to the auth kinds, which go only
  under operator review).

### 1.7 Retention per kind

Declared, one of:

| Form | Engine behaviour | Used by |
| --- | --- | --- |
| `{ ttlMs, from: 'at' \| 'write' }` | sets `expires_at` on write. A scheduled sweep (every 10 min, off boot, batched) deletes `expires_at < now` | ai usage 90 d, auth audit 90 d, tombstones 90 d, ops-log 30 d, artifacts (the producer sets `expiresAt`) |
| `{ maxRows }` / `{ maxRowsPerDevice }` | trim on write | rings |
| `{ owner: '<name>', reason }` | the engine does nothing. The owner sweeps with `deleteWhere` on its own clock | motion/audio/sensor events (the device window, an operator setting the engine cannot see), DurableLedger `pruneExcept` |
| `{ none: '<reason>' }` | never pruned; the reason is shown in System → Data | config, identity samples |

The engine TTL is clock-based only. It never prunes against a read of another
authority (D49/D130). A kind whose bound depends on another fact keeps the owner sweep.

### 1.8 Events

**None.** A records write emits nothing. Events are telemetry and may be dropped
(D8/D11), and a consumer that needs a record must read it through the owner's
capability. An owner that wants to announce a change emits its own domain event
through `ctx.eventBus`, exactly as today. System → Data polls `listKinds`. The
query profiler already logs slow statements per collection, and it is extended to
tag `kind`.

### 1.9 Relation to `history.db` and to vec0

- **history.db (device-history)** stays the only home of numeric series (D850). The
  four series tables in `camstack.db` (`pipeline-analytics:stats-5m-v2`,
  `pipeline-orchestrator:stats-5m-v2`, `metrics:node-load-samples`,
  `metrics:node-memory-samples`; 80 MiB, 1.5 M rows) go there (LTS plan P4), **not**
  to records. Audio *level* rows also leave `audio-events` for a series in P4. That
  happens before audio-events moves to records, and it shrinks 2.1 M rows to the
  classification rows only.
- **vec0** stays: the vectors live in `vec_*`, keyed by the owning row's id (face
  id, track id). When the owner is a records kind, the vector key is the record
  `id`, and the vector index declares its `sourceKind` in the manifest. The D865
  hook and the orphan job then delete vectors with their records. Today that
  coupling lives only in code.
- **events.db (D852)**: the records table of `events.db` is the same schema. A
  kind's `database` decides its file. High-volume kinds MUST be in `events.db`:
  a 2 M-row retention delete on the `settings` thread is the D447 failure in another form.

---

## 2. Every current table and its verdict

Legend: **R** = `records` kind (JSON fine, built-in indexes only) · **R+x** =
`records` with named partial expression index(es) · **S** = stays its own table ·
**H** = moves to device-history (`history.db`) · **D** = drop (dead) · **K** = stays
in the settings layer / engine (not records). Rows and size are live (2026-10-18).
"Hot queries" come from the store code (`where`/`orderBy`/index names).
Write rates are **estimates** from rows ÷ retention window, flagged `~`.

### 2.1 Engine and settings layer (9 tables)

| Table | Rows / size | Hot queries | Verdict |
| --- | --- | --- | --- |
| `_collection_declarations` | 112 / 36 K | boot rebuild of collection → file | **K** (engine catalog; gains `_record_kinds`) |
| `system-settings` | 29 / 4 K | key get, prefix range | **K** (D870 sections) |
| `addon-settings` | 178 / 84 K | `<addonId>.<field>` prefix range | **K** (D870) |
| `addon-device-settings` | 6 271 / 1.7 M | `<addonId>:<deviceId>.` prefix range, `readDeviceStoreBatch` | **K** (D870) |
| `device-runtime-state` | 1 084 / 372 K | key get per device (runtimeState), liveness reads | **K** for now (read by every runner's generic door view; a records kind later, §5) |
| `addon-devices` | 0 | none (retired by D870) | **D** |
| `sections` | 0 | none (sections live in `system-settings`, D870) | **D** (and remove it from `CANONICAL_KV_COLLECTIONS`) |
| `provider-settings` | 0 | named only in the canonical list and the `SettingsCollection` type | **D** (remove from both) |
| `device-settings` | 0 | same | **D** (remove from both) |

### 2.2 Vector indexes (37 physical tables)

| Table(s) | Rows / size | Verdict |
| --- | --- | --- |
| `vec_object_clip_siglip2_b16_224` + 11 shadow tables | 105 664 vectors / ~411 MB | **S** (vec0) |
| `vec_face_arcface` + 11 shadow tables | 3 248 / ~40 MB | **S** (vec0) |
| `vec_identity_arcface` + 11 shadow tables | 826 / ~2.4 MB | **S** (vec0) |
| `vec_indexes` | 4 rows / 4 K | **S** (registry). 4 rows for 3 live indexes: check whether the 4th is the retired `vec_object_clip` (D871) and remove that row with its drop |

### 2.3 pipeline-analytics: the hot ledgers (events.db candidates)

| Table | Rows / size | Hot queries (from the store) | Write rate | Verdict |
| --- | --- | --- | --- | --- |
| `:tracks` | 129 473 / 226 MB | `deviceId + firstSeen` desc list with `whereBetween`, `whereJsonArrayAny(classes)`, `whereNot(closedReason)`, source filter, zone envelope (`envMinX/MaxX/MinY/MaxY` ranges); `deviceId + lastSeen` sweep; fleet scans `retrainStatus`/`favourited`/`benchPinned`; slim projection | ~18 k/day | **S**: heavy rows, 45 columns, projection, scans (5.4× measured), cascade root |
| `:media` | 1 023 465 / 192 MB | `(ownerKind, ownerId, kind)`, `(deviceId, ownerKind, kind) + timestamp`, `whereIn ownerId` chunks, `locationId` / `locationId IS NULL`, scheduled `SUM(sizeBytes)` by device / location / kind, UNIQUE slot | ~100 k/day | **S**: 8 indexes, unique slot, scheduled aggregates over 1 M rows (D447) |
| `:object-events` | 320 640 / 68 MB | `deviceId + timestamp` range and histogram; `trackId` (cascade `deleteByTracks`, fusion rewrite absorbed → survivor); `frameId` | ~46 k/day, per frame | **S (borderline)**. Fits R+x (`track`: `trackId`; `frame`: `frameId`), and the fusion rewrite becomes `UPDATE … json_set(…) WHERE rx_track = ?`. Kept until Phase 7 measures the insert cost on the N100 |
| `:motion-events` | 358 029 / 50 MB | `deviceId + timestamp` desc list, histogram, `evictTracklessBefore(deviceId, cutoff)`, `countByDevice` | ~12–50 k/day | **R** (events): all served by `records_kind_device_at`, covering for the count, histogram and retention (measured 0.09–0.46 ms at 900 k rows) |
| `:audio-events` | 2 170 373 / 100 MB | same as motion | 83 k/day (D871) | **R** (events), **after** LTS P4 moves level rows to a series |
| `:sensor-events` | 1 488 / 192 K | `deviceId + timestamp` | low | **R** (events) |
| `:faces` | 3 248 / 1.3 M | `deviceId + timestamp`, `trackId`, `assigned + timestamp`, `recognizedIdentityId + timestamp`, `whereIn deviceIds` | ~1 per face track | **R+x** (events): `track` (`trackId`), `assigned` (`assigned`), `identity` (`recognizedIdentityId`); id `face-<trackId>` kept; vectors keyed by it |
| `:plates` | 61 / 20 K | `trackId`, `recognizedVehicleId + timestamp`, `deviceId + timestamp` | rare | **R+x** (events): `track`, `vehicle` |
| `:identity-samples` | 826 / 172 K | `identityId`, prune by `(identityId, …)`, `source` | operator | **R+x** (events): `identity`; retention `none` (exempt); `transact` family with identities |
| `:vehicle-samples` | 0 | `vehicleId` | operator | **R+x** (events): `vehicle` |
| `:track-aliases` | 24 074 / 1 MB | pk `aliasId`, `trackId` (cascade) | per fusion | **R+x** (events): `track` |
| `:track-purity` | 0 | pk, `deviceId + updatedAt`, `updatedAt` ring 5 000 | operator | **R** (events), `at = updatedAt`, `maxRows: 5000` |
| `:track-relations` | 1 | same | operator | **R** (events), `maxRows` |
| `:tracking-tapes` | 2 | pk, `deviceId + createdAt` | operator | **R** (events) |
| `:birth-decision-ledger` | 30 012 / 3.9 MB | `at` range, `deviceId + at` | per track birth, row-capped | **R** (events), `maxRows` |
| `:debug-note-archive` | 5 | pk, row cap | review | **R** (events), `maxRows` |
| `:ops-log` | 102 016 / 17.6 MB | `at` range, `deviceId + at`, `pruneBefore(now − 30 d)` | ~1 per pass after D871 | **R** (events), `ttlMs: 30 d` |
| `:retrain-frames` | 91 / 20 K | `trackId`, `deviceId + complete`, `copiedAt`, location | operator | **R+x** (events): `track`, `complete`, `location` |
| `:retrain-annotations` | 147 / 72 K | `mediaKey`, `trackId`, `deviceId + createdAt` | operator | **R+x** (events): `media`, `track` |
| `:retrain-collections` | 3 | UNIQUE `nameKey`, `createdAt` | operator | **R+x** (events): `name` UNIQUE |
| `:retrain-collection-frames` | 88 | `collectionId`, frame | operator | **R+x** (events): `collection`, `frame`; one `transact` family with the three above |
| `:retrain-dataset-versions` | 0, undeclared | no code reference | – | **D** |
| `:sweep-cursors` | 1 | pk | per pass | **R** (events, next to the rows it describes) |
| `:migrations` | 2 | pk | once | **R** (events) |
| `:face-rescore-state` | 1 | pk | rare | **R** (events) |
| `:stats-5m-v2` | 1 089 184 / 54 MB | `(subject, series, scope, bucket)` composite range | 1 per bucket | **H** (LTS P4, D850) |

### 2.4 pipeline-analytics: live-state ledgers and config (settings file)

All of these are DurableLedger-style: the mirror is the read surface (load all rows
of the kind at boot, by device), writes are write-through or write-behind, and
`pruneExcept` comes from an authoritative set. A records kind is exactly that
storage half. `query(kind, { deviceId })` plus `put`/`delete`, and
`deleteWhere(kind, { where: { id NOT IN } })` becomes a `deleteMany` of the
computed complement.

| Table | Rows / size | Verdict |
| --- | --- | --- |
| `:phantom-cells` | 5 288 / 612 K | **R**, `device: required`, `maxRowsPerDevice` (the device cap is already declared) |
| `:package-background` | 4 | **R** |
| `:stationary-evidence` | 693 / 232 K | **R**, `maxRowsPerDevice: 512`; owner sweep for the 6 h idle rule |
| `:stationary-objects` | 8 | **R** |
| `:scene-latch` | 0 | **R** |
| `:scenes` | 0 | **R** (config) |
| `:identities` | 6 | **R** (config; settings file per the LTS plan. NOTE: then identities and samples are in DIFFERENT files, so `deleteIdentity` cannot be one transaction. Either keep both in `events` (recommended: they are one family) or accept a two-step delete with samples first, as today) |
| `:vehicles` | 0 | **R** (same family remark) |
| `:viewer-settings-snapshots` | 1 | **R+x**: `user` (`userId`) |
| `viewer-settings-snapshots` (bare, legacy) | 0 | **D** (drained, D-adoption done) |

### 2.5 notification-center (20 tables, all in the pipeline-analytics runner)

| Table | Rows / size | Hot queries | Verdict |
| --- | --- | --- | --- |
| `:outbox` | 583 / 680 K | drain tick `status + nextAttemptAt`, history `createdAt` desc, sweep `createdAt < cutoff` | **R+x** (events, it is notification history): `due` (`status`, `nextAttemptAt`); `at = createdAt` gives the history range for free |
| `:artifacts` | 737 / 496 K | `ruleId`, `capturedAt` order, `expiresAt` range, kind, device | **R+x** (events): `rule` (`ruleId`), `kind`; `at = capturedAt`, `expires_at` real column |
| `:track-groups` | 0 | `deviceId + openedAt`, `sealed = false`, rule | **R+x** (events): `open` (`sealed`), `rule`; `maxRowsPerDevice` |
| `:snooze-suppressed` | 0 | `snoozeId` | **R+x** (events): `snooze` |
| `:snoozes` | 0 | `expiresAt` | **R**, `expires_at` (but note: pruned 6 h after CLOSE, so the owner sets `expiresAt = closedAt + 6 h`) |
| `:liveness` | 1 998 / 112 K | mirror load; `deleteWhere(deviceId)` (D871) | **R**, `deviceRemoval: delete` |
| `:device-alerts` | 86 | mirror; device delete | **R**, `deviceRemoval: delete` |
| `:system-state` | 21 | mirror | **R** |
| `:occupancy` | 1 | mirror; `pruneExcept` | **R** |
| `:device-prunes` | 1 | pk | **R** |
| `:state-summary-stamps` | 2 | pk | **R** |
| `:meta` | 1 | pk `watermark` | **R** |
| `:rules` | 19 / 20 K | list all | **R** (config) |
| `:rule-ai` | 0 | pk = rule | **R** |
| `:summary-rules` | 1 | list | **R** |
| `:timelapse-rules` | 3 | list | **R** |
| `:calendar-events-rules` | 1 | list | **R** |
| `:sequences` | 0 | pk | **R** |
| `:texts` | 1 | pk `texts` | **R** |
| `notifiers:notification-targets` | 5 | list, pk | **R** (owner `notifiers`) |
| `provider-homeassistant:ha-notification-targets` | 0 | list, pk | **R** (owner `provider-homeassistant`) |

### 2.6 pipeline-orchestrator, recorder, training, benchmark

| Table | Rows / size | Hot queries | Verdict |
| --- | --- | --- | --- |
| `pipeline-orchestrator:node-benchmark-mode` | 0 | pk `active` | **R** |
| `:node-benchmark-runs` | 8 | newest 50 | **R**, `maxRows: 50` |
| `:node-benchmarks` | 21 | newest 500 | **R**, `maxRows: 500` |
| `:node-stress-moves` | 0 | `at` window 2 h | **R**, `ttlMs: 2 h` |
| `:stats-5m-v2` | 217 540 / 14 MB | composite range | **H** |
| `recorder:exports` | 136 / 168 K | pk, list by `createdAt`, state | **R** (`at = createdAt`) |
| `recorder:ops-log` | 502 / 208 K | ring 500 on `at` | **R**, `maxRows: 500` |
| `recorder:segment-hours` | 14 993 / 2.9 MB | covering accounting `SUM/MIN/MAX` per location (D523), `deviceId`, `hourStartMs`, `(location, hour)`; per-segment hour upsert | **S** |
| `training:jobs` | 0 | UNIQUE `idempotencyKey`, `createdAt` | **R+x**: `idem` UNIQUE |
| `training:dataset-versions` | 1, undeclared | no code reference | **D** (read the one row first; operator review) |
| `benchmark:replay-runs` | 0, undeclared | no code reference | **D** |

### 2.7 system builtins and server/backend (hub-main)

| Table | Rows / size | Hot queries | Verdict |
| --- | --- | --- | --- |
| `device-manager:devices` | 1 083 / 496 K | pk per device (no cache), `addonId + stableId`, `addonId`, `integrationId`, `parentDeviceId`, fleet `orderBy deviceId` | **S** (identity directory) |
| `device-manager:tombstones` | 0 | `deletedAt` range | **R**, `ttlMs: 90 d`, `at = deletedAt` |
| `cluster-node-history` | 4 | pk, read-back gate | **R** |
| `integrations` | 15 | pk, `addon_id`, list by id | **R+x**: `addon`; `allocateId` replaces "resume the `int_NNNN` counter from the highest" |
| `integration_settings` | 10 | `(integration_id, key)`, `integration_id` cascade | **R+x**: `integration`; id `<integrationId>.<key>` (or fold into the integration record's `data`, since it is 10 rows) |
| `core_blocks` | 4 / 184 K | list, `enabled` | **R** (`maxDataBytes` 256 K: a compiled block is ~46 K) |
| `core-blocks:settings` | 2 | pk per block | **R** |
| `calendars:user-prefs` | 1 | pk per user | **R** |
| `storage_locations` | 7 | pk, `type` | **R** (`storage-location-mode.ts` stays the only reader of `mode`, D385) |
| `storage_drain_state` | 0 | pk = location | **R** |
| `backup_schedules` | 3 | pk, list | **R** |
| `backup_destination_policies` | 2 | pk = location | **R** |
| `backup_seed_markers` | 1 | pk = seed | **R** |
| `backup_encryption_keys` | 0, undeclared this boot | pk = keyId | **R** (metadata only. Verify that no key material is stored raw; if it is, it moves to the keychain first) |
| `alerts` (canonical KV) | 500 / 312 K | list, prune by expiry/overflow (`prune-policy.ts`) | **R**, `ttlMs` + `maxRows` |
| `metrics:node-load-samples` | 225 563 / 13 MB | `nodeId + atMs` range, 6 h | **H** (D850) |
| `metrics:node-memory-samples` | 6 476 / 332 K | `nodeId + atMs` | **H** |
| `ai:llm-profiles` | 3 | list, pk | **R**. **The rows hold the `apiKey` RAW** (reference §3a): move it to a keychain marker (`secretStatePaths` equivalent) in the same piece of work |
| `ai:llm-defaults` | 2 | pk = selector | **R** |
| `ai:llm-meta` | 1 | pk | **R** |
| `ai:usage` | 2 225 / 296 K | 90-day prune, list | **R**, `ttlMs: 90 d` |
| `ai:chats` | 0 | per user | **R+x**: `user` |
| `ai:budgets` | 0 | NOTHING writes it | **D** (remove the declaration) |
| `keychain:secrets` | 101 / 60 K | pk `ref`, `owner` index | **S** (security root) |
| `keychain:keys` | 1 | pk `wrapId` | **S** (security root) |
| `keychain:audit` | 15 704 / 2.3 MB | `at` order, 90 d / 20 000 rows | **R**, `ttlMs: 90 d`, `maxRows: 20000` (audit, owner `keychain`) |
| `keychain:resets` | 0 | list | **R**. The reset's runtime-created **archive tables** become an `archiveId` column on `keychain:secrets`/`keys` (D872 refuses runtime DDL) |

### 2.8 Authentication (local-auth, auth-webauthn, core-auth, system-config)

Volumes are tiny. The hot path is per-request validation: a primary-key or prefix
lookup, measured at 0.02 ms through a partial expression index. Moving these tables
is a security change, not a performance one: owner-scoped reads make them LESS
reachable than they are today (any door caller can `query` `users` now). They go
last, under operator review, never by the automatic orphan drop.

| Table | Rows / size | Hot queries | Verdict |
| --- | --- | --- | --- |
| `users` | 2 | pk, username | **R+x**: `username` UNIQUE |
| `api_keys` | 0 | `tokenPrefix` per request | **R+x**: `prefix` |
| `scoped_tokens` | 51 / 20 K | token hash per request, `userId`, `expiresAt` reap | **R+x**: `hash`, `user`; `expires_at` |
| `admin_tokens` | 1 | hash per request, `createdBy`, 30 d reap | **R+x**: `hash`; `expires_at` set on revoke/expiry |
| `share_view_tokens` | 10 | `tokenHash` per validation | **R+x**: `hash` |
| `login_sessions` | 83 / 28 K | pk, refresh hash, `userId`, reap 7 d / 30 d | **R+x**: `refresh`, `user`; `expires_at` |
| `login_session_cutoffs` | 1 | pk = user | **R** |
| `oauth_sessions` | 2 | `userId`, revoked reap 30 d | **R+x**: `user` |
| `user_totp` | 0 | pk = user | **R** (the TOTP secret should be a keychain marker. It is raw today; fix it in the same phase) |
| `user_external_identities` | 1 | `userId`, provider subject | **R+x**: `user`, `subject` |
| `device_credentials` | 5 | fingerprint per cert login, `userId`, 90 d reap | **R+x**: `fingerprint`, `user` |
| `auth_audit` | 26 771 / 8.1 MB | `userId`, 90 d reap | **R+x**: `user`; `ttlMs: 90 d` |
| `auth-webauthn:user_passkeys` | 1 | `credentialId` per assertion, `userId` | **R+x**: `credential` UNIQUE, `user` |
| `auth-webauthn:user_passkey_prefs` | 0 | pk = user | **R** |
| `mesh_node_certificates` | 22 / 12 K | by node, by fingerprint, 90 d past end | **R+x**: `node`, `fingerprint` (mesh admission D857 reads it: verify whether the TLS path reads it synchronously. If it does, keep a RAM mirror, which already exists for the revocation list) |
| `agent_https_names` | 3 | pk = node | **R** |

### 2.9 Counts per verdict (all 157, tallied by script against the live list)

| Verdict | Tables | Of which |
| --- | --- | --- |
| **R** (records, built-in indexes only) | **65** | NC 15, pipeline-analytics 20, system/hub-main 15 (incl. `agent_https_names`, keychain audit/resets), pipeline-orchestrator 4, ai 4, auth 3 (`user_totp`, `login_session_cutoffs`, `user_passkey_prefs`), recorder 2, notifiers/HA 2 |
| **R+x** (records with named partial expression indexes) | **30** | auth 12, pipeline-analytics 10, NC 4, other 4 (`training:jobs`, `integrations`, `integration_settings`, `ai:chats`) |
| **S** (stays its own table) | **7** relational + **37** vec | tracks, media, object-events (borderline), segment-hours, devices, keychain secrets + keys; 3 vec0 + 33 shadow + `vec_indexes` |
| **H** (device-history) | **4** | 2 × `stats-5m-v2`, 2 × `metrics:node-*-samples` |
| **K** (settings layer / engine) | **5** | `_collection_declarations`, `system-settings`, `addon-settings`, `addon-device-settings`, `device-runtime-state` |
| **D** (drop) | **9** | `addon-devices`, `sections`, `provider-settings`, `device-settings`, `ai:budgets`, `pipeline-analytics:retrain-dataset-versions`, `training:dataset-versions`, `benchmark:replay-runs`, bare `viewer-settings-snapshots` (plus the stale `vec_indexes` row, which is a row, not a table) |
| **Total** | 65 + 30 + 44 + 4 + 5 + 9 = **157** | |

---

## 3. The resulting logical tables

| # | Table | File | API |
| --- | --- | --- | --- |
| 1 | `system-settings` | camstack.db | `ctx.settings` (sections) |
| 2 | `addon-settings` | camstack.db | `ctx.settings` |
| 3 | `addon-device-settings` | camstack.db | `ctx.settings` |
| 4 | `device-runtime-state` | camstack.db | runtimeState (candidate for records later) |
| 5 | `_collection_declarations` (+ `_record_kinds`) | every file | engine catalog |
| 6 | **`records`** | camstack.db **and** events.db (one schema, 2 physical) | `ctx.records` |
| 7 | `device-manager:devices` | camstack.db | device-manager |
| 8 | `keychain:secrets` | camstack.db | keychain |
| 9 | `keychain:keys` | camstack.db | keychain |
| 10 | `pipeline-analytics:tracks` | events.db | declared table |
| 11 | `pipeline-analytics:media` | events.db | declared table |
| 12 | `pipeline-analytics:object-events` | events.db | declared table (borderline, Phase 7) |
| 13 | `recorder:segment-hours` | events.db (LTS Q3) | declared table |
| 14 | `vec_indexes` | events.db | vector-store registry |
| 15–17 | `vec_object_clip_siglip2_b16_224`, `vec_face_arcface`, `vec_identity_arcface` | events.db | vec0 (12 shadow tables each) |

**17 logical tables** (13 relational + 4 vector), down from 120 relational + 37
vec. Physically ≈ 18 + 36 shadows. If Phase 7 folds `object-events` and
`device-runtime-state`, the count is **15**. `history.db` (device-history) is the
separate store of numeric series and is not counted. It replaces 4 tables here.

Bytes: the four "stay" giants hold 477 MiB, the vectors 443 MiB, history candidates
80 MiB. The rest, ≈ 190 MiB (mostly audio/motion events, ops-log, auth_audit,
birth-decision), becomes records. With JSON key overhead that is ≈ +20–40% on
those rows, which falls back once the audio level rows go to history (P4).

---

## 4. Migration plan

### 4.1 The mechanism (the same for every phase)

The 2026-10-17 incident is the constraint: a migration wrote one store while a
runner read another, and recordings stopped for 35 minutes. So:

1. **Old build running**: `scripts/hub/records-adopt.ts --server <url> --snapshot
   --owner <addon>` reads each source table through `settingsStore.query` (paged by
   primary key) and writes **counts plus a content hash per kind** (sha256 over
   sorted `id` + canonical JSON). The snapshot aborts on any read error (D49).
2. **Stop the owning addon** (`addons.stop`), and its runners on agents. Nothing may
   write the old table from now on.
3. **Install the new build of that addon** (`camstack deploy`, or
   `updatePackage`). Its manifest declares the kinds, so the storage reconciler
   creates the kinds and indexes before the runner spawns. The runner **refuses to
   start** while a kind it owns is empty and its legacy table (named in the manifest
   as `adoptsFrom`) still has rows. That is a boot guard, not migration code (D853),
   the same shape as the D870 boot guard.
4. **Copy**: `records-adopt.ts --copy` (dry run: per-kind counts, sample ids), then
   `--copy --apply`. It reads the old table through `settingsStore.query` and writes
   through **`storageAdmin.adoptRecords({ owner, kind, records })`**: admin tier,
   audited. It runs the same engine code as `ctx.records.putMany`, with
   `owner` = the kind's DECLARED owner (refused if that owner's installed manifest
   does not declare the kind), and it is idempotent (`put` by id, so a re-run resumes).
   Ids, `deviceId`, `at` and `expiresAt` are mapped by a per-kind function in the
   script, reviewed in the dry run.
5. **Verify**: count and content hash per kind equal the snapshot, byte for byte.
   Any difference is exit ≠ 0 and the addon stays stopped.
6. **Start the addon.** Passive live check: its own cap answers, plus
   `hub_logs`/`ops_status` for errors of that addon for 10 minutes (no load tests on
   the cluster).
7. **The old table is no longer declared by any manifest**: D872 marks it
   `orphaned`, and the scheduled job drops it after 14 days with a verified
   `database-snapshot`. Auth and keychain tables are dropped by the operator
   (`storageAdmin.dropCollection { collection, expectRows }`), never automatically.

**Rollback point** for every phase: the old table is untouched for 14 days.
Rollback = stop the addon, reinstall the previous version (it reads the old table),
start. Writes made after the cutover are lost, unless the script is run with
`--reverse` (records → old table). `--reverse` is provided for config-class kinds
only; ledgers accept the gap. Order per environment: dev hub (.50) completely,
then production (.9). Agents carry no records.

### 4.2 Phases (lowest risk first)

| Phase | Tables | Downtime | Rollback point | Effort |
| --- | --- | --- | --- | --- |
| **0. Drops** | `addon-devices`, `sections`, `provider-settings`, `device-settings` (remove from `CANONICAL_KV_COLLECTIONS` + the `SettingsCollection` type first), `ai:budgets` (remove the declaration), `pipeline-analytics:retrain-dataset-versions`, `training:dataset-versions` (read its 1 row first), `benchmark:replay-runs`, bare `viewer-settings-snapshots`, stale `vec_indexes` row | none (`dropCollection` with `expectRows`) | `database-snapshot` < 24 h | S |
| **1. The primitive** | none moved. `records` schema + `_record_kinds` in the engine (both files), `ctx.records` + door ops, `defineStorage.records` in D872's manifest reconciler, `storageAdmin.listKinds/readRecords/adoptRecords`, the boot guard, retention sweeps, System → Data rows per kind. Guards: `check-records-index-served` (spy `prepare`, assert no `Column` on the table cursor for each declared aggregate), `check-records-no-unindexed-where`, `check-durable-state-declared` extended to kinds. ADR. Framework release → a `@camstack/server` closure | one hub restart (closure install) | previous closure | L |
| **2. Config documents of forked addons** | NC config (`rules`, `rule-ai`, `summary-rules`, `timelapse-rules`, `calendar-events-rules`, `sequences`, `texts`), `notifiers:notification-targets`, `provider-homeassistant:ha-notification-targets`, `ai:*` (5; `apiKey` → keychain), `pipeline-orchestrator:node-benchmark-*` (3) + `node-stress-moves`, `recorder:exports`, `recorder:ops-log`, `training:jobs`, pipeline-analytics small config (`scenes`, `viewer-settings-snapshots`, `migrations`, `sweep-cursors`, `face-rescore-state`): **≈ 25 tables, < 300 rows** | one restart per addon (seconds; recorder: a writer restart, so do it in a quiet window) | old tables, 14 d; `--reverse` | M |
| **3. Live-state ledgers (DurableLedger mirrors)** | NC `liveness`, `device-alerts`, `system-state`, `occupancy`, `device-prunes`, `state-summary-stamps`, `meta`, `snoozes`, `snooze-suppressed`, `track-groups`, `outbox`, `artifacts`; pipeline-analytics `phantom-cells`, `package-background`, `stationary-evidence`, `stationary-objects`, `scene-latch`: **17 tables**. DurableLedger's storage half is rewritten over `ctx.records`, so both byte-identical copies shrink | pipeline-analytics runner restart (post-analysis and notifications pause for ~1 min; detection keeps running) | old tables, 14 d | M |
| **4. Hub-main builtins** | `device-manager:tombstones`, `cluster-node-history`, `integrations`, `integration_settings`, `core_blocks`, `core-blocks:settings`, `calendars:user-prefs`, `storage_locations`, `storage_drain_state`, `backup_*` (4), `alerts`, `keychain:audit`, `keychain:resets` (+ the archive column): **17 tables** | hub restart (~1–2 min, the whole hub) | previous closure + old tables | M |
| **5. Event ledgers → `records@events`** | runs WITH LTS P5 (events.db split), after P4 (audio levels → history): motion/audio/sensor events, faces, plates, identities + identity-samples, vehicles + vehicle-samples, track-aliases/purity/relations/tapes, birth-decision ledger, debug-note-archive, ops-log, retrain × 4: **≈ 24 tables, ≈ 2.7 M rows before P4, ≈ 0.6 M after** | pipeline-analytics stopped for the copy (minutes; inside the P5 offline window) | the P5 split keeps the originals until verified; old tables 14 d | L |
| **6. Authentication** | the 16 auth tables of §2.8 (+ TOTP secret → keychain) | hub restart. Before it: an admin token minted and tested, and the snapshot verified. A mistake here locks the operator out | old tables, dropped by the OPERATOR only | M |
| **7. Measured folds (optional)** | `object-events` → R+x (only if an N100 measurement of insert p99 with the two expression indexes is within 20% of today's, and the track cascade transact stays in one file); `device-runtime-state` → records | pipeline-analytics restart; hub restart | old tables 14 d | M |
| **History track (independent, LTS P4)** | `stats-5m-v2` × 2, `metrics:node-*-samples` × 2 → device-history | as in the LTS plan | as in the LTS plan | (already planned) |

Dependencies: Phase 1 needs D870 landed (done) and D872 R1 (census) at least. Phases
2–4 need D872 R2 (no runtime DDL), because the kinds are created by the reconciler.
Phase 5 is part of LTS P5 and must not run before it: putting 2 M rows into the
settings file's records table would put their retention deletes on the settings
thread.

---

## 5. Risks, and what would change the answer

**Risks**

1. **A silent expression mismatch is a full scan.** Mitigation: one renderer for
   index and predicate (`fieldExprFor`); `query` refuses unindexed fields; the
   guard checks opcodes, not the plan text (EQP prints `USING INDEX` even when the
   table is never read).
2. **Blast radius of a shared table.** An engine bug that drops the `kind_id`
   predicate deletes across kinds. Mitigation: every statement is compiled with
   `kind_id = <literal>` as its first term by one function, no API exists without a
   kind, a property test runs random filters against two kinds, and the security
   roots (keychain, devices) are not in the table.
3. **Settings-thread stalls (D447).** Large deletes in `camstack.db`'s records table
   would hold every configuration read. Mitigation: high-volume kinds must declare
   `database: 'events'` (guard: a kind with `ttl`/`maxRows` > 50 000 or class
   `ledger` with `device: required` and a per-frame trigger is refused in `settings`),
   and deletes are batched.
4. **Ordering (D870 incident).** Mitigation: the boot guard, plus the
   stop → install → copy → verify → start order. The script refuses `--apply` while
   the owner is running.
5. **Size.** JSON keys add ≈ 100–150 B per narrow row. Acceptable for everything
   that moves; it is the reason `media` (1 M rows) stays.
6. **Rollback loses post-cutover writes** for ledgers (`--reverse` is offered for
   config only).
7. **The partial-index proof depends on literals.** If someone later binds
   `kind_id` as a parameter, the planner may not prove the partial index usable on
   a cached statement. The compiler owns it, and a spec pins it.
8. **Cross-file families.** identities/samples, vehicles/samples and retrain × 4
   must sit in ONE file, or their deletes stop being atomic. The manifest declares
   `transactFamily`, and the reconciler refuses a split family.
9. **Secrets found in plain rows** (`ai:llm-profiles.apiKey`, `user_totp.secret`,
   possibly `backup_encryption_keys`). Moving them unchanged into records would
   carry the leak along. Fix them in the same phase.

**What would change the answer**

- **SQLite < 3.41** on any node that hosts records: the indexed-expression
  optimization goes away, so expression-indexed aggregates read every row. Then
  `alerts`, `auth_audit`, `ops-log` and the outbox stay fine (small or `at`-served),
  but `object-events` must stay a table for good, and Phase 7 is off.
- **A RAM mirror in device-manager** for devices: then `device-manager:devices`
  becomes a records kind (it is 1 083 rows; the obstacle is the uncached PK path
  plus 4 secondary keys).
- **`positions`/`snapshots` moved out of the track row** (to tracking tapes or
  files) would bring the track row to ~300 B. The 45 fields, zone-envelope ranges
  and fleet scans would still keep `tracks` a table.
- **A requirement for ad-hoc admin SQL per kind** (System → Data "filter by any
  field"): records deliberately cannot do it. Such a feature would read through the
  owner's cap or a bounded scan with an explicit "slow" label.
- **Notification centre moving out of pipeline-analytics** changes only which
  runner restarts in Phase 3, not the verdicts.
- **N100 measurements**: Phase 7 is decided by numbers, not by this document.

## Operator decisions (2026-10-18), binding on this plan

- **Phases 0–4 run in sequence** without stopping between phases; stop only when a
  verify fails. Phase 5 (event ledgers) and phase 6 (authentication) are out of
  scope for now.
- **Secret fields are a feature of `ctx.records`.** A record kind's Zod schema field
  marked `.meta({ secret: true })` is stored as a keychain marker automatically,
  bound to the row's own ref (as D878), redacted on read, a password field in the
  UI, migrated on adoption. No addon handles secrets by hand any more. The rows
  still raw today are listed in D879 (`RAW_UNTIL_RECORDS`) and in D880's live scan.
- **Generic entries.** Every list of user-created entries becomes a generic entry
  record kind with one generic entries UI (list / add / edit / delete, password
  fields); see `entries-census.md` for the inventory.
- **A broker is the entry that holds the credentials; an integration references a
  broker.** `brokers[]` (Home Assistant, Homematic, Matter, import-Alexa, Google…)
  migrates to entries; the credentials duplicated on integrations are a leftover
  from before brokers and are removed when the brokers migrate. (This overrides the
  census recommendation to fold brokers into integrations.)
- **(2026-10-20) Old tables are dropped by hand, on the operator's hubs only.**
  No allowlist growth, no D872 scheduled orphan drop: the copy/verify/drop of
  §4.1 runs offline (hub stopped) on `.50` then `.9`, as for phases 2–6 and H.
  This overrides §4.1 step 7. When the last legacy table is gone, the
  migration-only APIs and scripts (`adoptRecords`, `readLegacyCollection`,
  `dropCollection`, `STORAGE_ADMIN_MOVED_COLLECTIONS`, the `adoptsFrom` boot
  guard, `scripts/hub/records-adopt*`, `scripts/ops/split-databases/*`) are <!-- drift-ok -->
  deleted in one change.
- **Adoption dry run starts with `scripts/hub/scan-raw-secrets.ts`** (D880): the
  code guard cannot see orphaned rows, the live shape-only scan can.
