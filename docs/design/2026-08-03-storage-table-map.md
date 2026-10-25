---
title: Storage table map — every table, its blob, its predicates, and what an ORM would do with it
last-verified: 2026-09-10
covers:
  - packages/system/src/builtins/sqlite-storage/**
  - packages/addon-post-analysis/src/pipeline-analytics/store/**
  - packages/addon-post-analysis/src/notification-center/**
  - packages/types/src/interfaces/storage.ts
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/delete-track-cascade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/plate-gallery-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention-policy.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-kinds.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts
  - packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts
  - packages/addon-admin-ui/src/components/detection-intelligence/SemanticEventSearch.tsx
  - scripts/lib/parse-storage.ts
---

# Storage table map

> **STATUS, re-verified 2026-08-14. §1–§3 are a MEASUREMENT dated 2026-08-03 and
> are not re-measured here; §4–§7 have moved.**
>
> **BUILT since the measurement.** B1 and **B2 are both closed** — `ensureTable`
> and the six `table*` methods are gone from `ISettingsBackend` (a comment at
> `packages/types/src/interfaces/storage.ts:201` records what each became), and
> the four consumers of §4.3's table went onto the collection surface. **G1 and
> G2 are on the cap** as `deleteWhere` / `updateWhere`
> (`packages/types/src/capabilities/settings-store.cap.ts:179`), so §7.6's first
> two items are partly done and the N+1 retention loops §4.2 complains about are
> now expressible. `storage-orchestrator` is the door and SQLite is an engine
> behind it ([D44](../decisions/adr-0044.md)); sqlite-vec joined as a second
> index inside the same builtin (`vector-index-vec.ts`) rather than as a rival
> door, which is what §5 predicted. Legacy auto-create on first write is gone —
> an undeclared collection now fail-fasts, guarded by
> `scripts/check-collection-declarations.ts` and
> `scripts/check-collection-namespacing.ts`.
>
> **Two §3 rows are now WRONG, and one of them matters.** §3.5's
> `device-runtime-state` is no longer a table with no writer: D131 pointed the
> writer at the collection it is named for, with a legacy read fallback and a
> per-device migration. **Do not act on §7.4's "delete `device-runtime-state`"
> row.** §3.46's `cluster-node-history` no longer writes 8,640 rows/day — a
> descriptor-change-or-5-minutes rule cut it to ~864
> ([D131](../decisions/adr-0131.md)).
>
> **§7.5's two `[undetermined]`s are answered.** `cache_size = -16000` comes
> from better-sqlite3's own build (`SQLITE_DEFAULT_CACHE_SIZE=-16000`), and
> `mmap_size` is now set from `sqlite-pragmas.ts` along with
> `journal_size_limit` and a gated truncating checkpoint
> ([D55](../decisions/adr-0055.md)).
>
> **NOT built.** Everything in §7.3 (phase 2 — schema in code, `schema_version`,
> the guard) **except `defaultValue`**, which landed on `CollectionColumnSchema`
> on 2026-08-03 (`packages/types/src/capabilities/settings-store.cap.ts:66`) —
> §3.39, §5.2, §5.4 step 1 and §7.3 all still call it missing, and it was the
> named blocker on §5.4 step 2. `device-store.ts` and `config-store.ts` are still
> there; `getDatabase()` is too, but it is **no longer callerless** — WAL
> maintenance and the sqlite-vec index have held it since 2026-08-06
> (`sqlite-settings.addon.ts:156`, `:202`), so §4.3 B4, §5.2, §5.4 step 3 and
> §7.4's "Delete" row would today break both. No `VACUUM` has been run.
> §7.5's measured wins are untouched apart from the pragma work above.
>
> **2026-08-19 — phase 3 has STARTED, and the mechanism it lacked now exists.**
> §7.4's first two rows are EXECUTED: the device half of the integration-registry
> is deleted and `devices` / `device_settings_kv` are dropped at every boot from
> `RETIRED_COLLECTIONS`
> ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)),
> so the `ensureTable` class counted in §1.1 and §2 is now two tables shorter.
> Two sibling purges landed beside it, each gated on a POPULATED successor:
> `RETIRED_SETTINGS_ROWS` for whole rows
> ([D182](../decisions/adr-0182-a-fleet-is-rows-not-a-blob-and-a-per-device-question-costs-one-row.md))
> and the addon-owned `retireRootKeys`
> ([D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md)).
> `lost_and_found` (18 738 rows, a `.recover` artefact) was dropped by hand the
> same evening.
>
> **2026-08-21 — two new durable collections, and one deliberate breach of
> §3.22's "never touched".** `pipeline-analytics:phantom-cells`
> ([D204](../decisions/adr-0204-a-phantom-cell-outlives-the-tracks-that-made-it.md))
> and `pipeline-analytics:package-background`
> ([D206](../decisions/adr-0206-a-position-that-delivers-itself-is-background.md))
> joined the census: both are SCENE-owned, classified `never-orphaned` in
> `retention/collection-classification.ts`, bounded by their own write-time
> mechanics (a 24 h / 7 d window plus a per-device cap, enforced on write) and
> take NO age sweep. And an `identity-samples` row is no longer beyond every
> collector: the boot gallery reconcile
> ([D207](../decisions/adr-0207-a-gallery-reference-without-a-blob-is-a-deleted-reference.md),
> `retention/gallery-reconcile.ts`, probing through the media store's
> `referencedBlobState`) removes a sample whose blob is gone from the
> filesystem — through the operator's own `removeSample` path, with cover heal
> — see the note on §3.22.
>
> **Deliberately dropped: §6.** The Drizzle recommendation was not taken. The
> remediation plan decided *unify FIRST, ORM later or never* on the same day, on
> the argument §6.4 itself makes — the ORM is the smallest of the wins here, and
> the operator's requirement is satisfied by deleting the doors. §6 is kept
> because §6.4 and §7.7's evidenced defaults still apply to whatever eventually
> owns the schema.
>
> **2026-08-25/26 — re-verified against five days of storage perf work; two
> corrections landed, everything else held.** CI was dark 2026-08-21→2026-08-26,
> so this is the first check against that window. **§3.11's `count` row was
> WRONG and is fixed**: `count` used to compile only `where` equality and
> silently drop `whereIn`/`whereBetween`/`whereNot`, always over-counting —
> `TrackStore.countStaging` and the notification-centre gallery's paging total
> both relied on it. It now shares `compileFilter` (`select` mode) with `query`. **§3.12's `listDeviceIds` full-scan claim was WRONG and is
> fixed**: that caller no longer pages `lastSeen` with no `deviceId` — it is a
> `histogram` GROUP BY served from the existing composite index, 678 ms → 6.0 ms
> on a hub copy. The §2.5 SCAN verdict for that query SHAPE still
> holds (no new index shipped); only the caller changed. Everything else
> checked held: `query` gained a real SQL `columns` projection
> this changes bytes read, not the WHERE-clause SEARCH/SCAN verdicts, so none of
> §2.5's index verdicts moved; `TrackStore`'s and `EventStore`'s motion/object
> `slim` projections were migrated onto it the same day (audio deliberately excluded) without contradicting any existing
> claim in this doc, which never asserted those projections were SQL-level.
> `tracks` gained a stored `observations` column — added to
> §3.12; a **separate, pre-existing** batch of undocumented columns on `tracks`
> (`labelScore`, `subLabel`, `retrainStatus`, `debug`, `favourited`, `hasFace`,
> `hasEmbeddedFace`, `hasRider`, `closedReason`) was found while checking this
> and predates 2026-08-21 — flagged in §3.12 rather than silently backfilled,
> since backfilling it is not a live re-measurement and is out of this pass's
> window. `addon-device-settings` gained a batched `<addonId>`-prefix read
> (`readDeviceStoreBatch`) replacing 967 sequential per-device
> reads in the fleet listing — noted in §3.3; it is a **third** access pattern
> alongside the two already documented (PK-range seek, `deviceId` `json_extract`
> SCAN) and does not change the SCAN verdict for the shape nothing was found to
> actually issue. **Out of scope for this doc, confirmed by checking**:
> `device-manager:devices` / `DeviceRowStore` lives in `packages/system/src/builtins/device-manager/**`,
> which this document's `applies-to` never covered and which §3 has never had an
> entry for — not added here. **Cannot verify**: every `[measured]` byte/row
> count in §2.1–§2.3 needs a fresh live-hub read this pass did not have (the
> engine's own boot log now reports the file at 858 MB with the freelist
> question separated out from "genuinely full of rows" — up from
> the 277 MiB in §2.1 — but that is idle growth without a `VACUUM`, not a
> claim this document makes, so it is noted, not corrected).

> **2026-09-15 — WHAT THIS PAGE IS, and four §3 entries corrected.**
>
> This is a **dated measurement and analysis**, not a description of the current
> schema: §1–§3 were read off a live hub on **2026-08-03** and every box above
> is a dated amendment to it. Its frontmatter said `applies-to` over ~50 store
> files — "I checked these on `last-verified`" — and that promise was never
> kept: the 2026-09-10 narrowing pass replaced a directory tree with an explicit
> file list *without re-verifying a single one of them*, and said so. The list
> is now `covers:`, which is what a page like this can honestly claim (D145).
> `last-verified` is deliberately NOT moved.
>
> **Four §3 entries were re-read against the code on 2026-09-15 and were WRONG.**
> D474 (an event id is the rowid), D475 (motion episodes), D476 (a media key
> names its table) and D482 (a media row is addressed by its own id) all moved
> primary keys and columns under this map:
> §3.13 `media`, §3.14 `object-events`, §3.15 `motion-events` and §3.16
> `audio-events` have corrected column lists and retention rules below. The
> per-family retention knobs those three event entries cited
> (`retentionMotionDays` / `retentionObjectDays` / `retentionAudioDays`) do not
> exist at all — **D62** collapsed them into ONE window per device long before
> this pass, so those lines had been wrong since well before 2026-09-10.
>
> **NOT re-verified in this pass, and therefore still suspect**: every other §3
> entry, §2's reconciliation counts, and §4–§7. In particular `tracks` (§3.12)
> took column work under D471, and `pipeline-analytics:stats-5m` — the long-term
> occupancy series (`store/lts-store.ts`), which the occupancy chart now reads —
> has **no §3 entry at all**.

Input to the ORM adoption described in
[the DB remediation plan](./2026-08-03-db-remediation-plan.md). That page is the
sequence; this page is the ground truth it sequences over.

The bulk of this document is [§3, one subsection per table](#3-table-by-table).
Read that first if you are about to touch a table. The three architectural
answers are in [§4](#4-a-the-storage-capability-as-it-stands),
[§5](#5-b-how-sqlite-settings-disappears) and [§6](#6-c-orm-fit-per-table);
the ordered work list is [§7](#7-work-list-keyed-to-the-remediation-phases).

## 0. How to read the evidence markers

Every factual claim carries one of three markers. An unmarked guess in a map
like this is worse than a hole, because it reads as fact.

| Marker | Means |
| --- | --- |
| **[measured]** | Read off the live hub (`root@<hub-ip>`, container `CamStack`, `/data/addons-data/sqlite-settings/camstack.db`) on 2026-08-03, read-only, via `better-sqlite3` opened with `readonly: true`. Row counts, `dbstat` byte sizes, `sqlite_master` DDL, `EXPLAIN QUERY PLAN` output, `AVG(LENGTH(blob))`, value distributions. |
| **[source]** | Read out of a source file at the cited `file:line`. Zod schema, TS type, SQL string, call site. |
| **[undetermined]** | Could not be established. Stated as a hole, never filled with something plausible. |

The live hub is one install with ~10 cameras and ~31 days of media. Row counts
are therefore an *order of magnitude for this install*, not a universal
constant; the growth **rule** (per detection / per track / per event / per
device / per install) is derived from the writer and is universal.

## 1. Corrections to the established facts

Three of the assumptions this work started from turned out to be wrong. Each is
load-bearing for the plan, so each is stated before the map.

### 1.1 Tables are created FIVE ways, not four — `ensureTable` was the missing one

`ISettingsBackend.ensureTable(table, schema)`
(`packages/types/src/interfaces/storage.ts:205`) creates a fully typed table
**without going through `declareCollection`**. The generated map's extractor
matched `declareCollection` and raw `CREATE TABLE`, so it reported **none** of
the seven tables created this way. They were in the same blind spot the missing
tRPC `declareCollection.mutate` shape had already created once.

The seven **[source]**:

| Table | Created at |
| --- | --- |
| `integrations` | `packages/system/src/builtins/sqlite-storage/integration-registry.ts:105` |
| `integration_settings` | `packages/system/src/builtins/sqlite-storage/integration-registry.ts:106` |
| `devices` | `packages/system/src/builtins/sqlite-storage/integration-registry.ts:107` |
| `device_settings_kv` | `packages/system/src/builtins/sqlite-storage/integration-registry.ts:108` |
| `storage_locations` | `packages/system/src/builtins/storage-orchestrator/location-store.ts:94` |
| `backup_schedules` | `packages/system/src/builtins/backup-orchestrator/schedule-store.ts:72` |
| `backup_destination_policies` | `packages/system/src/builtins/backup-orchestrator/destination-policy.ts:92` |

`scripts/lib/parse-storage.ts` now matches this shape (`parseEnsureTables`) and
`docs/reference/storage.md` publishes them as section 4. That change is part of
this work.

### 1.2 All three `declareCollection` shapes are real — but the split is 1 / 7 / 27

The plan's three shapes are confirmed. A full census of the 35 production call
sites **[source]** gives the distribution:

| Shape | Count | Who |
| --- | --- | --- |
| **S1** `declareCollection({collection, columns})` (direct provider object) | **1** | `server/backend/src/core/agent/cluster-node-history-store.ts:119` — the only caller holding the raw `ISettingsStoreProvider` rather than a tRPC client. Wrapped in a `try`/`catch` that logs `declareCollection failed (best-effort)` and continues (`:129`). |
| **S2** `declareCollection(name, columns)` (port wrapper) | **7** | `addon-ai` ×5 (`defaults-store.ts:24`, `profile-store.ts:36`, `:37`, `usage/usage-store.ts:74`, `:75`), `addon-notifiers/src/target-store.ts:83`, `addon-provider-homeassistant/src/ha-notification-output.ts:314`. All forward into S3. |
| **S3** tRPC `declareCollection.mutate({…})` | **27** | Everything else — all of pipeline-analytics, notification-center, auth, passkeys. |

So phase 1's "one declaration path" is a **one-line change plus two port
deletions**: rewrite S1 to go through the cap or accept it as the bootstrap
exception, and collapse the three structurally identical `SettingsStorePort`
interfaces (`addon-notifiers/src/target-store.ts:44`,
`addon-ai/src/settings-store-port.ts:27`,
`addon-provider-homeassistant/src/ha-notification-output.ts:275`) into one.

Two of the S2 sites are also the only ones whose collection name is
`this.collection`. **[source]** both resolve to a literal in production, because
the parameter has a default and no production construction site overrides it:

- `packages/addon-notifiers/src/target-store.ts:74` — default
  `TARGETS_COLLECTION` (`:17` = `'notification-targets'`); only construction
  site `packages/addon-notifiers/src/addon.ts:63` passes no second argument.
- `packages/addon-provider-homeassistant/src/ha-notification-output.ts:305` —
  default `HA_TARGETS_COLLECTION` (`:53` = `'ha-notification-targets'`); only
  construction site `packages/addon-provider-homeassistant/src/addon.ts:242`.

Hoisting those two names to a module constant at the call site removes the
last statically unresolvable table names in the repo.

### 1.3 The auth tables are NOT raw DDL — they are declared, with real columns

The plan flags `api_keys`, `oauth_sessions`, `user_passkeys` as raw-DDL tables
"whose columns the extractor does not read". **[measured]** the live DDL shows
9, 8 and 8 typed columns respectively; **[source]** they are declared through
the normal tRPC `declareCollection` path in
`packages/system/src/builtins/local-auth/auth-schema.ts` and
`packages/addon-auth/src/webauthn/passkey-store.ts`. There is **no raw
`CREATE TABLE` anywhere in first-party source** — `parseRawTables` in the
extractor currently finds nothing, and the two `${scoped}` / `${table}` entries
in the map's "not statically knowable" section are the backend's own
interpolated DDL, not an addon owning its schema.

So the four-paths framing collapses to three real ones plus the backend's own
internals: **canonical KV**, **scoped variant**, **`declareCollection`**,
**`ensureTable`**.

### 1.4 It is not "23 of 33 declared tables have real columns" — measured, it is 30 of 33

The plan's count came from the extractor's best-effort column list, which is
truncated by a 400-character parse window and which the generated page
deliberately does not publish. Read off the live DDL instead **[measured]**:

- **30 of the 33** `declareCollection` tables have real, multi-column schemas.
- **3** are `(id TEXT PK, data TEXT NOT NULL)` KV-shaped — and they are **not**
  the ones the plan names. They are `llm-profiles`, `llm-meta` and
  `llm-defaults` (§3.49), all three from `addon-ai`'s `KV_BLOB_COLUMNS`.
- Adding the 7 `ensureTable` tables, all typed: **37 typed of 40 non-canonical
  tables.** Plus the two `this.collection` KV tables (§3.31, §3.32), the total
  KV-shaped population outside the canonical nine and their scoped variants is
  **five**.

The practical consequence is the same one the plan drew, only stronger: phase 4
is not "convert the database". **Almost all of it is already columnar**, and the
JSON that remains is either read whole (correctly) or is one specific
encoding mistake (§3.18).

## 2. The reconciliation — the live schema is fully accounted for

**[measured]** `sqlite_master` on the hub holds **102 tables**. After the
extractor fix, every one of them classifies:

| Class | Count | Where the list lives |
| --- | --- | --- |
| Canonical KV collections | 9 | `packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts:66` |
| Per-addon scoped variants `<addonId>:<canonical>` | 51 | Rule only — never a list. `sqlite-settings-backend.ts:145` |
| `declareCollection` tables | 33 | `docs/reference/storage.md` §3 |
| `ensureTable` tables | 7 | `docs/reference/storage.md` §4 |
| Named by a `this.collection` expression | 2 | `notification-targets`, `ha-notification-targets` |
| **Unaccounted** | **0** | — |

9 + 51 + 33 + 7 + 2 = 102. **There is no table on disk that no code creates.**

That kills the shape phase 3 was expected to take. **The deletion candidates are
not orphan tables — they are live tables that hold nothing, or hold rows nothing
will ever read.** The real list is §7.4.

### 2.1 Database-level facts

**[measured]**

| Fact | Value |
| --- | --- |
| File | `/data/addons-data/sqlite-settings/camstack.db`, 289,964,032 B (277 MiB) |
| `journal_mode` | `wal` ✅ (set at `sqlite-settings-backend.ts:99`) |
| `synchronous` | `1` (NORMAL) — SQLite's own WAL default, never set explicitly |
| `page_size` | 4096 |
| `page_count` | 70,792 |
| `freelist_count` | **22,106 pages = 86 MiB, 31% of the file, reclaimable by one `VACUUM`** |
| `mmap_size` | **0** — memory-mapped I/O is off |
| `cache_size` | `-16000` (16 MiB). Not set by CamStack; this is not the SQLite default (`-2000`), so something in the closure sets it — **[undetermined]** where. |
| `auto_vacuum` | `0` (none) |
| `user_version` | **0** — there is no schema version, and therefore no migration ledger |
| `foreign_keys` | `ON` (`sqlite-settings-backend.ts:100`) — but **no table declares a foreign key**, so it is inert |

### 2.2 The ten largest objects

**[measured]**, `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name`:

| Object | Size | Rows |
| --- | --- | --- |
| `pipeline-analytics:object-embeddings` | **86.50 MB** | 7,375 |
| `pipeline-analytics:media` | 29.72 MB | 112,658 |
| `pipeline-analytics:tracks` | 16.41 MB | 2,176 |
| `sqlite_autoindex_pipeline-analytics:media_1` (PK) | 11.24 MB | — |
| `idx_media_owner` | 7.67 MB | — |
| `pipeline-analytics:motion-events` | 6.53 MB | 101,059 |
| `sqlite_autoindex_…media…` / `…motion-events…` | 6.20 MB | — |
| `pipeline-analytics:audio-events` | 4.29 MB | 59,136 |
| `pipeline-analytics:object-events` | 2.20 MB | 10,637 |
| `pipeline-analytics:ops-log` | 1.44 MB | 9,678 |

Everything else in the database is under 1.1 MB. **Six tables are 96% of the
file.** Any optimisation that is not about those six is decoration.

### 2.3 Blob widths, measured

**[measured]** `AVG(LENGTH(col))` / `MAX(LENGTH(col))`, in bytes:

| Column | Avg | Max | Rows × avg |
| --- | --- | --- | --- |
| `object-embeddings.embedding` | 10,816 | 10,955 | **79.8 MB** — the entire table |
| `faces.embedding` | 10,772 | 10,813 | 0.96 MB |
| `tracks.positions` | 6,734 | 33,439 | **14.6 MB of a 16.4 MB table** |
| `notification-center:rules.rule` | 524 | 566 | 2 KB |
| `notification-center:outbox.payload` | 387 | 485 | 35 KB |
| `alerts.data` | 378 | 1,072 | 0.86 MB |
| `tracks.snapshots` | 206 | 1,873 | 0.45 MB |
| `addon-device-settings.data` | 140 | 14,639 | 0.44 MB |
| `motion-events.regions` | **3** | 300 | 0.3 MB |

Two readings jump out. `object-embeddings` and `tracks` **are** their blob — the
scalar columns are rounding error. And `motion-events.regions` averages three
bytes: 101,059 rows are storing the literal string `[]`.

### 2.4 Retention actually runs, and the observed spans match the configured defaults

> **SUPERSEDED 2026-08-06 for the ANALYTICS tables — [D61](../decisions/adr-0065.md).**
> The measurements below stand; the mechanism behind them does not. Every
> per-table "Retention" bullet in §3.12–§3.23 describes a world with **ten**
> independent age sweeps. There is now **one**, over `pipeline-analytics:tracks`,
> and it cascades. Specifically, and this is what changed:
>
> - `MediaStore.evictBefore`, `ObjectEmbeddingStore.pruneAll` /
>   `pruneDeviceBefore`, `FaceStore.prune` and the age halves of the face/plate
>   `pruneAll` buffer prunes are **deleted**. Those families are TRACK-OWNED and
>   leave only through the cascade.
> - `EventStore.evictBefore` is now `evictTracklessBefore` and covers **motion
>   and audio only** — object events are track-owned.
> - `SensorEventStore.evictBefore` takes a `deviceId`; the **fleet minimum**
>   (`minObjectCutoffMs`) no longer exists anywhere.
> - Orphaned rows are collected by OWNERSHIP, on a wide interval, report-first
>   (`retention/orphan-audit.ts`) — never by age.
>
> The measurements are kept because they are the record of WHY: the 31.0-day
> media span against 7.0 days of tracks, and the 19.2-day embedding span, are
> the two disagreements the change exists to make impossible.

**[measured]** oldest → newest row per table, against the **[source]** defaults
in `packages/addon-post-analysis/src/pipeline-analytics/retention-policy.ts:38`:

| Table | Observed span | Configured default | Verdict |
| --- | --- | --- | --- |
| `pipeline-analytics:media` | 31.0 d | follows recordings | bounded |
| `pipeline-analytics:motion-events` | 14.0 d | `retentionMotionDays: 14` | **exact match** |
| `pipeline-analytics:audio-events` | 7.0 d | `retentionAudioDays: 7` | **exact match** |
| `pipeline-analytics:tracks` | 7.0 d | `TRACK_RETENTION_DEFAULT_DAYS` | **exact match** |
| `pipeline-analytics:object-events` | 19.8 d | `retentionObjectDays: 30` | not yet at the bound |
| `pipeline-analytics:object-embeddings` | 19.2 d | rides object retention | not yet at the bound |
| `pipeline-analytics:ops-log` | 4.7 d | own cap | bounded |
| `notification-center:outbox` | 2.6 d | 7 d, **boot-only** (§3.29) | unbounded while up |
| `alerts` | 17.9 d | 30 d, **gated on `read`** (§3.9) | **unbounded — see below** |

Retention is not the problem this repo was worried it might be. Two tables are
the exception and both are exceptions for a *logic* reason, not a volume one.

### 2.5 Query plans for the hot predicates

**[measured]** `EXPLAIN QUERY PLAN` on the live database, with parameters bound:

| Query | Plan |
| --- | --- |
| `media WHERE ownerKind=? AND ownerId=?` | `SEARCH … USING INDEX idx_media_owner` ✅ |
| `media WHERE deviceId=? AND timestamp BETWEEN ? AND ?` | `SEARCH … USING INDEX idx_media_device_ts` ✅ |
| `media WHERE kind=?` | **`SCAN pipeline-analytics:media`** (112k rows) |
| `tracks WHERE deviceId=? AND lastSeen BETWEEN ? AND ?` | `SEARCH … USING idx_tracks_device_lastSeen` ✅ |
| `tracks ORDER BY lastSeen DESC LIMIT 50` (no device) | **`SCAN` + `USE TEMP B-TREE FOR ORDER BY`** — plan verdict unchanged (no new index), but **the caller that drove this shape (`listDeviceIds`) was rewritten 2026-08-25** to a `histogram` GROUP BY that hits `idx_tracks_device_lastSeen` as a covering index instead — see §3.12 |
| `object-events WHERE trackId=?` | `SEARCH … USING idx_object_track` ✅ |
| `object-events WHERE timestamp BETWEEN ? AND ?` (no device) | **`SCAN` + `TEMP B-TREE`** |
| `object-embeddings WHERE className=? AND timestamp>?` | **`SCAN`** (86 MB table) — **this table no longer exists** (superseded 2026-08-06, see the banner at §3.18); kept as the historical record the banner also keeps. Pre-dates and is unrelated to the 2026-08-21→2026-08-26 window this pass audits. |
| `faces WHERE assigned=0 ORDER BY timestamp DESC` | **`SCAN` + `TEMP B-TREE`** |
| `outbox WHERE status=? AND nextAttemptAt<=?` | `SEARCH … USING idx_nc_outbox_status` ✅ — but **no code runs this query** (§3.29) |
| `addon-device-settings WHERE json_extract(data,'$.deviceId')=?` | **`SCAN`** (3,142 rows) — still the plan for THIS shape; but the 967-sequential-read fleet-listing traffic that dominated this table's load never took this shape (it was per-device `id`-prefix PK-range reads, already a seek) and is now ONE `<addonId>:` prefix range scan instead (`readDeviceStoreBatch`) — see §3.3 |
| `addon-settings WHERE json_extract(data,'$.addonId')=?` | **`SCAN`** |
| `alerts WHERE json_extract(data,'$.status')=? ORDER BY json_extract(data,'$.createdAt')` | **`SCAN` + `TEMP B-TREE`** (2,288 rows) |
| `device_settings_kv WHERE device_id=? AND key=?` | **`SCAN`** — the table has no index of any kind. **This table no longer exists** — deleted 2026-08-19 (§3.42, D183). Predates this pass's window; flagged, not fixed here to keep this edit scoped to 2026-08-21→2026-08-26. |
| `integration_settings WHERE integration_id=?` | **`SCAN`** — same |


## 3. Table by table

Every table gets the same eight fields. Where a field says **UNDETERMINED** that
is the finding, not an omission.

The nine canonical KV collections come first, then the scoped-variant *rule* as
its own entry, then the domain tables grouped by owner.

### 3.1 `system-settings` — 25 rows / <4 KB [measured]

- **Creation** — canonical KV. `packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts:67`, materialised by the boot loop at `:106`.
- **Columns** — `id TEXT PRIMARY KEY NOT NULL`, `data TEXT NOT NULL`. No index beyond the PK autoindex.
- **Blob** — `data` is **not an object**: it is the JSON encoding of a single scalar or object *value*, keyed by a dot-path id. **[measured]** `id='features.streaming'`, `data='true'`. Shape per key is defined by `RUNTIME_DEFAULTS`, seeded on first boot at `sqlite-settings-backend.ts:650`. The key set is a flat namespace, not a schema — **[undetermined]** as a closed type.
- **Queried** — three synchronous raw-SQL accessors, all PK or full scan: `getSystem` `sqlite-settings-backend.ts:509` (`WHERE id = ?`), `setSystem` `:520` (upsert), `getAllSystem` `:530` (`SELECT id, data` — full scan, 25 rows).
- **Volume** — per configuration key. Bounded by `RUNTIME_DEFAULTS` plus operator overrides. Order 10¹.
- **Retention** — none needed.
- **Blob→columns** — **no**. Read whole, by id. This is exactly what the plan means by "settings collections are the wrong place to spend this".
- **Migration risk** — none. Any ORM models this as `(id, data)` with an opaque JSON value.

### 3.2 `addon-settings` — 22 rows / 0.16 MB [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:68`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — a **wrapper**, `{ addonId, key, value }` **[measured]** and **[source]** `sqlite-settings-backend.ts:556`, which explicitly detects the wrapper shape and skips a row missing `value`. Row id is `<addonId>.<key>`. `value` is the addon's own arbitrary setting — **[undetermined]** per addon, by design.
- **Queried** — `getAllAddon`. **[measured 2026-08-03]** it selected on `json_extract(data, '$.addonId')` → `EXPLAIN QUERY PLAN` **`SCAN addon-settings`**, while `setAllAddon` wrote by `id LIKE ? || '%'` prefix. **Changed 2026-08-19 ([D181](../decisions/adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)):** the read now uses the same `prefixWhere` key range the write has always used. The JSON predicate was a SECOND definition of "this addon's rows" — a row inside the JSON's idea of the addon but outside the key range was read and never deleted — and it was evaluated on EVERY row, so one unparseable row aborted every addon's config read at once.
- **Volume** — per (in-process addon × setting key). Only **hub in-process** addons land here; forked addons write `<addonId>:addon-settings` instead (§3.10, §4.4). Order 10¹–10².
- **Retention** — none.
- **Blob→columns** — `addonId` is the only predicate and it was a **full scan** until 2026-08-19. **Do not promote** — but the reasoning that follows was WRONG and must not be reused. It said: at 22 rows this costs nothing, and at 22 it will never cost anything, because the row count is bounded by the addon count. **Falsified 2026-08-19 (D181, D182):** that bounds the row COUNT, which is bounded by the addon count, and says nothing about the row SIZE, which is not. The device-manager's three fleet blobs (`deviceMeta` 467 KB, `deviceMetadata` 87 KB, `deviceIndex` 70 KB) took this table to 627 KB in 24 rows, the `json_extract` scan re-read all of it for EVERY addon's config read, and a V8 profile of the 2026-08-19 boot put 64 % of hub-main's JS thread inside `getAllAddon`. The fix was still not a column: it was the prefix key range plus one row per device in `device-manager:devices`. Note that the *duplicate* of this table for forked addons puts the addonId in the table name instead — the right fix is §5, not a column.
- **Migration risk** — the row-id grammar `<addonId>.<key>` is load-bearing (`sqlite-settings-backend.ts:555` slices it). Any ORM keeps `id` opaque or migrates both this table and `addon-device-settings` together.

### 3.3 `addon-device-settings` — 3,142 rows / 0.77 MB [measured] — the largest KV table

- **Creation** — canonical KV, `sqlite-settings-backend.ts:69`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — `{ addonId, deviceId, key, value }` **[measured]**, written by `setAddonDevice` `sqlite-settings-backend.ts:626` via the scoped helper `setScopedKey` `:696`. Row id is `<addonId>:<deviceId>.<key>`.
- **Queried** — `getAddonDevice` `sqlite-settings-backend.ts:622` → `getAllScoped` `:680`, which uses an `id LIKE ? || '%'` prefix scan (`:684`) — **PK-range, so it is served by the PK autoindex**. But a query by `deviceId` alone is `json_extract`: **[measured]** `SELECT … WHERE json_extract(data,'$.deviceId')=?` → **`SCAN addon-device-settings`** over 3,142 rows.
  **2026-08-25 — the table's busiest real traffic got a THIRD access pattern, and it is neither of the two above.** `device-queries.ts#listAll`'s FULL-projection fleet listing used to call `readDeviceStore(deviceId)` — the `getAllScoped` PK-range path above, already a seek — once **per device, sequentially**, on hub-main's event loop: 967 round trips per listing on this install, profiled at 9,229 `query addon-device-settings` calls/minute steady-state on 2026-08-25, the busiest read in the cluster by 4×, almost all spent on devices whose config the caller then discarded. `readDeviceStoreBatch` (`settings-door-view.ts`) answers a whole addon's device rows in **one** `<addonId>:` prefix range scan (`whereBetween` on `id`, same PK autoindex as `getAllScoped`) followed by an in-JS group-by keyed off the `<deviceId>.<key>` suffix. It intentionally reads rows for devices not asked for — the trade for turning N queries into 1 when the requested ids are not contiguous. It is **optional on the settings-view interface**: a forked addon's view has nothing to batch and `readDeviceConfigs` falls back to the per-device form, `{}` on a throw, never failing the whole listing. Net effect on THIS table: the dominant caller no longer issues 967 seeks, it issues 1 addonId-scoped range scan — the `json_extract(deviceId)` SCAN plan above is unaffected (nothing calls that shape) and remains the worst case if anything ever did.
  Same commit also fixed `scopeOwnerOf` (used by the storage-orchestrator's per-addon reporting) to read the lower bound of a `whereBetween` prefix range, not just `where.id` — it had been blind to every `readDeviceStore`/`readAddonStore` read, which is a prefix range and never an equality, so none of the 9,226-per-minute reads against this table were being attributed to an owner in the report meant to name exactly them.
- **Volume** — per (addon × device × setting key). **[measured]** the addonId distribution is `device-manager` 2,149, `__device-state` 991, `virtual-doorbell` 1, `pipeline-analytics` 1. Scales as devices × addons-that-store-per-device-config. Order 10³ here, 10⁴ on a 100-camera install.
- **Retention** — none. Rows for a deleted device are **[undetermined]** — no cascade was found.
- **Blob→columns** — **YES, the strongest KV case in the database.** `deviceId` is a real predicate on the largest KV table, and it is a full scan. A **generated column is sufficient and is the right instrument**:
  ```sql
  ALTER TABLE "addon-device-settings"
    ADD COLUMN deviceIdG TEXT GENERATED ALWAYS AS (json_extract(data,'$.deviceId')) VIRTUAL;
  CREATE INDEX idx_ads_device ON "addon-device-settings"(deviceIdG);
  ```
  `VIRTUAL` costs nothing on disk and requires **no row rewrite**. Same for `addonId`. Promote to a *stored* column only if a measurement shows the per-row `json_extract` on the index build is the bottleneck — it will not be at 10³–10⁴ rows.
- **Migration risk** — **low, and it can be done fully online.** Adding a `VIRTUAL` generated column is a metadata-only `ALTER TABLE`; existing rows are untouched, no writer changes, readers that do not know about it are unaffected. The one caveat: `ensureTable`'s additive path (`sqlite-settings-backend.ts:815`) would see an undeclared column on the live table and leave it alone — but its *rebuild* path (`:809`) drops the table, so a generated column must be declared in the schema, not bolted on by hand, or the next destructive migration silently discards it.

### 3.4 `addon-devices` — **0 rows** [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:70`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — the per-addon per-device blob written by `ctx.settings.writeDeviceStore`, `packages/system/src/kernel/moleculer/addon-context-factory.ts:637`–`646`. Shape is addon-defined — **[undetermined]** as a closed type; **[measured]** examples exist in the *scoped* variants (§3.10), e.g. `pipeline-analytics:addon-devices` row `101` = `{zoneMembershipMinOverlap, confirmationGateTimeoutMs}`.
- **Queried** — `readBlob`/`writeBlob`/`mergeBlob` in `addon-context-factory.ts:637`, all by PK.
- **Volume** — would be per (addon × device). **Zero, because every real writer is a forked addon and therefore hits the scoped variant.**
- **Retention** — `writeBlob(…, {})` at `addon-context-factory.ts:646` is the clear.
- **Blob→columns** — N/A.
- **Migration risk** — none; empty. **This is the unscoped half of the two-store split that has already caused a live outage** (settings written to a table a forked addon never reads). It is empty because the split resolved in favour of the scoped side. Keep it declared until §5 lands, then it disappears with the split.

### 3.5 `device-runtime-state` — **0 rows** [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:71`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — device runtime-state slices, `addon-context-factory.ts:656`–`662`. **[undetermined]** shape (union of every cap's `runtimeState`).
- **Queried** — PK only, `addon-context-factory.ts:656`.
- **Volume** — would be one row per device.
- **Retention** — `writeBlob(…, {})` `:662`.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Notable finding:** the data this table is named for *is* being persisted — into `addon-device-settings` under the synthetic addonId `__device-state`, 991 rows **[measured]**, e.g. id `__device-state:512.device-status`, value `{online, lastChangedAt}`. So there are two device-runtime-state stores and the named one is the empty one. Resolve during §5; do not drop the table before the writer is redirected. **Done 2026-08-13 ([D131](../decisions/adr-0131.md)):** the writer points here, with a legacy read fallback and a per-device migration, and only slices from a cap declaring `durability: 'restored'` are kept. The row count above is therefore stale by design — this is now the live store.

### 3.6 `sections` — **0 rows** [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:72`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — **[undetermined]**. No writer was found. The name collides with `ConfigUISchema['sections']`, which is an unrelated UI type.
- **Queried** — no call site found outside the canonical list.
- **Volume** — zero, and no writer.
- **Retention** — n/a.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Deletion candidate** (§7.3): a canonical collection with no reader and no writer.

### 3.7 `provider-settings` — **0 rows** [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:73`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — per-provider config, written by `setProvider` `sqlite-settings-backend.ts:602`, read by `getAllProvider` `:597`.
- **Volume** — zero. Provider selection moved to bindings and `setPreference`; nothing writes here any more.
- **Retention** — none.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Deletion candidate**, together with the two `ISettingsStore` methods that serve it.

### 3.8 `device-settings` — **0 rows** [measured]

- **Creation** — canonical KV, `sqlite-settings-backend.ts:74`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`.
- **Blob** — per-device config, `setDevice` `sqlite-settings-backend.ts:612`, `getAllDevice` `:607`.
- **Volume** — zero. Superseded by `addon-device-settings` (§3.3).
- **Retention** — none.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Deletion candidate.**

### 3.9 `alerts` — 2,288 rows / 0.98 MB [measured] — the one KV table with a real growth problem

- **Creation** — canonical KV, `sqlite-settings-backend.ts:75`. Consumer: `packages/system/src/builtins/alerts/alerts.addon.ts:97`.
- **Columns** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`. **No secondary index.**
- **Blob** — fully enumerated **[measured]** and **[source]**: `id`, `category`, `severity`, `title`, `message`, `status`, `read`, `createdAt`, `updatedAt`, `source: {type, id}`, `metadata: Record<string, unknown>`. Avg 378 B, max 1,072 B.
- **Queried** — every predicate is `json_extract` on a table with no secondary index:
  - `listAlerts` `alerts.addon.ts:207` — `where {read:false}` + `orderBy updatedAt desc` + `limit 100`. **[measured]** → **`SCAN alerts` + `USE TEMP B-TREE FOR ORDER BY`**.
  - `getUnreadCount` `alerts.addon.ts:222` — `count` with `where {read:false}` → `SELECT COUNT(*) … WHERE json_extract(data,'$.read') = 0`, full scan.
  - `enforceMaxAlerts` `alerts.addon.ts:620` — `count` then `query {read:true}` ordered by `createdAt` asc.
  - `enforceRetention` `alerts.addon.ts:639` — `query {read:true}` **with no limit** (`:644`), then filters `createdAt < cutoff` **in JS** (`:653`) and deletes row by row.
- **Volume** — per system event. **[measured]** 2,288 rows over a 17.9-day span ≈ **128 rows/day**, dominated by `process.crashed` (676), `agent.online` (435), `device.registered` (216), `agent.offline` (206). ~47 k rows/year for this install; it scales with cluster churn, not with cameras.
- **Retention — present in code, inert in practice.** Both `enforceMaxAlerts` (`:626`) and `enforceRetention` (`:647`) filter on `where {read: true}`. **[measured]** all 2,288 rows have `read = 0` and `status = 'active'`. **Nothing has ever been deleted from this table and nothing will be until an operator marks alerts read.** The 30-day retention and the `maxAlerts` cap are both unreachable.
- **Blob→columns** — **YES.** Three fields are predicated (`read`, `createdAt`, `updatedAt`) and one is a natural facet (`category`). Generated columns + two indexes turn every one of the four queries above from a scan into a seek, with **no row rewrite**:
  ```sql
  ALTER TABLE alerts ADD COLUMN readG      INTEGER GENERATED ALWAYS AS (json_extract(data,'$.read'))      VIRTUAL;
  ALTER TABLE alerts ADD COLUMN createdAtG INTEGER GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) VIRTUAL;
  CREATE INDEX idx_alerts_read_created ON alerts(readG, createdAtG);
  ```
  A *stored* column is not needed: the values are small integers and the table is 2 k rows. **But the schema fix is secondary to the logic fix** — change the retention predicate from `read = true` to `createdAt < cutoff` regardless of read state, or the index makes an inert sweep faster.
- **Migration risk** — **low, online.** No writer changes. The one risk is `ensureTable`'s rebuild path (`sqlite-settings-backend.ts:809`) discarding hand-added columns; declare them in the canonical schema at `:107` instead.

### 3.10 The scoped-variant RULE — `<addonId>:<canonical>`, 51 tables on disk [measured]

This entry is the rule, because the list is not derivable and never will be.

- **Creation** — **on demand, at first write**, `sqlite-settings-backend.ts:145`–`160`. `requireDeclared` sees an undeclared name, splits on the first `:`, and if the suffix is in `CANONICAL_KV_COLLECTIONS` it runs a raw `CREATE TABLE IF NOT EXISTS "<scoped>" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)` (`:150`) and registers it. Anything else throws.
- **Name resolution** — `scopedName(namespace, collection)` `sqlite-settings-backend.ts:707` — `namespace ? \`${namespace}:${collection}\` : collection`. The namespace is the addonId, supplied by `ctx.settings.writeAddonStore` in `packages/system/src/kernel/moleculer/addon-context-factory.ts:536`+ for **forked** addons only.
- **Columns** — always `(id TEXT PK NOT NULL, data TEXT NOT NULL)`. Never anything else: the auto-declare path only fires for canonical suffixes.
- **Blob** — whatever the owning addon writes. **[undetermined]** as a closed type — that is the definition of this mechanism. **[measured]** samples: `recorder:addon-settings` id `root` = `{recordingOpsLog, recordingConfigs}`; `stream-broker:addon-settings` id `root` = `{probeSnapshots, profileMap, rtspTokens}`; `pipeline-orchestrator:addon-devices` id `103` = `{detectionMode, detectionFps, preferredAgent, audioNodeId, pipelineNodeId, webrtcDebug, decoderNodeId, motionMode, motionSources, pipelineDeviceKey}`.
- **Queried** — by PK, through the same `get`/`set`/`query` path as the canonical parents.
- **Volume** — **[measured]** 51 tables: 47 `<addon>:addon-settings` and 4 `<addon>:addon-devices`. Row counts are tiny — **40 of the 51 hold zero rows**, and the non-empty ones are: `detection-pipeline:addon-devices` 266, `pipeline-orchestrator:addon-devices` 8, `pipeline-analytics:addon-devices` 3, and eight single-row `:addon-settings` tables. **[measured]** 265 of the 266 `detection-pipeline:addon-devices` rows contain the literal string `{}`.
- **Retention** — none. A table survives the uninstall of the addon that created it, forever.
- **Blob→columns** — **no**. These are PK-read config blobs. **Amended 2026-08-19 ([D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md)):** two of the rows sampled above were not config at all. `recorder:addon-settings`/`root` had reached **201 833 B** and `stream-broker:addon-settings`/`root` **33 155 B**, because six of their keys held a WORKLOAD that grows with cameras, jobs and events — and every `get()` on ONE key parsed the whole row. Those six are now declared row collections (`recorder:ops-log`, `recorder:exports`, `recorder:recording-configs`, `stream-broker:probe-snapshots`, `stream-broker:rtsp-tokens`, `stream-broker:profile-map`); `recordingPlacement`, `rtspEnabled` and `deviceOverrides` stay blob keys. The entry's rule holds only for a key whose size is bounded by the number of SETTINGS.
- **Migration risk for the ORM — this is the hard case, and it is §5.3.** An ORM types a static schema; this mechanism mints a table at runtime from a string. The resolution is that these tables have **exactly one shape** — `(id, data)` — so they need one typed model parameterised by name, not N models.


### 3.11 Shared mechanics of every `declareCollection` table

Stated once so the 40 entries below do not repeat it. All **[source]**, in
`packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts`:

| Behaviour | Line | Consequence for the map |
| --- | --- | --- |
| `type:'JSON'` → SQLite `TEXT`; `BOOLEAN` → `INTEGER 0/1` | `:734` | the live DDL never shows JSON or BOOLEAN; read it as the declared type |
| Column-type enum is **closed to `TEXT/INTEGER/REAL/JSON/BOOLEAN` — there is no `BLOB`** | `packages/types/src/capabilities/settings-store.cap.ts:38` | a float vector has no binary storage option today (§3.18) |
| Object values are `JSON.stringify`d on bind | `:762` | |
| `insert`/`set`/`update` **silently discard keys that are not declared columns** | `:285`, `:299` | a field in the Zod schema but not in `columns` never reaches disk and never errors (§3.13) |
| `delete` is **by primary key only** | `:307` | every prune in the system is `SELECT page → N × DELETE-by-id` |
| A `filter` field that is not a declared column is **silently dropped** from the WHERE on a structured table | `:420`, `:429` | a predicate on JSON content does not fail — it returns *unfiltered rows* |
| `whereBetween` is **inclusive at both ends** | `:447` | callers hand-shift bounds, e.g. `[0, cutoffMs - 1]` at `packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts:652` |
| **A default row CAP, since 2026-08-08.** An omitted `limit` is capped at `SETTINGS_QUERY_DEFAULT_ROW_CAP` = 2 000, any `limit` at `SETTINGS_QUERY_HARD_ROW_CAP` = 20 000, and every cap hit is a WARN | `query-bounds.ts:72`, `:85` | an omitted limit no longer loads the whole table — it silently TRUNCATES it, which is the hazard D182's `DEVICE_ROWS_FLEET_LIMIT` and D185's `loadLimit` both exist to make loud. §3.18's "loads the entire 86.5 MB table" is no longer reachable |
| ~~`count` honours only `where` equality; `whereIn`/`whereBetween` are ignored~~ **FIXED 2026-08-25** — `count` now compiles the SAME filter language `query` does, via `compileFilter` in `select` mode. | `sqlite-settings-backend.ts:313` pre-fix; now routed through `compileFilter` | it was not slow, it was **wrong, always too big**: `TrackStore.countStaging({ deviceId, olderThanMs })` sent its cutoff as `whereBetween` and got the device's whole staging history back as the count; the notification-centre gallery paged its `total` off the same undercounted-predicate call. Any historical "count vs query disagree" finding sourced to this doc predates the fix. |
| `query` accepts an optional `columns: readonly string` — a real SQL `SELECT` list, not a JS-side drop. **Added 2026-08-25**. The engine **throws** (`UnprojectableColumnError`) rather than silently narrowing when the name is not a column of the collection, the collection is KV-shaped (one `data` blob — nothing to project), or the list is empty. | `sqlite-settings-backend.ts` `resolveProjection` | Projection changes **bytes read**, not the WHERE-clause index usage — none of §2.5's SEARCH/SCAN verdicts changed because of this alone (no new index shipped alongside it). Callers that used to fetch a whole row and drop fields in JS (`TrackStore`'s `slim` projection §3.12, `EventStore`'s motion/object `slim` §3.14–§3.15) were migrated onto real `columns` lists the same day — audio deliberately kept NO column list (`event-store.ts`, `SLIM_MOTION_COLUMNS`/`SLIM_OBJECT_COLUMNS` comment) because `slimAudio` already reads every declared column. |
| Schema evolution: additive `ALTER TABLE … ADD COLUMN`, but a **destructive `DROP TABLE` rebuild** for legacy-KV shapes or a new PK/UNIQUE/NOT-NULL-without-default column | `:784`–`:829` | the docblock records this wiping the entire `tracks` history on 2026-07-17 |

Two stale comments to delete while here: `packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts:66` and
`packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts:28` both state that the backend applies a default 500-row limit. **It does not** (`:460`). One of them is the reason §3.18 is unbounded.

---

### 3.12 `pipeline-analytics:tracks` — 2,176 rows / **16.41 MB** [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts:248`. Name `TRACKS_COLLECTION` (`:134`), columns `:136`, indexes `:174`. Declared from `packages/addon-post-analysis/src/pipeline-analytics/index.ts:1142`.
- **Columns [measured 2026-08-03, PARTIALLY STALE]** — 24 at measurement time: `id` TEXT PK, `deviceId` INTEGER NOT NULL, `className` TEXT NOT NULL, `label`, `firstSeen` INTEGER NOT NULL, `lastSeen` INTEGER NOT NULL, `positions`, `snapshots`, `zonesVisited`, `classes`, `totalDistance` REAL, `state`, `importance` REAL, `bestEventId`, `importanceReason`, `audioLabels`, `envMinX/envMinY/envMaxX/envMaxY` REAL, `frameWidth/frameHeight` INTEGER, `source`, `producingDeviceName`. Indexes `idx_tracks_device_firstSeen`, `idx_tracks_device_lastSeen`.
  **Drift worth recording:** the live column order puts `source`/`producingDeviceName` last, while the declaration has them 5th/6th (`track-store.ts:143`). They arrived by `ALTER TABLE ADD COLUMN`. **An ORM must not bind by ordinal.**
  **Not re-measured against the live DB, but [source]-confirmed additional columns exist that this list predates:** `labelScore`, `labelMeta`, `subLabel`, `subLabelScore`, `subLabelMeta` (tiered-label model, 2026-08-08), `retrainStatus`, `debug` (2026-08-07/08), `favourited`, `hasFace`, `hasEmbeddedFace`, `hasRider`, `closedReason` (2026-08-14/15) — all predate this document's 2026-08-21 `last-verified` and were already missing from this list before the window this pass audits; flagged here rather than silently backfilled since none of it is [measured]. **`observations` INTEGER is the one addition IN this window** — added 2026-08-25, `track-store.ts:432`. It stores `positions.length` at persist time (written from the same array that becomes the blob, same statement, so it cannot disagree with the trajectory it counts) so that `projection: 'slim'` can answer "how many sightings" without fetching the ~9 KB `positions` blob it now genuinely does not read (see §3.11's `columns` row). NULL on rows written before the column; a slim read of a pre-column row reports the field **absent**, never `0`.
- **Blob — five JSON columns, all enumerated [source]:**

  | Column | Fields inside | Schema |
  | --- | --- | --- |
  | `positions` | `[{ x, y, timestamp, bbox:{x,y,w,h} }]` | `packages/types/src/capabilities/pipeline-analytics.cap.ts:139`; bbox `packages/types/src/capabilities/schemas/detection-shared.ts:22` |
  | `snapshots` | `[{ timestamp, position, mediaKey }]` | `packages/types/src/capabilities/pipeline-analytics.cap.ts:146` |
  | `zonesVisited` | `string[]` zone ids | `packages/types/src/capabilities/pipeline-analytics.cap.ts:226` |
  | `classes` | `string[]` detector class names | `packages/types/src/capabilities/pipeline-analytics.cap.ts:230` |
  | `audioLabels` | `[{ label, peakScore, count, firstAt, lastAt }]` | `packages/types/src/capabilities/pipeline-analytics.cap.ts:188` |

  **[measured]** `positions` averages **6,734 B** (max 33,439) — 14.6 MB of the table's 16.4 MB. It is hard-capped at 300 entries with first-half downsampling (`track-store.ts:275`).
- **Queried** — `WHERE deviceId=?` + a range on `firstSeen` or `lastSeen`, ordered desc, limited. Both hit their composite index **[measured]**: `SEARCH … USING idx_tracks_device_lastSeen`. Sites: `queryHistorical` `track-store.ts:650`, `queryRecent`→`fetchRange` `:766`, `listIdsBefore` `:562`, `getPersistedByTrackId` `:858` (PK).
  Two exceptions:
  - **zone-filtered history** runs **two** queries (`track-store.ts:667`) — the envelope-ranged one plus a plain one to recover NULL-envelope rows, because the cap has no `IS NULL`. Then it filters per-position polygon geometry in JS (`rowMatchesZone` `:115`), re-sorts and slices.
  - ~~`listDeviceIds` `track-store.ts:596` pages on `lastSeen` with **no deviceId** → **full scan** (the index leads on `deviceId`).~~ **FIXED 2026-08-25.** It used to drain the table in 501-row pages on a `lastSeen` range with no `deviceId` — **measured** 36 full scans of the (then) 155 MB table to enumerate ~10 dozen distinct device ids, 1,196–1,101 ms per statement, blocking hub-main's one synchronous thread. It is now `histogram` on `deviceId` with `bucketSize: 1` — a `GROUP BY deviceId` the planner serves from the existing composite index: **[measured, on a hub copy]** `SCAN pipeline-analytics:tracks USING COVERING INDEX idx_tracks_device_lastSeen` + `USE TEMP B-TREE FOR GROUP BY`. 678 ms → 6.0 ms, no new index. `collectDeviceIds` is the caller name in both the old and new code.
  - **[measured 2026-08-03]** `ORDER BY lastSeen DESC LIMIT 50` with no device → `SCAN` + `USE TEMP B-TREE FOR ORDER BY`. **The plan verdict itself is unchanged** — the two indexes still lead on `deviceId`, so any `lastSeen`-only query still scans — but as of 2026-08-25 `listDeviceIds` (the caller this row was measuring) no longer issues this shape; see the histogram fix immediately above. Treat this row as "still true if issued", not "still issued".
- **Volume** — **one row per completed track**, written at TTL expiry by `persistCompleted` `track-store.ts:911`, driven by the 5-second closer sweep (`index.ts:4602`). Plus one row per (linked-sensor change × linked camera) from `track-store.ts:876`. **Per track, not per frame.**
- **Retention** — `runTrackRetentionSweep` `index.ts:5807` on a 5-minute timer (`index.ts:1832`). Cutoff is **per device**: default mode `follow-recordings` → `min(earliestFootage, now − 7d)` (`packages/addon-post-analysis/src/pipeline-analytics/retention-policy.ts:83`), `custom` → `now − trackRetentionDays` (default 7, `0` = keep forever). Predicate `lastSeen < cutoff`, expressed as `BETWEEN 0 AND cutoff-1` (`track-store.ts:566`), paged 200, cascading through every leaf store before deleting the root row (`packages/addon-post-analysis/src/pipeline-analytics/pipeline/delete-track-cascade.ts:52`). **[measured]** observed span exactly 7.0 days — it works.
- **Blob→columns** — **the promotion this table needs has already been done.** `envMinX/envMinY/envMaxX/envMaxY` + `frameWidth/frameHeight` are six scalar columns *extracted from `positions` at persist time* (`track-store.ts:163`, computed `:904`, written `:931`) precisely so the zone query can pre-filter in SQL. What remains in JS is exact polygon geometry, which no scalar replaces. **No SQL predicate touches any of the five JSON columns.** Recommendation: **promote nothing further.** If `queryHistorical`'s NULL-envelope double-query is worth removing, add `IS NULL` to the cap filter — that is a cap change, not a schema change.
- **Migration risk** — **medium.** This is the table `ensureTable`'s destructive rebuild already wiped once (`sqlite-settings-backend.ts:790`). Any change here must go through the additive path, and the ORM's migration runner must be tested against the "new NOT NULL column" case, which is exactly what triggers the rebuild.
- **Also found:** `packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts:171` exposes a `maxPositionHistory` slider and `:156` a `trackTtlMs` slider, but `TrackStore` is constructed at `index.ts:1195` **without a config argument**, so `DEFAULT_CONFIG` (`track-store.ts:89`) always wins. **Both knobs are inert.** `observedClassNames` (`track-store.ts:829`) has no production caller and its docblock (`:820`) describes behaviour nothing uses.

### 3.13 `pipeline-analytics:media` — **112,658 rows** / 29.72 MB [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts:175`. Name `:58`, columns `:101`, indexes `:116`. Declared from `index.ts:1143`.
- ~~**Columns [measured]** — 9, all scalar: `id` TEXT PK …~~ **CORRECTED 2026-09-15 [source].** **11 columns**, and the primary key is no longer the composite string: `id` **INTEGER PRIMARY KEY** (a rowid alias SQLite assigns — D482; the TEXT key's `sqlite_autoindex` measured 28.0 MB over 528 559 rows), `deviceId` INTEGER NOT NULL, `ownerKind` TEXT NOT NULL, `ownerId` TEXT NOT NULL, `kind` TEXT NOT NULL, `timestamp` INTEGER NOT NULL, **`slotTs` INTEGER NOT NULL DEFAULT 0**, `path` TEXT NOT NULL, `sizeBytes` INTEGER NOT NULL, `locationId` TEXT, **`provenance` TEXT**. `slotTs` is a derived write-SLOT timestamp (`slotTsFor`, `SINGLE_SLOT_TS`) and is never read as a time: it carries the old key's uniqueness rule as **`idx_media_slot (ownerKind, ownerId, kind, slotTs) UNIQUE`**. Other indexes: `idx_media_owner`, `idx_media_device_ts`, `idx_media_location`, `idx_media_device_size`, `idx_media_kind_device_size`, `idx_media_location_size` — all `media-store.ts` `MEDIA_COLUMNS` / `MEDIA_INDEXES`.
- **Owner kinds [source], CORRECTED 2026-09-15** — `OWNER_KINDS` is now `track | summary | face | identity | plate | vehicle | scene | motion | object | audio | mosaic`. **`event` was RETIRED (D476)**: it covered the motion/object/audio tables at once, which was only safe while event ids were UUIDs; D474 made them per-table rowid aliases, so `event:5` named three different rows. The `ownerKind` distribution measured below is therefore in the retired vocabulary.
- **Blob** — **NONE.** This is the one large table that is already fully relational.
- **Queried** —
  - ~~`getByKey` `:326`~~ **`getById(mediaId: number)` since D482** — PK ✅, and the address names no owner so it can no longer name the wrong owner's row. `getEventMedia` / `listEventMedia` now take a REQUIRED `{ ownerType, eventId: number }`.
  - `listByOwner` `:365` — `WHERE ownerKind=? AND ownerId=? ORDER BY timestamp ASC`, **no LIMIT**. **[measured]** `SEARCH … USING idx_media_owner` ✅, but the sort is not in the index → temp B-tree.
  - `putReplacing` `:256` — `WHERE ownerKind=? AND ownerId=? AND kind=?`; `kind` is a **residual filter**. **[measured]** `WHERE kind=?` alone → **`SCAN`**.
  - `footprintByDevice` `:442` — ~~**no WHERE**, `ORDER BY id ASC LIMIT 1000 OFFSET n`, looped to exhaustion: **113 pages, and SQLite re-walks and discards `n` rows per page — O(n²) over 112 k rows**, on every events-management panel open.~~ **FIXED 2026-08-30 (D316).** By then the table had reached 1 254 576 rows and the walk was timing out at 60 s on every call. Now one `histogram` on `deviceId` for the device set plus one `aggregate` per camera: 216 ms / 31 round trips / **0 rows materialised**, measured at that row count.
  - `evictBefore` `:579` — `WHERE timestamp BETWEEN 0 AND cutoff LIMIT 500`, **no deviceId** → **full scan per page** (the index leads on `deviceId`).
  - Hottest surface: the HTTP event-media data plane issues 1–3 `listByOwner` **per image byte served** (`index.ts:5900`, `:5907`, `:5928`).
- **Volume — the 112 k answer.** `SINGLE_INSTANCE_KINDS` (`media-store.ts:88`) — `keyFrame, keyFrameSmall, thumbnail, thumbnailSmall, firstFrame, lastFrame` — use a deterministic id `ownerKind:ownerId:kind` and upsert, so they are **exactly one row per (owner, kind) forever**. Everything else accumulates. The generator is the **periodic `snapshot`**: one row per `snapshotIntervalMs` (default **5,000 ms**, `packages/addon-post-analysis/src/pipeline-analytics/media-settings.ts:21`) per *active* track while `saveThumbnails` is on (default true, `:17`), written at `packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts:609`. So: **~6 fixed rows per track + one row per 5-second tick per active track + one row per event child crop.** Not per frame.
  **[measured]** kind distribution: `crop` 18,643 / `fullFrameBoxed` 18,476 / `fullFrame` 18,476 / `firstFrame` 15,415 / `snapshot` 13,830 / `thumbnail` 7,184 / `lastFrame` 7,115 / `keyFrame` 6,644 (**7.1 GB on disk**) / `thumbnailSmall` 2,846 / `keyFrameSmall` 2,814 / `faceCrop` 1,210. `ownerKind`: `event` 56,638, `track` 55,903, `face` 79, `plate` 18, `identity` 15.
- **Retention — two paths.** (a) **Owner lockstep**, the primary: `deleteForEvents` `media-store.ts:537` from `index.ts:4739`, and folded into `EventStore.deleteByTracks` (`event-store.ts:752`) so a caller cannot skip it. It never touches `ownerKind:'identity'`/`'vehicle'` (`media-store.ts:546`) — enrolled crops are reowned at assignment. (b) **Age backstop**: `index.ts:4744` → `evictBefore(minObjectCutoffMs − 1 day)`, where the cutoff is the **fleet minimum** (`index.ts:4685`), deliberately the loosest bound so a long-retention camera never loses a live reference. That loose bound is why 112 k media rows outlive 2,176 tracks. **[measured]** span 31.0 days.
- **Blob→columns** — **N/A, no blob.** The two schema actions that matter here are not blob promotions:
  1. **Index `(ownerKind, ownerId, kind)`** — `kind` is a residual predicate at `media-store.ts:259` and a JS `.filter` at the facade. This is the single highest-value index in the database, because `listByOwner` is on the image data plane.
  2. ~~**`SUM`/`GROUP BY` on the cap**~~ — **DONE 2026-08-30 (D316)**, without `GROUP BY`: `aggregate` (`SUM`/`MIN`/`MAX`) shipped separately, and the device set comes from `histogram(deviceId, bucketSize: 1)`, which IS a `GROUP BY` over an integer column. Two covering indexes were added for it — `idx_media_device_size (deviceId, sizeBytes)` and `idx_media_kind_device_size (kind, deviceId, sizeBytes)` — because `sizeBytes` must be IN the index or the sum reads the table row behind every entry it visits. A true `groupBy` on `aggregate` is still absent, which is why a per-(camera × kind) breakdown is not offered.
- **Migration risk** — **low.** Adding an index is online (`CREATE INDEX` takes a write lock for the build; at 112 k rows that is sub-second). No writer changes. `evictBefore` gaining a `deviceId` argument is a two-line caller change.

### 3.14 `pipeline-analytics:object-events` — 10,637 rows / 2.20 MB [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts:150`. Name `:24`, columns `OBJECT_COLUMNS` `:48`, indexes spread from `COMMON_INDEXES` `:75` plus an inline `idx_object_track` `:153`. Declared from `index.ts:1144`.
- ~~**Columns [measured]** — 15: `id` TEXT PK …~~ **CORRECTED 2026-09-15 [source].** **22 columns**, `OBJECT_COLUMNS` = `COMMON_BASE_COLUMNS` + 19: `id` **INTEGER PRIMARY KEY** (rowid alias, D474 — the primary-key index ceases to exist), `deviceId` INTEGER NOT NULL, `timestamp` INTEGER NOT NULL, `source`, **`frameId`**, **`idempotencyKey`**, `trackId` TEXT NOT NULL, `className` TEXT NOT NULL, `label`, **`labelScore`**, **`labelMeta`**, **`subLabel`**, **`subLabelScore`**, **`subLabelMeta`**, `confidence` REAL NOT NULL, `bbox`, `zones`, `state`, `frameWidth`, `frameHeight`, **`mediaId` INTEGER** (was `mediaKey`), `importance` REAL. Indexes `idx_object_device_ts`, `idx_object_track`.
- **Blob** — `bbox` = `{x,y,w,h}` (`packages/types/src/capabilities/pipeline-analytics.cap.ts:359` → `packages/types/src/capabilities/schemas/detection-shared.ts:22`); `zones` = `string[]` zone ids (`packages/types/src/capabilities/pipeline-analytics.cap.ts:361`).
- **⚠ Schema fields that are declared and NEVER persisted.** **PARTLY FIXED — corrected 2026-09-15.** `frameId` **is now a declared column** (its docblock records that it had been written into the void on every row ever persisted). `ObjectEventSchema` still declares **`zoneCrossing`**, `keyFrameMediaKey` and `mediaUrl` with no column to land in, so the zone enter/exit direction below still never reaches disk. The backend drops unknown keys silently. The backend drops unknown keys silently (`sqlite-settings-backend.ts:285`). **So the zone enter/exit direction computed at `packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts:696` never reaches disk**, and the `data['frameId']` read at `event-store.ts:791` can never fire. This is exactly the failure mode gap **G6** describes: a silent field drop with no schema feedback.
- **Queried** — `buildFilter` `event-store.ts:214` → `WHERE deviceId=? [AND timestamp BETWEEN ? AND ?] ORDER BY timestamp DESC [LIMIT]`, served by `idx_object_device_ts` **[measured]** ✅. Variants: `+ className=?` (`:246`) — **residual, no index**; `queryObjectSince` `:278` — **no deviceId** → **[measured]** `SCAN` + temp sort; `peakForTrack` `:423` and the three `*ForTrack` updaters (`:348`, `:378`, `:480`) — `WHERE trackId=?` ✅; `getTrackIdForEvent` `:325` — PK, once per event-media HTTP request; `countForDevice` `:508`; `densityByKind` `:532` (the `histogram` cap method).
  - **The N+1.** `getKeyEvents` `index.ts:5399` pulls up to 500 tracks then calls `peakForTrack` **per track** (`:5421`) — up to 500 extra queries per call. The admin Detection-Intelligence feed polls it every 30 s per selected camera (`packages/addon-admin-ui/src/components/detection-intelligence/use-key-events-feed.ts:51`).
  - **Unbounded per-event query.** `packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:159` and `:207` query `{deviceId, className:'package'}` with **no time window and no limit**, on every stationary promotion/departure. It grows with the device's entire package history.
- **Volume** — one row **per emitted state transition**, not per detection: `insertObject` `event-store.ts:185`, driven from `index.ts:2616` per processed frame but gated by the frame-processor's transition logic. **[measured]** 10,637 rows over 19.8 days ≈ 537/day across the fleet.
- **Retention** — ~~per-device cutoff, `retentionObjectDays` default 30~~ **CORRECTED 2026-09-15: that setting does not exist.** [D62](../decisions/adr-0062.md) collapsed the four per-family windows into **ONE window per device** (`retentionMode: follow-recordings` by default, else `trackRetentionDays`, default 7), and object events are **TRACK-OWNED** — they have no clock of their own and go only when their track goes, through `deleteByTracks`; a row whose track is already gone is collected by OWNERSHIP (`retention/orphan-audit.ts`), never by age. `sweepRetention` `index.ts` still runs on the 5-minute timer. `evictBefore` `event-store.ts:590` — `WHERE deviceId=? AND timestamp BETWEEN 0 AND cutoff LIMIT 500`, paged, then `deleteForEvents` on the media in lockstep (`index.ts:4739`). Track cascade adds `deleteByTracks` `event-store.ts:740`.
- **Blob→columns** — **`className` is the answer, and it is already a column.** It is a real predicate (`event-store.ts:248`) and it is in **no index**. The action is `CREATE INDEX idx_object_device_class_ts ON "pipeline-analytics:object-events"(deviceId, className, timestamp)`, which also serves the package-drop query.
  For the JSON: `bbox` is parsed in JS twice per row in the N+1 (`event-store.ts:443` degenerate-bbox skip, `:833` `bboxAreaFrac`). A **stored** `bboxAreaFrac REAL` computed at insert would let `peakForTrack` stop parsing JSON entirely — but that is a write-path change, and the N+1 itself (gap **G3**: no `MAX()` aggregate) is the larger win. **Do the index and the aggregate first; measure before promoting `bboxAreaFrac`.**
  A **generated** column is *not* available for `bbox` fields here — `bbox` is nullable and the useful expression is a ratio of two extracts, which SQLite can express but which cannot be indexed usefully without also indexing the null case. Prefer the stored column if it is needed at all.
- **Migration risk** — **low for the index** (online). **Medium for `bboxAreaFrac`**: it is a new column, nullable, so it takes `ensureTable`'s additive path; historical rows get NULL and every reader must tolerate that. Do not make it NOT NULL — that triggers the destructive rebuild.

### 3.15 `pipeline-analytics:motion-events` — **101,059 rows** / 6.53 MB [measured]

- **Creation** — S3 tRPC, `event-store.ts:145`. Columns `MOTION_COLUMNS` `:40`, indexes `COMMON_INDEXES('motion')` `:75`.
- ~~**Columns [measured]** — 7: `id` TEXT PK …~~ **CORRECTED 2026-09-15 [source].** **9 columns**: `id` **INTEGER PRIMARY KEY** (rowid alias, D474), `deviceId` INTEGER NOT NULL, `timestamp` INTEGER NOT NULL, `regionCount` INTEGER NOT NULL, `regions` JSON, `frameWidth`, `frameHeight`, **`durationMs` INTEGER** and **`edges` TEXT** (both D475 — see Volume). Index `idx_motion_device_ts`.
- **Blob** — `regions` = `[{ bbox:{x,y,w,h}, pixelCount, intensity }]` (`packages/types/src/capabilities/pipeline-analytics.cap.ts:273`). **[measured]** average length **3 bytes**, max 300 — i.e. essentially every row stores the literal `[]`, and `regionCount` carries the real information.
- **Queried** — `queryMotion` `event-store.ts:227` — `WHERE deviceId=? [AND timestamp BETWEEN ? AND ?] ORDER BY timestamp DESC` ✅ index. `densityByKind` `:532`. `evictBefore` `:104` ✅.
- **Volume** — ~~≤ 1 row / 5 s / actively-moving device~~ **CORRECTED 2026-09-15: one row per motion EPISODE (D475).** `MOTION_EVENT_HEARTBEAT_MS` is **gone**. `MotionEpisodeTracker`, keyed per **(deviceId, source)** so the analyzer and a firmware/device-activity sensor on the same camera never share an episode, INSERTs on a rising edge with no episode open (`durationMs: null`, `edges: [0]`), extends an open episode in memory rather than inserting, and closes it `MOTION_CLOSE_AFTER_MS` (15 s) after the last relevant movement with ONE UPDATE writing the final `durationMs` and the encoded edge offsets. Only an **explicit** `durationMs` NULL means open; an absent value is a pre-D475 row. The measured 101,059 rows over 14.0 days ≈ 7,200/day is therefore a **pre-episode** rate and an upper bound on today's.
- **Retention** — ~~per-device, `retentionMotionDays` default 14~~ **CORRECTED 2026-09-15: that setting does not exist** ([D62](../decisions/adr-0062.md), predating this pass). A motion row is a **TERMINAL age-keyed root** — it has no `trackId` — deleted by `EventStore.evictTracklessBefore` on the device's ONE window (the follow-recordings horizon, else `trackRetentionDays`, default 7), which folds in `MediaStore.deleteForEvents` so the row's still leaves with it. `0` days = keep forever, and this table is the reason that setting is dangerous. The **[measured]** 14.0-day span is from the retired four-window scheme.
- **Blob→columns** — **the recommendation is the opposite of promotion: consider dropping the blob.** `regions` is never a predicate, is never read in any query path found, and **[measured]** holds 3 bytes in the overwhelming majority of rows. Before spending anything here, establish whether any consumer reads `regions` at all; if not, the 101 k-row table loses a column and the write path loses a `JSON.stringify`. **[undetermined]** — no reader of `regions` was located, but "no reader found" is not "no reader", and the motion-regions overlay shipped recently. **Verify before removing.**
- **Migration risk** — dropping a column is `ALTER TABLE … DROP COLUMN` (SQLite ≥3.35) and is **not** on `ensureTable`'s additive path, so it would take the destructive rebuild — a full 101 k-row copy. Not worth it for 0.3 MB. If `regions` is confirmed dead, stop *writing* it and leave the column.

### 3.16 `pipeline-analytics:audio-events` — 59,136 rows / 4.29 MB [measured]

- **Creation** — S3 tRPC, `event-store.ts:158`. Columns `AUDIO_COLUMNS` `:68`.
- **Columns [measured]** — 6, but **`id` is an INTEGER PRIMARY KEY rowid alias since D474, not a TEXT PK** (corrected 2026-09-15): `id`, `deviceId` INTEGER NOT NULL, `timestamp` INTEGER NOT NULL, `rms` REAL NOT NULL, `dbfs` REAL NOT NULL, `classification` JSON. Index `idx_audio_device_ts`.
- **Blob** — `classification` = `{ className, originalClass?, score }` (`packages/types/src/capabilities/pipeline-analytics.cap.ts:396`). Declared `type:'JSON'` at `event-store.ts:72` although it is a flat three-field object.
- **Queried** — `queryAudio` `event-store.ts:299` ✅ index; `densityByKind`; `evictBefore` ✅.
  **Changed 2026-09-10** ([D431](../decisions/adr-0431-the-audio-lane-shows-a-level-and-the-hub-computes-it.md)): `densityByKind` no longer reads this table through `histogram` alone. It ALSO runs one `queryAudio` (`projection: 'slim'`) over the same window to compute the per-bucket energy-weighted mean dBFS — the timeline's audio lane needs a LEVEL, and a histogram can only count. So the read profile for this table went from an aggregate to an indexed range scan of the window's rows, once per density call. At the measured ≈8,450 rows/day and a 7-day retention this is a bounded scan, but it is the one read here that grows with the window the operator opens. A failure is caught and yields no level rather than failing the density call.
- **Volume** — **episode-bounded since 2026-08-17**, not heartbeat-bounded: one row per classified EPISODE, written by `persistClassifiedAudio` (`packages/addon-post-analysis/src/pipeline-analytics/index.ts`) → `insertAudio` `event-store.ts:197`. The 5-second heartbeat survives only on the `audioEpisodeEnabled: false` route (`persistClassifiedAudioUngrouped` — class change, then one row per `AUDIO_EVENT_HEARTBEAT_MS = 5_000`); the rolling-window level path is a second, unchanged caller of `insertAudio`. **[measured 2026-08-03, PRE-episode]** 59,136 rows over 7.0 days ≈ 8,450/day — an upper bound on today's rate.
- **Retention** — ~~per-device, `retentionAudioDays` default 7~~ **CORRECTED 2026-09-15: that setting does not exist** ([D62](../decisions/adr-0062.md), predating this pass). Like motion-events this is a **TERMINAL age-keyed root**, swept by `EventStore.evictTracklessBefore` on the device's ONE window; without that clock it would be immortal. The **[measured]** 7.0-day span is from the retired four-window scheme.
- **Blob→columns** — **YES, and this one is cheap and clearly right.** `classification` is a flat object with a fixed three-field shape and no nesting. It should be **three real columns** (`className TEXT`, `originalClass TEXT`, `score REAL`) rather than a generated column, because (a) the shape is closed and typed, (b) "audio events of class X" is an obvious future predicate that today cannot even be expressed (it would be silently dropped, `sqlite-settings-backend.ts:429`), and (c) it removes a `JSON.parse` from 59 k rows on every read. A generated column would work too, but promoting a closed 3-field object into columns is what the schema is *for*.
- **Migration risk** — **low, online.** Three nullable columns take the additive `ALTER TABLE ADD COLUMN` path (`sqlite-settings-backend.ts:824`). Historical rows keep the blob and get NULL in the new columns; the reader must fall back to the blob for rows older than the migration, or a one-time backfill `UPDATE … SET className = json_extract(classification,'$.className')` runs online in seconds at 59 k rows. **Writers to change: one** (`event-store.ts:197`).

### 3.17 `pipeline-analytics:sensor-events` — 184 rows [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/sensor-event-store.ts:62`. Name `:17`, columns `:19`, indexes `:32`. Declared from `index.ts:1145`.
- **Columns [measured]** — 6: `id` TEXT PK, `deviceId` INTEGER NOT NULL, `sourceDeviceId` INTEGER NOT NULL, `kind` TEXT NOT NULL, `value`, `timestamp` INTEGER NOT NULL. Index `idx_sensor_events_device_ts`.
- **Blob** — `value` is **schema-open by contract**: `z.record(z.string(), z.unknown()).nullable()` at `packages/types/src/capabilities/pipeline-analytics.cap.ts:132`. The concrete shape is the `runtimeState` of whichever sensor cap fired — one per entry in `CAP_TO_KIND`, `packages/types/src/capabilities/sensor-event-kinds.ts:62`: contact, motion, smoke, flood, gas, carbon-monoxide, vibration, tamper, presence, enum-sensor, event-emitter, lock-control, switch, button, doorbell. Examples **[source]**: contact → `{entryOpen, lastChangedAt}` (`packages/types/src/capabilities/contact.cap.ts:17`); motion → `{detected, lastDetectedAt, autoClearAfterMs}` (`packages/types/src/capabilities/motion.cap.ts:19`); doorbell → `{lastPressedAt, pressCountSinceStart}` (`packages/types/src/capabilities/doorbell.cap.ts:28`). **As a single closed type: UNDETERMINED** — no union is declared anywhere.
- **Queried** — one reader: `sensor-event-store.ts:96` — `WHERE deviceId=? [AND timestamp BETWEEN ? AND ?] [AND kind IN (…)] ORDER BY timestamp DESC LIMIT ?` (default 1000, `:49`) ✅ index, `kind` residual. `evictBefore` `:122` has **no deviceId** → full scan per page.
- **Volume** — **one row per (sensor state change × linked camera)** — a sensor linked to N cameras writes N rows, deliberately, so a per-camera timeline stays one indexed range scan (`sensor-event-store.ts:1`). Insert `:72` from `packages/addon-post-analysis/src/pipeline-analytics/services/event-kinds.ts:296`.
- **Retention** — `index.ts:4748` → `evictBefore(minObjectCutoffMs)`, the **fleet minimum**, not per-device.
- **Blob→columns** — **no.** `value` is a genuine discriminated union keyed on `kind`, and it is never a predicate. This is the one table where **JSON is the right answer** and should stay. `kind` is already a column, is filtered with `whereIn` (`:105`), and is not in the index — `(deviceId, kind, timestamp)` would cover it, but at 184 rows that is theoretical.
- **Migration risk** — none contemplated.

### 3.18 `pipeline-analytics:object-embeddings` — 7,375 rows / **86.50 MB — the largest object in the database** [measured]

> **SUPERSEDED 2026-08-06 — this table no longer exists.** Its findings were
> acted on: the vectors moved to the `vector-store` capability, stored as base64
> Float32LE instead of a JSON `number[]`, with the prefilter columns promoted and
> indexed. The in-process ranker this section names (`embedding-search.ts`) was
> deleted with it — the cosine now runs in the provider. Line references below
> point at code that has changed or gone; they are kept because the MEASUREMENTS
> are the record of why the change happened.
>
> **Amended later the same day.** The capability first shipped as its own addon,
> which was then folded into `sqlite-settings` and the standalone package
> deleted; its deployed copy survived on the hub and served the SAME singleton
> alongside the builtin, from a second set of tables. See the commit for
> `scripts/check-registered-caps-declared.ts`. The provider today is
> `packages/system/src/builtins/sqlite-storage/vector-index-vec.ts`, and the
> tables are `vec_indexes` / `vec_<index>` — NOT the `vector-store:<index>`
> tables the previous backend wrote, which are legacy and hold nothing current.


- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts:82`. Name `:28`, columns `:30`; **indexes are an inline array literal at `:85`** — the only one of the analytics tables not hoisted to a const, and therefore the one a grep for `*_INDEXES` misses. Declared from `index.ts:1150`.
- **Columns [measured]** — 11: `id` TEXT PK, `deviceId` INTEGER NOT NULL, `trackId` TEXT NOT NULL, `timestamp` INTEGER NOT NULL, `className` TEXT NOT NULL, `embedding` TEXT NOT NULL, `modelId` TEXT NOT NULL, `dim` INTEGER NOT NULL, `confidence` REAL NOT NULL, `mediaKey`, `keyFrameMediaKey`. Indexes `idx_obj_emb_device_ts`, `idx_obj_emb_track`.
- **Blob** — `embedding` is **not an object**: a bare `readonly number[]`, an L2-normalised CLIP image vector (`object-embedding-store.ts:36`, type `:50`). **[measured]** average length **10,816 bytes**, max 10,955 — 79.8 MB of the 86.5 MB. **[source]** `dim` is stamped as `embedding.length` at `:129` and is **always 512**: every model declares `embeddingDim: 512` (`packages/addon-post-analysis/src/embedding-encoder/addon/clip-models.ts:13`, `:20`, `:27` <!-- drift-ok: a 2026-08-03 snapshot; the file became the per-model registry `shared/clip/clip-model-registry.ts` under D649 -->). So 512 JS float64s printed as decimal text ≈ 11 KB/row — an exact match for the measurement. `dim` never discriminates; the real same-model gate is `modelId`.
- **Queried** — `query` `object-embedding-store.ts:174` — `WHERE [deviceId=?][className=?][modelId=?] [AND timestamp BETWEEN ? AND ?] [LIMIT]`, **no ORDER BY**. `upsertIfBetter` pre-read `:109` (PK ✅). `pruneAll` `:201` — **no deviceId** → full scan per page. `deleteByTracks` `:238` (PK ✅, because `id` *is* the trackId).
  - **The finding.** The only production caller of `query()` is `searchObjectEvents` at `index.ts:5508`. **[source, verified]** it passes `deviceId`, `since`, `until`, `className` — and **neither `limit` nor `modelId`**, although the store supports both (`:164`, `:172`). The backend emits `LIMIT` only when the filter carries one (`sqlite-settings-backend.ts:460`) and applies **no default**. The admin search UI sends no `since`/`until` (`packages/addon-admin-ui/src/components/detection-intelligence/SemanticEventSearch.tsx:119`). **A default semantic search therefore loads the entire 86.5 MB table**, `JSON.parse`s 7,375 float arrays (`sqlite-settings-backend.ts:183`), ships them over the settings-store tRPC client, and ranks in JS (`packages/addon-post-analysis/src/pipeline-analytics/pipeline/embedding-search.ts:49` — since deleted <!-- drift-ok: superseded, see the banner in 3.18 -->), allocating a `Float32Array` per row (`:64`). It then runs a **second** scan of up to 5,000 object events per winning device (`index.ts:5573`). **[measured]** `EXPLAIN QUERY PLAN` for `WHERE className=? AND timestamp>?` → `SCAN`.
  - Minor: `cosineSimilarity` (`packages/types/src/utils/cosine-similarity.ts:2`) recomputes both norms per call even though the vectors are L2-normalised at write (`packages/addon-post-analysis/src/embedding-encoder/addon/index.ts:92`). A dot product would do.
- **Volume** — `id = trackId`, so **exactly one row per track**, upserted only when confidence improves (`object-embedding-store.ts:116` short-circuits). Drivers `index.ts:3815` and `:3956`.
- **Retention** — `index.ts:4796` → `pruneAll(minObjectCutoffMs)` — **fleet minimum**, `timestamp ≤ cutoff`, paged 500 — plus the track cascade (`object-embedding-store.ts:238`, registered at `index.ts:5651`). **[measured]** span 19.2 days.
- **Blob→columns** — **a vector can never be a predicate, so promotion is not the instrument.** Three things are, in order of value:
  1. **Bound the query.** Pass `limit` and `modelId` from `index.ts:5508`. One-line change, removes the unbounded scan. **Do this regardless of any ORM.**
  2. **Stop storing float64 decimal text.** 512 float32 values are **2,048 bytes** packed. Base64 they are 2,732 B — a **4× reduction, 86.5 MB → ~22 MB.** The packed form *already exists on the wire*: `DetailResult.embedding` is base64 little-endian f32, unpacked by `decodeEmbeddingBase64` at `index.ts:453` immediately **before** being persisted as JSON. The write path expands a compact representation into a verbose one.
     **This is blocked on the cap.** The column-type enum has **no `BLOB`** (`packages/types/src/capabilities/settings-store.cap.ts:38`, `packages/types/src/interfaces/storage.ts:263`), so today the only options are a base64 `TEXT` column (4× win, available immediately, no cap change) or adding `BLOB` to the enum (8× win, a cap change + codegen).
  3. **`IEmbeddingsBackend` / `IVectorIndex` is declared and has zero implementations** — `packages/types/src/interfaces/storage.ts:291`–`:360`, wired into the capability map at `packages/types/src/interfaces/capability.ts:259`. No sqlite-vec, hnswlib, usearch or Qdrant anywhere in the repo. **This is a leftover that describes the right design and reads as verification** — either implement it or delete it; leaving it is the failure mode the working-style rules name.
- **Migration risk** — **medium-high, and it is the only table where the migration is not free.** Changing `embedding` from decimal-JSON to base64-f32 is a value-format change on 7,375 rows: it needs a backfill, and readers must handle both formats during it (or a `format` column, or a new column written alongside). It **can** be done online — write both, read new-with-fallback, backfill, drop the old — but it is a four-step migration and is exactly the case that proves the phase-2 requirement for **an ordered, recorded, replayable migration list**. Today there is no `schema_version` (**[measured]** `user_version = 0`) and no mechanism to express it.

### 3.19 `pipeline-analytics:ops-log` — 9,678 rows / 1.44 MB [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/ops-log-store.ts:82`. Name `:24`, columns `:26`, indexes `:41`. Declared from `index.ts:1152`.
- **Columns [measured]** — 11: `id` TEXT PK, `at` INTEGER NOT NULL, `domain` TEXT NOT NULL, `op` TEXT NOT NULL, `reason` TEXT NOT NULL, `deviceId` INTEGER, `nodeId` TEXT NOT NULL, `itemsAffected` INTEGER NOT NULL, `bytesReclaimed` INTEGER NOT NULL, `detail`, `actor` TEXT NOT NULL. Indexes `idx_opslog_at`, `idx_opslog_device_at`.
- **Blob** — **NONE.** `detail` is declared `type:'TEXT'` (`ops-log-store.ts:37`) and typed `z.string().nullable()` (`packages/types/src/interfaces/ops-log.ts:50`) — **free-text prose, not JSON**. **[measured]** e.g. `"age sweep (follow-recordings): 3 motion, 1 object, 0 audio"`.
- **Queried** — one reader: `list` `ops-log-store.ts:126` — `[WHERE deviceId=?] ORDER BY at DESC LIMIT ?` (default 200, `packages/types/src/interfaces/ops-log.ts:72`). **[measured]** without deviceId → `SCAN … USING idx_opslog_at` (index-ordered, no temp sort); with → `idx_opslog_device_at` ✅. Cap method is admin-only.
- **Volume** — per **management operation**, appended best-effort (`ops-log-store.ts:114` swallows the error so a failed audit never fails the audited op). Sites: retention sweep per device (`index.ts:4711`), track cascade per device (`index.ts:5818`), relocate job (`index.ts:1252`). ≈ a handful per 5-minute sweep; **[measured]** 9,678 rows over 4.7 days ≈ **2,060/day**.
- **Retention — NONE.** `grep` over `ops-log-store.ts` finds no `prune`, `evict` or `delete` of any kind. `OPS_LOG_RING_DEFAULT_MAX = 500` (`packages/types/src/interfaces/ops-log.ts:69`) applies only to the *recorder's* in-memory ring, which the store's own docblock says explicitly (`ops-log-store.ts:4`). **This table grows without bound at ~2,000 rows/day ≈ 750 k rows/year.** It is currently 1.4 MB; in a year it is ~110 MB and the `list` query still works, so it will not announce itself.
- **Blob→columns** — **N/A.** The action is a **retention rule**, not a schema change: `DELETE FROM … WHERE at < ?`, which today needs gap **G1** (bulk delete) or a 750 k-iteration drain loop.
- **Migration risk** — none. Note `domain` is the constant `'events'` for every row this store writes (`ops-log-store.ts:98`), so it is a column with one value.


### 3.20 `pipeline-analytics:faces` — 89 rows / 1.05 MB [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts:106`. Name `:19`, columns `:21`, indexes `:48`.
- **Columns [measured]** — 15: `id` TEXT PK, `deviceId`, `trackId`, `timestamp`, `embedding`, `mediaKey`, `recognizedIdentityId`, `assigned` INTEGER NOT NULL, `assignedSampleId`, `keyFrameMediaKey`, `faceBbox`, `bestMatchScore` REAL, `nativeFaceShortSidePx` REAL, `suggestedIdentityId`, `suggestedMatchScore` REAL. Indexes `idx_faces_device_ts`, `idx_faces_track`.
- **Blob** — `embedding` is a bare `readonly number[]` face vector (`face-store.ts:58`), **[measured]** avg **10,772 B** — the same decimal-float64-as-text problem as §3.18, at 1/90th the row count. `faceBbox` = `{x,y,w,h}` (`face-store.ts:66`).
- **Queried** — `listAllRecentFaces` `face-store.ts:426` — `ORDER BY timestamp DESC`, **no LIMIT** (deliberate, `:422`; the limit is applied in JS at `:474`) → **full scan + filesort**. `pruneAll` `:236` — same shape. `deleteByTracks` `:320` — `WHERE trackId=?` ✅. `get` `:358` — PK ✅. **[measured]** `WHERE assigned=0 ORDER BY timestamp DESC` → `SCAN` + `TEMP B-TREE`.
  `listRecentFaces` `:142` (device-scoped, ✅ index) and `prune` `:196` are **dead code — their only callers are `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`.** They are also the only two readers that would use `idx_faces_device_ts` in a scoped way. Do not port them without deciding whether `listAllRecentFaces` was *meant* to be device-scoped.
- **Volume** — **one row per track that produced a confident face crop**, id `face-${trackId}` (`packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts:601`), written by upsert (`face-store.ts:120`) so a re-emitting track replaces its row rather than appending.
- **Retention** — `pruneAll` from `index.ts:4763` on the 5-minute sweep. Rule is an OR of two bounds per device: `timestamp < now − bufferRetentionDays` (default 3) **or** index ≥ `bufferMaxPerDevice` (default 50) in newest-first order (`face-store.ts:258`; defaults `packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts:70`). **`assigned` rows are exempt** (`:244`). Plus the track cascade (`:320`).
- **Blob→columns** — **no promotion from the blob** (`embedding` and `faceBbox` are never predicates; all matching is JS over an in-RAM gallery, `face-recognizer.ts:201`). **But `assigned` is an existing column that is the hottest filter in the file and never appears in a WHERE** — it is filtered in JS at `face-store.ts:182`, `:204`, `:244`, `:326`, `:466`. Pushing `assigned` into the `pruneAll` and `listAllRecentFaces` predicates, plus an index on `(assigned, timestamp)`, turns two full scans into seeks. **This is the cheapest correct change on this table and it needs no schema migration at all** — only a filter the cap already supports.
- **Migration risk** — none for the filter change. The base64-f32 argument from §3.18 applies here too but the payoff is 0.9 MB; do it only as a by-product of the same migration.

### 3.21 `pipeline-analytics:identities` — 4 rows [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts:80`. Declares `indexes: []` explicitly (`:83`).
- **Columns [measured]** — 6: `id` TEXT PK, `name` TEXT NOT NULL, `createdAt`, `updatedAt`, `sampleCount` INTEGER NOT NULL, `coverMediaKey`. **No secondary index.**
- **Blob** — **NONE.**
- **Queried** — `listIdentities` `identity-store.ts:137` — `ORDER BY createdAt ASC`, no WHERE, no LIMIT → **full scan + filesort**. It is re-run inside **every** `addSample` (`:175`) and **every** `removeSample` (`:223`) purely to read one row's `sampleCount` — a full scan where a PK `get` would do. `packages/addon-post-analysis/src/pipeline-analytics/face-gallery-provider.ts:91` then calls `listSamples` **inside a loop over every identity** (N+1).
- **Volume** — one row per operator-created person.
- **Retention** — none; operator `deleteIdentity` cascade only (`identity-store.ts:126`, `:133`). `coverMediaKey` HEALS since 2026-08-21: `removeSample` promotes a surviving sample's media to cover (or clears it), and `addSample` overwrites a stale cover left behind by a full sample cleanup.
- **Blob→columns** — N/A. The fix is a `get`-by-PK instead of a list, and a `GROUP BY` for the N+1 (gap **G3**).
- **Migration risk** — none.

### 3.22 `pipeline-analytics:identity-samples` — 15 rows / 0.18 MB [measured]

- **Creation** — S3 tRPC, `identity-store.ts:85`.
- **Columns [measured]** — 9: `id` TEXT PK, `identityId` TEXT NOT NULL, `embedding`, `mediaKey`, `source` TEXT NOT NULL, `deviceId`, `modelId` TEXT NOT NULL, `dim` INTEGER NOT NULL, `addedAt` INTEGER NOT NULL. Index `idx_sample_identity`.
- **Blob** — `embedding`, a bare `readonly number[]` (`identity-store.ts:56`). Same format as §3.18/§3.20.
- **Queried** — `listSamples` `identity-store.ts:205` — `WHERE identityId=? ORDER BY addedAt ASC` ✅ index + filesort. `loadGallery` `:239` — `filter: {}` → bare `SELECT *`, **full scan by design**, to hydrate the matcher.
- **Volume** — one row per enrolled face (operator assign or photo upload).
- **Retention** — **none by AGE, deliberately.** `packages/addon-post-analysis/src/pipeline-analytics/pipeline/delete-track-cascade.ts:13` documents that enrolled embeddings are never touched by retention. Since 2026-08-21 there is ONE non-age collector ([D207](../decisions/adr-0207-a-gallery-reference-without-a-blob-is-a-deleted-reference.md)): the boot gallery reconcile (`retention/gallery-reconcile.ts`) removes a sample whose `mediaKey` blob is gone from the filesystem — row or file — through the operator's own `removeSample` path (blobs, row, cover heal). Bounded: grace window, abort on probe error, per-run reclaim ceiling; keyless rows are counted, never touched.
- **Blob→columns** — **no.** `modelId`/`dim` are already columns and are filtered in **JS** at `identity-store.ts:246` — push those into the `loadGallery` WHERE, which the cap already supports.
- **Migration risk** — none.

### 3.23 `pipeline-analytics:plates` — 21 rows [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/plate-store.ts:85`. Name `:19`, columns `:21`, indexes `:42`.
- **Columns [measured]** — 13: `id` TEXT PK, `deviceId`, `trackId`, `timestamp`, `text` TEXT NOT NULL, `score` REAL NOT NULL, `mediaKey`, `corrected` INTEGER NOT NULL, `recognizedVehicleId`, `assigned` INTEGER NOT NULL, `assignedSampleId`, `keyFrameMediaKey`, `plateBbox`. Indexes `idx_plates_device_ts`, `idx_plates_track`.
- **Blob** — `plateBbox` = `{x,y,w,h}` (`plate-store.ts:62`). Nothing else.
- **Queried** — `listRecentPlates` `plate-store.ts:135` (device-scoped ✅ index, default limit 200); `listAllRecentPlates` `:148` — callers pass no limit (`packages/addon-post-analysis/src/pipeline-analytics/plate-gallery-provider.ts:151`, `:176`, `:252`) → **full scan + filesort**; `get` `:159` PK ✅; `deleteByTracks` `:221` ✅; `pruneAll` `:251` full scan.
- **Volume** — one row per track that produced an OCR read, id `plate-${trackId}`, upserted (`plate-store.ts:96`).
- **Retention** — `pruneAll` from `index.ts:4780`, same 5-minute sweep and same `bufferRetentionDays`/`bufferMaxPerDevice` constants as faces. Exemption is **wider**: both `corrected` and `assigned` rows are skipped (`plate-store.ts:265`).
- **Blob→columns** — `plateBbox` is never a predicate. Same finding as faces: **`assigned` and `corrected` are existing columns never used in a WHERE** (`plate-store.ts:227`, `:265`). Plate *text* matching is JS Levenshtein against an in-RAM gallery (`packages/addon-post-analysis/src/notification-center/rule-engine.ts:808`), which SQL cannot do anyway — leave it.
- **Migration risk** — none.

### 3.24 `pipeline-analytics:vehicles` — **0 rows** / `pipeline-analytics:vehicle-samples` — **0 rows** [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/store/vehicle-store.ts:94` and `:99`. `vehicles` declares `indexes: []` (`:97`).
- **Columns [measured]** — `vehicles`: 6 (`id` PK, `name`, `createdAt`, `updatedAt`, `sampleCount`, `coverMediaKey`), no index. `vehicle-samples`: 8 (`id` PK, `vehicleId` NOT NULL, `text` NOT NULL, `score` REAL NOT NULL, `sourcePlateId`, `mediaKey`, `deviceId`, `addedAt` NOT NULL), index `idx_vehicle_sample`.
- **Blob** — **NONE on either.** A plate sample is self-labelling `text`+`score`, so no embedding is needed (`vehicle-store.ts:8`).
- **Queried** — `listVehicles` `:149` full scan + filesort; `listSamples` `:197` ✅ index; `loadGallery` `:227` full scan by design. Same N+1 as identities (`:177`, `:216`).
- **Volume** — one row per operator-created vehicle / per enrolled plate read. **Zero: LPR enrolment has never been exercised on this install.**
- **Retention** — none; operator-only.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Not** a deletion candidate: the writers are live and reachable (`vehicle-store.ts:116`, `:173`), the feature simply has not been used.

### 3.25 `pipeline-analytics:stationary-objects` — 2 rows [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts:111`. Name `:37`, columns `:39`, indexes `:54` — all exported.
- **Columns [measured]** — 12: `id` TEXT PK, `deviceId` INTEGER NOT NULL, `className` TEXT NOT NULL, `bbox`, `frameWidth`, `frameHeight`, `firstSeenAt`, `becameStationaryAt`, `lastConfirmedAt`, `sourceTrackId`, `label`, `keyFrameMediaKey`. Index `idx_stationary_device`.
- **Blob** — `bbox` = `{x,y,w,h}`, written at `stationary-registry.ts:346`, read field-by-field at `:380`.
- **Queried** — **exactly one query in the whole file**: `load()` `stationary-registry.ts:122` — `SELECT * LIMIT 100000`, no WHERE, no ORDER BY → **full scan**, once at boot (`index.ts:1236`). Every other read is the in-RAM `byDevice` map, including the per-frame gate (`:183`). **`idx_stationary_device` is never used by any query.**
- **Volume** — one row per promoted parked object (`index.ts:4963` → `stationary-registry.ts:232`).
- **Retention** — four deleters, all `deletePersisted` `:359`: TTL sweep on unconfirmed observed-time (`:267`, driven by the same 5-minute timer), the object moved (`:226`), operator wipe (`:314`), and a **self-heal on hydrate** that purges an implausible near-full-frame box (`:130`).
- **Blob→columns** — **no.** `bbox` *is* used in a predicate — but in JS, per frame, as IoU geometry (`:196`), which SQL cannot express. This table is a RAM registry with a backing file.
- **Migration risk** — none.

---

### 3.26 `notification-center:outbox` — 90 rows / 0.07 MB [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/notification-center/outbox.ts:245`. Name `:33`, columns `:37`, indexes `:54`. Declared from `packages/addon-post-analysis/src/notification-center/index.ts:301`.
- **Columns [measured]** — 14: `id` TEXT PK, `ruleId` NOT NULL, `targetId` NOT NULL, `deviceId` INTEGER NOT NULL, `recordKind` NOT NULL, `recordId` NOT NULL, `trackId`, `status` NOT NULL, `attempts` INTEGER NOT NULL, `nextAttemptAt` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `lastError`, `payload` TEXT NOT NULL. Indexes `idx_nc_outbox_created (createdAt)`, `idx_nc_outbox_status (status, nextAttemptAt)`.
- **Blob — `payload`, fully enumerated [source]** from `NcOutboxPayload` at `outbox.ts:99`–`:141`: `ruleName`, `delivery` (`immediate|track-end|device-event|package-event`), `priority`, `template?{title?,body?}`, `media` (`best|best-matching|keyFrame|none`), `mediaZoneIds?`, `mediaFrame?` (`cropped|full|boxed`), `mediaGif?`, `mediaClip?`, `mediaProfile?`, `mediaClipPreRollSec?`, `mediaClipPostRollSec?`, `matchedOn?`, `params?`, and `subject:{deviceId, trackId?, eventId?, className, label?, confidence?, zones[], timestamp, occupancy?}` where `occupancy` is `{zone?, count, capacity, occupied}` (`outbox.ts:91`). **[measured]** avg 387 B.
- **Queried** — `load()` `outbox.ts:259` and `queryRecentPersisted` `:359` — `WHERE createdAt BETWEEN ? AND ?` ✅ `idx_nc_outbox_created`. `queryHistory` `:397` — `[ruleId=?][deviceId=?][status=?][createdAt BETWEEN]` `ORDER BY createdAt DESC LIMIT ?`; the range+order is served, but **`ruleId` and `deviceId` are residual and unindexed**.
  **`idx_nc_outbox_status` is never used by any query** — the drain loop does not touch SQL at all, it filters the in-RAM `pending` map (`outbox.ts:339`) on a 2-second tick (`packages/addon-post-analysis/src/notification-center/index.ts:326`). **[measured]** the index exists and the query plan that would use it has no caller.
- **Volume** — one row per **(matched rule × delivery target × triggering record)**. Enqueue `index.ts:688` → `outbox.ts:290` → upsert `:537`. The PK **is** the dedup key `${ruleId}:${trackId ?? recordId}:${targetId}` (`outbox.ts:209`) — that is the durable `maxPerTrack:1` guarantee. Each delivery attempt then issues an `update` (`:545`).
- **Retention — present, and it runs exactly once, at boot.** `pruneBefore` `outbox.ts:458`: `SELECT WHERE createdAt BETWEEN 0 AND cutoff LIMIT 5000`, then deletes only rows whose `status` is `sent` or `dead` — **and the status test is in JS after the fetch** (`:469`), not in the WHERE. Sole caller `packages/addon-post-analysis/src/notification-center/index.ts:323`, inside `start()`, with a 7-day window (`:132`). **There is no timer**, and the 5,000-row batch is not looped. A hub up longer than 7 days accumulates terminal rows until the next restart. **[measured]** 90 rows: 48 `sent`, 42 `dead`, **0 pending** — every row in the table is terminal and eligible for deletion, and none has been deleted.
- **Blob→columns** — **no promotion needed from `payload`**; nothing inside it reaches a SQL predicate and the dispatcher consumes it whole. The **inverse** is the finding: `nextAttemptAt` is a column with an index and no query, while `ruleId` and `deviceId` *are* queried and have none. Action: **replace `idx_nc_outbox_status` with `(deviceId, createdAt)` and `(ruleId, createdAt)`** — or, better, delete `idx_nc_outbox_status` only after deciding whether the RAM drain should become a SQL drain (it should, for crash-restart correctness).
- **Migration risk** — index swap is online and needs no writer change. The retention fix (move `status` into the WHERE, add a timer) is a code change with no schema impact.

### 3.27 `notification-center:meta` — 1 row [measured]

- **Creation** — S3 tRPC, `outbox.ts:250`. Declared with **no `indexes` key at all** (`:250`).
- **Columns [measured]** — 2: `id` TEXT PK, `value` TEXT **nullable**. The only declared table whose non-PK column is nullable-by-omission.
- **Blob** — `value` = `{ ts: number }`. **[measured]** the single row is `id='watermark'`, `value='{"ts":1785755261328}'`. Written at `outbox.ts:447`, read at `:436`.
- **Queried** — PK `get` and PK upsert. Nothing else.
- **Volume** — **one row, permanently.** A singleton scalar in a table.
- **Retention** — n/a.
- **Blob→columns** — **no**, but note this table exists because there is nowhere else to put a scalar. An ORM should model it as a typed key-value singleton, not as an entity.
- **Migration risk** — none.

### 3.28 `notification-center:rules` — 4 rows [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/notification-center/rule-store.ts:68`. Name `:27`, columns `:29`, indexes `:40`.
- **Columns [measured]** — 6: `id` TEXT PK, `name` TEXT NOT NULL, `enabled` INTEGER NOT NULL, `delivery` TEXT NOT NULL, `updatedAt` INTEGER NOT NULL, `rule` TEXT NOT NULL. Index `idx_nc_rules_enabled`. The declaration's own comment (`rule-store.ts:36`) calls `name`/`enabled`/`delivery`/`updatedAt` "indexed projections only" of the blob — **the rule is stored twice**, whole in `rule` and projected into four scalars, by one upsert (`:210`).
- **Blob — `rule`, the whole rule definition, fully enumerated [source]** from `NcRuleSchema` at `packages/types/src/capabilities/notification-rules.cap.ts:430` extending `NcRuleInputSchema` `:379`:
  `name`, `enabled`, `delivery`, `conditions`, `schedule?{windows[{days,startMinute,endMinute}], timezone?, invert?}`, `targets[{targetId, params?}]`, `targetUsers?`, `media{attach, frame?, zoneCrop?, gif?, clip?, clipPreRollSec?, clipPostRollSec?, profile?}`, `throttle{cooldownSec, scope, granularity?}`, `template?{title?,body?}`, `priority`, `ownerUserId?`, plus `id`, `createdBy`, `createdAt`, `updatedAt`, `disabledTargetIds`.
  `conditions` (`packages/types/src/capabilities/notification-rules.cap.ts:149`): `devices?`, `classes?`, `classesExclude?`, `minConfidence?`, `zones?{ids,match}`, `zonesExclude?`, `crossing?`, `labelEquals?`, `identities?`, `plates?{values,maxDistance}`, `identitiesExclude?`, `minImportance?`, `minDwellSeconds?`, `source?`, `minLabelConfidence?`, `eventTypeTokens?`, `sensorKinds?`, `packagePhase?`, `customZones?`, `occupancy?{zoneId?,className?,op,count,sustainSeconds}`.
  **[measured]** avg 524 B, max 566 B.
- **Queried** — **exactly one query**: `load()` `rule-store.ts:83` — `SELECT * LIMIT 10000`, no WHERE, no ORDER BY → full scan, at boot (`packages/addon-post-analysis/src/notification-center/index.ts:315`) and every 30 s (`:329`). A row failing `NcRuleSchema.safeParse` is silently skipped (`rule-store.ts:91`). **`idx_nc_rules_enabled` is never used.** Every other read is the in-RAM `byId` map.
- **Is the rule matched in SQL or in JS?** — **entirely in JS, in memory.** The matcher is `evaluateRule` at `packages/addon-post-analysis/src/notification-center/rule-engine.ts:521`, called from `packages/addon-post-analysis/src/notification-center/index.ts:632`; the candidate set is narrowed by `listEnabled(delivery)`, which is a **JS filter over the cached map** (`rule-store.ts:110`), not a query.
- **Volume** — one row per operator-authored rule. Order 10⁰–10¹.
- **Retention** — none; operator `delete` only (`rule-store.ts:197`).
- **Blob→columns** — **NO. Explicitly recommend against it, and against the four projections that already exist.** The rule is loaded whole, evaluated in JS, and cached; SQL is never asked a question about it. The four projection columns cost a double write and buy nothing (their index is unused). The one blob field that *is* predicated — `ownerUserId`, at `rule-store.ts:127` — is predicated **in JS over 4 cached rows**. **This is the table that proves "JSON stays where JSON is the right answer".**
- **Migration risk** — none contemplated. If the projections are ever removed, note they are NOT NULL, so removing them is `ensureTable`'s **destructive rebuild** path — on a table whose rows are the operator's notification configuration. Do not.

### 3.29 `notification-center:timelapse-rules` — **0 rows** [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/notification-center/timelapse/timelapse-store.ts:102`.
- **Columns [measured]** — 5: `id` TEXT PK, `name` NOT NULL, `enabled` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `rule` TEXT NOT NULL. Index `idx_nc_timelapse_rules_enabled` (unused).
- **Blob — `rule` [source]** = `TimelapseRuleSchema`, `packages/types/src/notification/timelapse-rule.ts:106` extending `:53`: `name`, `enabled`, `deviceIds` (min 1), `schedule` (**required**, unlike `NcRule`), `cadenceSec` (2–3600, default 15), `framerate` (1–60, default 10), `targets` (min 1), `template?`, `priority`, plus `id`, `ownerUserId?`, `lastGeneratedAt?`, `createdBy`, `createdAt`, `updatedAt`.
- **Queried** — one: `load()` `timelapse-store.ts:117` — `SELECT * LIMIT 10000`, full scan.
- **Volume — zero, and structurally unreachable.** **[source]** `TimelapseStore` is `new`-ed only in `packages/addon-post-analysis/src/notification-center/timelapse/__tests__/timelapse-store.spec.ts`. The sole production reference is the static `TimelapseStore.declare(store)` at `packages/addon-post-analysis/src/notification-center/index.ts:305`. No scheduler instantiates it. **The table exists because `declare` creates it; nothing on the running hub can write to it.**
- **Retention** — none; `delete` only (`:253`).
- **Blob→columns** — N/A.
- **Migration risk** — none. **Deletion candidate**, but the *right* action is to finish or remove the feature — a declared-but-unreachable store is the "leftover that describes the right design" failure mode, and a bare `DROP TABLE` would leave the dead store class behind.

### 3.30 `notification-center:occupancy` — **0 rows** [measured]

- **Creation** — S3 tRPC, `packages/addon-post-analysis/src/notification-center/occupancy-store.ts:75`.
- **Columns [measured]** — 6: **`key` TEXT PRIMARY KEY** (the only table in the system with a non-`id` PK), `deviceId` INTEGER NOT NULL, `confirmedCount` INTEGER NOT NULL, `occupied` INTEGER NOT NULL, `lastChangeAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL. Index `idx_nc_occupancy_device` (unused).
- **Blob** — **NONE.** But the inverse problem, documented at `occupancy-store.ts:26`: `zoneId`, `className` and `threshold` are **encoded inside the `key` PK** and re-derived by `parseOccupancyKey` (`packages/addon-post-analysis/src/notification-center/occupancy-watcher.ts:86`). Grammar `deviceId|zoneId|className|t<threshold>`; a legacy 3-segment key is rejected and the row skipped (`:88`).
- **Queried** — one: `load()` `occupancy-store.ts:91` — `SELECT * LIMIT 100000`, no WHERE → full scan, at boot only (`packages/addon-post-analysis/src/notification-center/index.ts:930`).
- **Volume** — one row per watched `(deviceId, zoneId, className, threshold)` **on a confirmed boolean occupancy flip only** — rare by design. Zero because no enabled rule carries a `conditions.occupancy` block; the watched set is derived from rules at `packages/addon-post-analysis/src/notification-center/index.ts:914`.
- **Retention** — `pruneExcept(activeKeys)` `occupancy-store.ts:140`, at boot and every 30 s. It iterates `this.cache`, so it can only delete rows the process has loaded.
- **Blob→columns** — **the promotion here is out of the composite PK, not out of a blob.** Splitting `key` into `deviceId`/`zoneId`/`className`/`threshold` columns is the change an ORM would want anyway (a composite key it can type), and it is what would make `idx_nc_occupancy_device` meaningful.
- **Migration risk** — **low today (0 rows), high if deferred.** Changing a PK is `ensureTable`'s destructive path. Do it while the table is empty.

### 3.31 `notification-targets` — 1 row [measured]

- **Creation** — **S2 positional port**, `packages/addon-notifiers/src/target-store.ts:83`, forwarded to tRPC at `packages/addon-notifiers/src/settings-store-port.ts:32`. Name is `this.collection`, which **[source]** always resolves to the literal `'notification-targets'` (§1.2).
- **Columns [measured]** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`. The declaration supplies only `[{name:'data', type:'TEXT', notNull:true}]` (`target-store.ts:35`); the backend contributes the `id` PK (`sqlite-settings-backend.ts:722`), and the single `data` column is what routes this table through the KV branch (`:406`). **No secondary index.**
- **Blob — `data`, enumerated [source]** by `targetToData` `target-store.ts:60`: `name`, `kind`, `addonId`, `enabled`, `config`. Validated on read by `TargetSchema` (`packages/types/src/capabilities/notification-output.cap.ts:203`). **`config` is an open `Record<string, unknown>`** (`:209`) holding per-backend credentials — its inner shape is **UNDETERMINED** as a fixed field set, by design. **[measured]** the live row: `{name:'Zentik', kind:'zentik', addonId:'notifiers', enabled:true, config:{authMode, ownerUserId, magicCode}}`.
- **Queried** — **there is exactly one read primitive and it takes no filter.** `SettingsStorePort.query(collection)` (`target-store.ts:45`) is implemented as `settingsStore.query.query({ collection })` with **no `filter` argument** (`packages/addon-notifiers/src/settings-store-port.ts:16`). So every read is a bare `SELECT id, data` — full scan, no WHERE, no ORDER BY, no LIMIT:
  - `list()` `:87`; `getById(id)` `:97` — **full scan then `.find(r => r.id === id)` in JS**, i.e. a primary-key lookup done as a table scan; `upsert` `:104` — full scan to decide insert-vs-update; `setEnabled` `:120` — **two full scans per toggle**.
- **Volume** — one row per operator-configured notification destination. Order 10⁰–10¹.
- **Retention** — none; operator `delete` (`:115`).
- **Blob→columns** — **this is the clearest generated-column case after `alerts`, and the *port*, not the schema, is the blocker.** Fields inside `data` that are predicated (all in JS): `enabled` (`target-store.ts:119`), `kind`, `addonId`, and a genuine **nested** one — `config.ownerUserId`, filtered at `packages/addon-post-analysis/src/pipeline-analytics/index.ts:1132` on the notification user-fan-out path.
  The backend would already serve `json_extract("data",'$.enabled') = ?` on this table today (KV shape, `sqlite-settings-backend.ts:422`) — **the port simply never passes a filter.** So the correct sequence is: **fix the port first (free), and only then consider a generated column** (which at 1–10 rows will never pay for itself). Recorded here because the *pattern* is what matters: a KV table whose predicates are invisible because the caller cannot express them.
- **Migration risk** — none.

### 3.32 `ha-notification-targets` — **0 rows** [measured]

- **Creation** — **S2 positional port**, `packages/addon-provider-homeassistant/src/ha-notification-output.ts:314`, forwarded at `:373`. `this.collection` always resolves to `'ha-notification-targets'` (§1.2).
- **Columns [measured]** — `(id TEXT PK NOT NULL, data TEXT NOT NULL)`, same KV shape (`ha-notification-output.ts:270`). No index.
- **Blob** — byte-identical field set to §3.31 (`name`, `kind`, `addonId`, `enabled`, `config`), a deliberate local copy because addons may not cross-import (`ha-notification-output.ts:13`). Here `config` **is** enumerable, because the kind declares its own schema: `service` (`:64`) and `brokerId` (`:75`), read at `:456`.
- **Queried** — same filterless port (`:276`, impl `:357`) → every read is a full scan; `getById` `:328` is again a scan + JS `.find`.
- **Volume** — one row per HA notify target. Zero: none has ever been created. Note there is also a memory-only fallback port when no `api` is wired (`:383`), so the addon works with no table at all.
- **Retention** — none.
- **Blob→columns** — same as §3.31; not worth it at this volume. **Fix the port.**
- **Migration risk** — none.


### 3.33 `users` — 1 row [measured]

- **Creation** — S3 tRPC, `packages/system/src/builtins/local-auth/auth-schema.ts:115`; columns `:42`. **Not raw DDL** (§1.3). No declared index.
- **Columns [measured]** — 9: `id` TEXT PK, `username` TEXT NOT NULL **UNIQUE**, `passwordHash` TEXT NOT NULL, `isAdmin` INTEGER NOT NULL, `allowedProviders`, `allowedDevices`, `scopes`, `createdAt` NOT NULL, `updatedAt` NOT NULL. `isAdmin` is `INTEGER` because `BOOLEAN` → `INTEGER` (`sqlite-settings-backend.ts:734`).
- **Blob — three JSON columns [source]**, `packages/types/src/schemas/auth-records.ts`:
  - `allowedProviders` = `'*' | string[]` (`:57`) — not an object, no field names.
  - `allowedDevices` = `Record<string, '*' | string[]>` (`:58`), keys are arbitrary provider ids — **field names UNDETERMINED by design**.
  - `scopes` = `TokenScope[]` (`:63`), a discriminated union on `type`: `{type:'category', target:'device'|'system', access}` | `{type:'capability', target, access}` | `{type:'addon', target, access}` | `{type:'device', targets[], access}`, where `access` is `('view'|'create'|'delete')[]` (`:33`).
- **Queried** — `packages/system/src/auth/user-manager.ts:73` `where {username}` → served by the UNIQUE autoindex; `:82` `where {id}` → PK; `:98` `listAll()` — **unfiltered full scan**, no ORDER BY, no LIMIT.
- **Volume** — per user. Order 10⁰–10². Boot writes: `ensureAdminExists` `user-manager.ts:131` **re-hashes and rewrites the admin row on every boot if the configured password diverges** (`:141`). *(Superseded 2026-10-06 by D728: the configured password seeds an empty table only; an existing row is rewritten only on the one-shot `RESET_ADMIN_PASSWORD` trigger.)*
- **Retention** — explicit `delete(id)` `:117` only.
- **Blob→columns** — **no.** All three JSON columns are authorization payloads read whole with the row; none is a predicate. `isAdmin` is already a scalar column.
- **Migration risk** — **the highest-consequence table in the database for a schema change.** `username` is UNIQUE, so adding or altering it takes `ensureTable`'s **destructive rebuild** (`sqlite-settings-backend.ts:809`) — losing this table locks everyone out. `user_totp` was split off precisely to avoid that (`auth-schema.ts:27`). Any ORM migration must be tested against this table first.

### 3.34 `api_keys` — **0 rows** [measured]

- **Creation** — S3 tRPC, `auth-schema.ts:119`, with `idx_api_keys_token_prefix`.
- **Columns [measured]** — 9: `id` TEXT PK, `label` NOT NULL, `isAdmin` INTEGER NOT NULL, `tokenHash` TEXT NOT NULL **UNIQUE**, `tokenPrefix` TEXT NOT NULL, `allowedProviders`, `allowedDevices`, `createdAt` NOT NULL, `lastUsedAt`.
- **Blob** — `allowedProviders` / `allowedDevices`, same shapes as §3.33 (`packages/types/src/schemas/auth-records.ts:116`).
- **Queried** — `packages/system/src/auth/api-key-manager.ts:58` `validateToken` does an **unfiltered full scan and then bcrypt-compares every row in a JS loop** (`:59`); `:75` `listAll` full scan; `:88` `where {id}` PK. **`idx_api_keys_token_prefix` is never used by any query — `tokenPrefix` is written and never read.** Dead index. <!-- drift-ok: api-key-manager was deleted with the legacy API keys (D817); kept as the record of what was measured -->
- **Volume** — per minted key. Plus **one `update` per successful authentication** (`:63`, `lastUsedAt`) — a hot-path write.
- **Retention** — `revoke(id)` `:84`. **The table has no expiry field at all.**
- **Blob→columns** — **no promotion from the blob**, but the *right* fix is visible: `validateToken`'s O(n) bcrypt loop exists because nothing narrows by `tokenPrefix` first. Using the index that already exists — `WHERE tokenPrefix = ?` before the bcrypt compare — is a one-line change that makes the scan a seek. At 0 rows it does not matter; at 100 keys it is 100 bcrypt rounds per request.
- **Migration risk** — `tokenHash` is UNIQUE → destructive rebuild on change. Same caution as §3.33.

### 3.35 `scoped_tokens` — 27 rows [measured]

- **Creation** — S3 tRPC, `auth-schema.ts:124`, with `idx_scoped_tokens_user_id`.
- **Columns [measured]** — 9: `id` TEXT PK, `userId` NOT NULL, `name` NOT NULL, `tokenHash` TEXT NOT NULL **UNIQUE**, `tokenPrefix` NOT NULL, `scopes`, `expiresAt`, `lastUsedAt`, `createdAt` NOT NULL.
- **Blob** — `scopes` = `TokenScope[]` (`packages/types/src/schemas/auth-records.ts:131`), same union as §3.33.
- **Queried** — `packages/system/src/auth/scoped-token-manager.ts:52` <!-- drift-ok: removed by D895; the table map records what was measured --> `where {tokenHash}` → UNIQUE autoindex ✅ (this is how a token lookup *should* work, and §3.34 does not); `:95` `where {userId}` → `idx_scoped_tokens_user_id` ✅ — **the one auth index that earns its keep**; `:103` `where {id}` PK; `:132` unfiltered full scan at boot.
- **Volume** — per minted token. Plus a **read-modify-write of the whole row on every token use** (`updateLastUsed` `:102`, fired from `validate` `:65`) — three SQL statements per authenticated call.
- **Retention — expired rows are never reaped.** `validate` returns `null` past `expiresAt` (`:59`) and **leaves the row in place forever**. The only deletes are `revoke` (`:91`) and `cleanupOrphans` (`:131`), which runs once at boot (`packages/system/src/builtins/local-auth/local-auth.addon.ts:135`) and deletes on an *ownership* rule (`userId === 'system'`, or the user no longer exists) — **never on expiry**.
- **Blob→columns** — **no.** `expiresAt` is already a column and is the missing predicate: `DELETE FROM scoped_tokens WHERE expiresAt IS NOT NULL AND expiresAt < ?` is the reaper, and it needs gap **G1** (bulk delete by filter) and gap **G4** (`<` comparison) — neither of which the cap can express today. That is why the reaper does not exist.
- **Migration risk** — `tokenHash` UNIQUE → destructive rebuild on change.

### 3.36 `oauth_sessions` — **0 rows** [measured]

- **Creation** — S3 tRPC, `auth-schema.ts:133`, with `idx_oauth_sessions_user_id`.
- **Columns [measured]** — 8: `id` TEXT PK, `userId` NOT NULL, `username` NOT NULL, `integrationId` NOT NULL, `scopes`, `createdAt` NOT NULL, `lastUsedAt` NOT NULL, `revokedAt`.
- **Blob** — `scopes`, typed only as `TokenScope[]` in a hand-rolled interface (`packages/system/src/builtins/local-auth/oauth-session-manager.ts:23`); `parseSession` does an `Array.isArray` check and a cast (`:51`) — **this is the one auth table with no Zod validation on read**.
- **Queried** — `oauth-session-manager.ts:100` `list()` unfiltered full scan; `:111` `where {id}` PK. **Nothing ever queries by `userId`, so `idx_oauth_sessions_user_id` is a dead index.**
- **Volume** — per OAuth account link (`packages/system/src/builtins/local-auth/oauth-grants.ts:121`), plus a full read-modify-write on `touch` per token use (`:141`).
- **Retention — nothing ever deletes a row.** `OauthSessionManager` has no delete method at all; `markRevoked` only stamps `revokedAt` (`:132`). **Revoked sessions accumulate permanently.** Zero rows today only because no account has been linked.
- **Blob→columns** — **no.** The finding is again a missing reaper, not a missing column: `revokedAt IS NOT NULL AND revokedAt < ?` needs **G1** + **G4**.
- **Migration risk** — low; no UNIQUE columns beyond the PK.

### 3.37 `user_totp` — 1 row [measured]

- **Creation** — S3 tRPC, `auth-schema.ts:129`, columns `:74`. **Deliberately split off `users`** to dodge the destructive rebuild (`auth-schema.ts:27`) — a design decision worth preserving in any ORM schema.
- **Columns [measured]** — 4: **`userId` TEXT PRIMARY KEY**, `secret` TEXT NOT NULL, `confirmedAt`, `createdAt` NOT NULL. No secondary index (and none needed — the PK *is* the lookup key).
- **Blob** — **NONE.**
- **Queried** — `packages/system/src/auth/totp-manager.ts:171` `where {userId}` → PK ✅.
- **Volume** — one row per user who enrols. `setup` is delete+insert (`:104`), `confirm` an update (`:126`).
- **Retention** — `disable(userId)` deletes (`:139`). **No cascade when a user is deleted** — `UserManager.delete` (`packages/system/src/auth/user-manager.ts:117`) does not touch this table. Orphan TOTP secrets are possible.
- **Blob→columns** — N/A.
- **Migration risk** — none; the PK is already the natural key.

### 3.38 `user_passkeys` — 1 row / `user_passkey_prefs` — **0 rows** [measured]

- **Creation** — S3 tRPC, `packages/addon-auth/src/webauthn/passkey-store.ts:68` and `:73`; columns `:45` and `:30`.
- **Columns [measured]** — `user_passkeys` (8): **`credentialId` TEXT PRIMARY KEY**, `userId` NOT NULL, `publicKey` NOT NULL, `counter` INTEGER NOT NULL, `transports`, `label` NOT NULL, `createdAt` NOT NULL, `lastUsedAt`; index `idx_user_passkeys_user_id`. `user_passkey_prefs` (3): **`userId` TEXT PRIMARY KEY**, `secondFactorEnabled` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL.
- **Blob** — `transports` is declared `JSON` (`passkey-store.ts:50`) and typed `readonly string[]` (`:61`); read with an `Array.isArray` check and a cast (`:99`) — **no schema**. The docblock names the expected *values* (`internal | usb | nfc | ble`, `:14`), not field names. Not an object.
- **Queried** — `passkey-store.ts:117` `where {credentialId}` → PK ✅; `:126` `where {userId}` → `idx_user_passkeys_user_id` ✅ (**used** — unlike §3.34/§3.36); prefs `:157` PK ✅.
- **Volume** — one row per registered credential. `updateCounter` (`:133`) is a **read-then-full-row-write on every successful WebAuthn assertion**. Prefs: one row per user who opts in; zero because passkey-as-2FA defaults off — a missing row reads as `false` (`packages/addon-auth/src/webauthn/passkey-store.ts`, `getSecondFactorPreference`).
- **Retention** — `delete(credentialId)` `:145` only. **No cascade from user deletion.** Prefs rows are never deleted.
- **Blob→columns** — **no.** `transports` is a small opaque array read with the row.
- **Migration risk** — low. Both tables use a natural PK, which is what an ORM wants.

---

### 3.39 `integrations` — 7 rows [measured]

- **Creation** — **`ensureTable`**, `packages/system/src/builtins/sqlite-storage/integration-registry.ts:105`; schema `:47`. Fired from `server/backend/src/core/addon/addon-registry.service.ts:2627` when `settings-store` registers.
  **Note, corrected:** `ensureTable` was the only path that supported `defaultValue` when this was written. `declareCollection` has carried it since 2026-08-03 (`packages/types/src/capabilities/settings-store.cap.ts:66`) — which is exactly what unblocked §5.4 step 2. §5.2, §5.4 step 1 and §7.3 still describe it as the missing piece.
- **Columns [measured]** — 7: `id` TEXT PK, `addon_id` TEXT NOT NULL, `name` TEXT NOT NULL, `enabled` INTEGER NOT NULL DEFAULT 1, `info` TEXT NOT NULL DEFAULT '{}', `created_at` NOT NULL, `updated_at` NOT NULL. Index `idx_integrations_addon`. **[measured]** this is the only column-naming convention in the database that is `snake_case`; every `declareCollection` table is `camelCase`.
- **Blob** — `info` is `Readonly<Record<string, unknown>>` (`packages/types/src/interfaces/integration-registry.ts:8`), cap-declared `z.record(z.string(), z.unknown())` (`packages/types/src/capabilities/integrations.cap.ts:28`). The only documentation of contents is a source comment (`{ icon, color, discoveryMode, … }`). **[source]** in practice it is **always `'{}'`**: the sole live create path (`packages/addon-admin-ui/src/components/integrations/IntegrationWizard.tsx:190`) passes only `{addonId, name, settings}`, and `createIntegration` writes `JSON.stringify(input.info ?? {})` (`integration-registry.ts:142`). Field names **UNDETERMINED** (open record); contents empty.
- **Queried** — `tableGet {id}` `:163` PK ✅; `tableGet {addon_id}` `:168` → `idx_integrations_addon` ✅; `tableQuery orderBy created_at asc` `:174` → **full scan + filesort, no index on `created_at`**; boot counter-resume `:112` → PK.
- **Volume** — one row per operator-created integration. Order 10⁰–10¹.
- **Retention** — `deleteIntegration` cascades integration settings → the row. **Changed 2026-08-19 ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)):** there is no device cascade any more, because the registry has no device children; the live cascade is `deviceManager.removeByIntegration`, called from `integrations.delete`.
- **Blob→columns** — **no.** `info` is empty in practice and never predicated.
- **Migration risk** — low. The naming mismatch (`snake_case` vs `camelCase`) is a **cosmetic hazard for a typed ORM**: it will need per-table column mappings for exactly these seven tables. Worth normalising while volumes are 7 rows, not later.

### 3.40 `integration_settings` — 5 rows [measured]

- **Creation** — `ensureTable`, `integration-registry.ts:106`; schema `:60`.
- **Columns [measured]** — 4: `integration_id` TEXT NOT NULL, `key` TEXT NOT NULL, `value` TEXT NOT NULL, `value_type` TEXT NOT NULL DEFAULT 'string'. **No primary key. No index of any kind.**
- **Blob** — `value` is TEXT with a **sidecar discriminator** `value_type` ∈ `string|number|boolean|json` (`serializeSetting` `:12`, `deserializeSetting` `:19`). Not a fixed-shape blob — it is a hand-rolled variant type.
- **Queried** — `tableQuery({where:{integration_id}})` `:209`. **[measured]** → **`SCAN integration_settings`** (there is no index). `tableDelete({integration_id, key})` `:223` — composite, also a scan.
- **Volume** — per (integration × setting key). `setIntegrationSetting` is **delete-then-insert, not upsert** (`:223`), and `setIntegrationSettings` loops it serially (`:236`) — **saving an N-key form is 2N round trips.**
- **Retention** — `deleteIntegration` `:199`.
- **Blob→columns** — **N/A**, but the table needs **a primary key**: `PRIMARY KEY (integration_id, key)` is the natural one, and it would make the delete-then-insert an upsert and the read a seek. This is the change to make, not a blob promotion.
- **Migration risk** — **adding a PK is `ensureTable`'s destructive rebuild** (`sqlite-settings-backend.ts:809`). At 5 rows that is acceptable **today** and will not be later. Do it now, with an export first.

### 3.41 `devices` — **0 rows** [measured] — **DEAD, and DELETED 2026-08-19**

> **Executed ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).**
> The device half of the integration-registry is gone — the methods, the
> `PersistedDevice` / `CreateDeviceInput` / `DeviceIdentity` types, the
> visibility passthroughs, the tests and both `@durable` records — and the table
> is dropped at every boot from `RETIRED_COLLECTIONS`
> (`packages/system/src/builtins/sqlite-storage/retired-collections.ts`), so a <!-- drift-ok: deleted 2026-10-22 (D901) -->
> restored backup converges instead of resurrecting the schema. Everything below
> is the evidence that justified it; none of it is actionable.

- **Creation** — `ensureTable`, `integration-registry.ts:107`; schema `:69`.
- **Columns [measured]** — 9: `id` TEXT PK, `integration_id` NOT NULL, `stable_id` TEXT NOT NULL **UNIQUE**, `type` TEXT NOT NULL DEFAULT 'camera', `name` NOT NULL, `enabled` INTEGER NOT NULL DEFAULT 1, `info` TEXT NOT NULL DEFAULT '{}', `created_at`, `updated_at`. Indexes `idx_devices_integration`, `idx_devices_stable` (UNIQUE), `idx_devices_type`. **`idx_devices_stable` duplicates the `unique: true` autoindex** (`integration-registry.ts:73` and `:83`).
- **Blob** — `info` = `Readonly<Record<string, unknown>>`, comment `{ manufacturer, model, firmware, mac, ip, … }` (`packages/types/src/interfaces/integration-registry.ts:18`). **UNDETERMINED**, and moot.
- **Queried** — `tableGet {id}` `:277`, `tableGet {stable_id}` `:282`, `tableQuery {integration_id}` `:288`, `tableQuery {type:'camera'}` `:299`. All indexed except the `created_at` sort.
- **Volume — zero, and the writers are unreachable.** **[source]** the registry is exposed only through `AddonRegistryService.getIntegrationRegistry()` → `createFilteredRegistry` (`server/backend/src/core/addon/addon-registry.service.ts:1235`), which does declare device passthroughs (`:1297`). Its three consumers call **no** device method: the integrations cap (`server/backend/src/api/core/cap-providers.ts:699`) is integration-level only; the boot backfill (`server/backend/src/main.ts:1375`) takes its `listDevices` from **device-manager**, not this registry (`:1386`); the REPL (`server/backend/src/core/repl/repl-engine.service.ts:91`) takes devices from `deviceRegistry`. Real device persistence lives in the `addon-devices` KV collections.
- **Retention** — cascade in `deleteIntegration` `:198`.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Phase-3 deletion candidate — a writer that exists and is never called.** Delete the table *and* the `createDevice`/`updateDevice`/`deleteDevice` methods, or the next reader will find a plausible API and use it.

### 3.42 `device_settings_kv` — **0 rows** [measured] — **DEAD, and DELETED 2026-08-19**

> **Executed with §3.41 ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).**
> Listed in `RETIRED_COLLECTIONS` and dropped at every boot.

- **Creation** — `ensureTable`, `integration-registry.ts:108`; schema `:88`.
- **Columns [measured]** — 4: `device_id` TEXT NOT NULL, `key` TEXT NOT NULL, `value` TEXT NOT NULL, `value_type` TEXT NOT NULL DEFAULT 'string'. **No PK, no index** — same shape as §3.40.
- **Blob** — same `value`/`value_type` variant encoding.
- **Queried** — `tableQuery({where:{device_id}})` `:330` — **[measured]** `SCAN`; `tableDelete({device_id, key})` `:343` — scan.
- **Volume** — zero. Reachable only through the same unused `createFilteredRegistry` passthroughs (`addon-registry.service.ts:1324`).
- **Retention** — `deleteDevice` `:320`, `deleteIntegration` `:196`.
- **Blob→columns** — N/A.
- **Migration risk** — none. **Phase-3 deletion candidate**, together with §3.41.

### 3.43 `storage_locations` — 4 rows [measured]

- **Creation** — `ensureTable`, `packages/system/src/builtins/storage-orchestrator/location-store.ts:94`; schema `:48`. Lazily, on first read or write (`:86`).
- **Columns [measured]** — 9: `id` TEXT PK, `type` TEXT NOT NULL, `display_name` NOT NULL, `provider_id` NOT NULL, `config` TEXT NOT NULL DEFAULT '{}', `is_default` INTEGER NOT NULL DEFAULT 0, `is_system` INTEGER NOT NULL DEFAULT 0, `created_at`, `updated_at`. Index `idx_storage_locations_type`.
- **Blob — `config`** is `z.record(z.string(), z.unknown())` (`packages/types/src/interfaces/storage-location.ts:53`) — provider-defined, so open. **Concretely written and read keys [source]:** `basePath` (seeded `packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts:770`, read `packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts:486`), `minFreePercent` (read `:462`), and the reserved `__nodeId` (`location-store.ts:46`, injected `:144`, stripped on read `:187`). Any other key is provider-specific and **UNDETERMINED**.
- **Queried** — **`loadAll()` is the only read**: `tableQuery(orderBy created_at asc)` with no WHERE (`location-store.ts:101`) → full scan + filesort. Everything else is served from the orchestrator's in-memory map. **`idx_storage_locations_type` is never used — dead index.**
- **Volume** — one row per declared location *type* seeded at first boot (`storage-orchestrator.service.ts:730`) plus operator-added instances. Order 10⁰.
- **Retention** — `delete(id)` `:128`, plus `pruneUndeclaredSystemLocations()` at every boot (`storage-orchestrator.addon.ts:600`) removing system-seeded rows whose type is no longer declared.
- **Blob→columns** — **no.** `config` is read whole with the row and never predicated.
- **Migration risk** — low. Note `upsert` is **delete+insert** (`location-store.ts:119`), so any foreign-key-like reference (see §3.45) sees the row disappear and reappear.

### 3.44 `backup_schedules` — 1 row [measured]

- **Creation** — `ensureTable`, `packages/system/src/builtins/backup-orchestrator/schedule-store.ts:72`; schema `:42`.
- **Columns [measured]** — 8: `id` TEXT PK, `label` TEXT NOT NULL DEFAULT '', `cron` TEXT NOT NULL DEFAULT '', `enabled` INTEGER NOT NULL DEFAULT 1, `location_ids` TEXT NOT NULL DEFAULT '[]', `retention_count` INTEGER NOT NULL DEFAULT 7, `data_sources`, `last_run_at`. No secondary index.
- **Blob** — two JSON TEXT columns, both **flat string arrays, not objects**: `data_sources` = `readonly string[]` (`schedule-store.ts:35`, serialised `:126`, parsed `:131`) and `location_ids` (`:124`, `:157`). No field names.
- **Queried** — `list()` `:79` — `tableQuery(orderBy id asc)`, no WHERE → scan in PK order; `get(id)` `:93` — PK + `LIMIT 1` (appended by `tableGet`, `sqlite-settings-backend.ts:923`) ✅.
- **Volume** — one row per operator-created schedule.
- **Retention** — `delete(id)` `:107`. No automatic pruning (correct — these are configuration).
- **Blob→columns** — **no.** Both arrays are read whole and never predicated. A relational purist would normalise `location_ids` into a join table; at one row that would be pure cost.
- **Migration risk** — none.

### 3.45 `backup_destination_policies` — 1 row [measured]

- **Creation** — `ensureTable`, `packages/system/src/builtins/backup-orchestrator/destination-policy.ts:92`; schema `:57`.
- **Columns [measured]** — 6: **`location_id` TEXT PRIMARY KEY**, `enabled` INTEGER NOT NULL DEFAULT 1, `retention_count` INTEGER NOT NULL DEFAULT 7, `label`, `cron`, `last_run_at`. No secondary index.
- **Blob** — **NONE.** All six columns are scalars.
- **Queried** — `list()` `:99` scan in PK order; `get(locationId)` `:113` PK ✅.
- **Volume** — one row auto-created per `backups`-typed storage location the first time `listDestinations` runs (`ensureDefault` `:151`, from `packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts:378`).
- **Retention** — `delete(locationId)` `:131`. **No sweep when the referenced `storage_locations` row is deleted → orphan policies are possible.**
- **Blob→columns** — N/A.
- **Migration risk** — low. Worth recording: the PK **is** a foreign key into `storage_locations.id` (`destination-policy.ts:24`) and it is **not enforced** — `ensureTable` emits no `REFERENCES` (`sqlite-settings-backend.ts:771`) even though the connection sets `foreign_keys = ON` (`:100`). **[measured]** no table in the database declares a foreign key, so that PRAGMA is inert. **An ORM that emits real FKs would start enforcing constraints this data has never been checked against** — see §6.4.

---

### 3.46 `cluster-node-history` — 3 rows [measured]

- **Creation** — **S1, the only one** — `server/backend/src/core/agent/cluster-node-history-store.ts:119`, wrapped in a `try`/`catch` that logs `declareCollection failed (best-effort)` (`:129`) and returns null.
- **Columns [measured]** — 3: `id` TEXT PK, `lastActive` INTEGER NOT NULL, `descriptor` TEXT NOT NULL.
- **Blob — `descriptor`, fully enumerated [source]** by `DescriptorSchema` `cluster-node-history-store.ts:70`: `id`, `name`, `hostname`, `platform`, `arch`, `cpuModel` (nullable), `cpuCores`, `memoryMB`, `engines[]`, `isHub`, `localIps[]`, `addonIds[]`, `packages?[{name, version|null}]`. Row envelope `{lastActive, descriptor}` (`:90`). **[measured]** matches exactly.
- **Queried** — `get({key: nodeId})` `:165` PK ✅; `query({collection})` unfiltered `:302` → full scan (3 rows). Malformed rows are dropped, not thrown (`:305`).
- **Volume** — one row per node ever seen. `snapshot()` `:144` fires **on every `listNodes()` topology refresh for every live node**, doing a read-before-write to preserve `packages` (`:150`).
- **Retention** — only the explicit operator "Forget node" action, `forget()` `:296`. Never automatic — by design, this table *is* the offline-node list.
- **Blob→columns** — **no.** `descriptor` is read whole; nothing is predicated. `lastActive` is already promoted and is the one field that would ever be.
- **Migration risk** — none. This is the one call site to change in phase 1 (§1.2).

### 3.47 `ai:usage` — 3 rows [measured]

- **Creation** — **S2 port**, `packages/addon-ai/src/usage/usage-store.ts:74`; columns `:17`.
- **Columns [measured]** — 12: `id` TEXT PK, `ts` INTEGER NOT NULL, `consumer` TEXT NOT NULL, `profileId`, `kind`, `model`, `inputTokens`, `outputTokens`, `latencyMs`, `ok`, `errorCode`, `imageCount`. **No index at all.**
- **Blob** — **NONE.** Validated by `UsageRowSchema` `:37`.
- **Queried** — `rollup()` reads via `validRows()` → `store.query(USAGE_COLLECTION)` **unfiltered, full scan**, then filters and groups **in JS** (`:82`–`:124`). Deliberate, documented at `:5`. **No WHERE, ORDER BY or LIMIT ever reaches SQL.**
- **Volume** — **one INSERT per LLM call** (`:78`). This is the one table whose growth is proportional to a user-driven rate rather than to cameras or events. Order 10⁴–10⁶/year on a heavy install.
- **Retention — present and working.** `prune(90)` `:143`, wired at `packages/addon-ai/src/assembly.ts:102`, invoked after boot and on an interval (`packages/addon-ai/src/addon.ts:112`, `USAGE_RETENTION_DAYS = 90` at `:25`). The prune is itself a full scan plus one DELETE per expired row (`:145`) — cost grows with call volume.
- **Blob→columns** — **N/A, no blob. But this is the table where the missing aggregate hurts most.** `rollup` wants `SELECT date(ts), consumer, profileId, COUNT(*), SUM(inputTokens), SUM(outputTokens), AVG(latencyMs) … GROUP BY 1,2,3` and instead loads and Zod-parses the whole table. See gap **G3**. It also wants an index on `ts` for the prune.
- **Migration risk** — low; adding an index on `(ts)` and one on `(consumer, ts)` is online.

### 3.48 `ai:budgets` — **0 rows** [measured] — declared, and touched by no code

- **Creation** — S2 port, `usage-store.ts:75`; columns `:31`.
- **Columns [measured]** — 4: `id` TEXT PK, `consumer` TEXT NOT NULL, `dailyTokenLimit`, `action`.
- **Blob** — NONE. **Queried** — never. **Volume** — no writer.
- **Retention** — n/a.
- **Blob→columns** — N/A.
- **Migration risk** — none. **[source]** `BUDGETS_COLLECTION` appears in exactly four places repo-wide: its definition (`:15`), the `declareCollection` call (`:75`), a re-export (`packages/addon-ai/src/index.ts:38`), and a test assertion that it was declared. **There is no writer and no reader**, and the file says so on purpose: *"budget enforcement is v2 — schema only"* (`usage-store.ts:4`). This is **materially different from §3.41**: `devices` has an unreachable writer (rot), `ai:budgets` has a documented placeholder (intent). **Keep it**, or delete it as part of deciding v2 — but do not sweep it up with the dead tables.

### 3.49 `llm-profiles` — 3 rows / `llm-meta` — 1 row / `llm-defaults` — 1 row [measured]

- **Creation** — S2 port with `KV_BLOB_COLUMNS`: `packages/addon-ai/src/profile-store.ts:36` and `:37`, `packages/addon-ai/src/defaults-store.ts:24`. **This is the S2 shape that produces a canonical-KV-identical table**: the single `data` column makes the backend route every read through the KV branch (`sqlite-settings-backend.ts:406`), and the `id` PK is contributed by `declareCollection` (`:722`).
- **Columns [measured]** — all three: `(id TEXT PK NOT NULL, data TEXT NOT NULL)`. No index.
- **Blob — enumerated [source]:**
  - `llm-profiles.data` = `LlmProfileSchema` **minus `id`** (`profileToData` strips it, `profile-store.ts:24`; `rowToProfile` re-injects it from the PK, `:19`). Fields, `packages/types/src/capabilities/llm.cap.ts:41`: `name`, `kind` (`openai-compatible|openai|anthropic|google|managed-local`, `:32`), `addonId`, `enabled`, `model`, `baseUrl?`, `apiKey?`, `supportsVision`, `temperature?`, `maxTokens?`, `timeoutMs`, `extraHeaders?`, `runtime?`. **`apiKey` is stored raw** — `profile-store.ts:4`: *"Rows are RAW (apiKey present) — redaction is the provider's job"*.
  - `llm-meta.data` — one shape, one row: `{ at: number }`, written literally at `profile-store.ts:87` under id `'seededDefaults'`. There is no type; that line **is** the definition. **[measured]** confirms.
  - `llm-defaults.data` = `LlmDefaultSchema` (`packages/types/src/capabilities/llm.cap.ts:88`): `{ selector, profileId }`, selector = `{consumer}` | `{purpose:'text'|'vision'}` (`:82`). Row id is the derived key `consumer:<x>` / `purpose:<x>` (`packages/addon-ai/src/defaults-store.ts:14`).
- **Queried** — **every operation is an unfiltered full scan.** `ProfileStore.list` `:42`, `getById` `:52` (**scans then `.find` in JS** rather than a PK `get`), `upsert` `:59` (scan to decide insert-vs-update), `ensureSeeded` `:74`; `DefaultsStore.list` `:29`, `set` `:44`. Volumes are tiny so it is cheap — but it is the same anti-pattern as §3.31, from the same port shape.
- **Volume** — per profile / per default selector, plus a one-shot seed of a disabled example on first boot (`profile-store.ts:73`).
- **Retention** — explicit `delete(id)` only (`profile-store.ts:67`, `defaults-store.ts:39`). `llm-meta`'s marker row is never deleted, by design (`:71`).
- **Blob→columns** — **no.** All three are read whole. `getById` should be a `get`, not a scan — a caller fix, not a schema one.
- **Migration risk** — none. **`apiKey` stored in plaintext in `llm-profiles.data` is a finding for the security review, not for this map** — but any ORM migration that copies rows must not log them.


## 4. (A) The storage capability as it stands

### 4.1 There is one, and it is `settings-store`

`packages/types/src/capabilities/settings-store.cap.ts:67` — `scope: 'system'`,
`mode: 'singleton'`, implemented only by `SqliteSettingsBackend`
(`packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts:50`).
The complete surface is **ten methods**:

| Method | Line | Input | Output | Kind |
| --- | --- | --- | --- | --- |
| `get` | `packages/types/src/capabilities/settings-store.cap.ts:73` | `{namespace?, collection, key}` | `unknown` | query |
| `set` | `:79` | `{namespace?, collection, key, value}` | `void` | mutation |
| `query` | `:91` | `{namespace?, collection, filter?}` | `readonly {id, data}[]` | query |
| `insert` | `:101` | `{namespace?, collection, record}` | `void` | mutation |
| `update` | `:112` | `{namespace?, collection, id, data}` | `void` | mutation |
| `delete` | `:124` | `{namespace?, collection, key}` | `void` | mutation |
| `count` | `:131` | `{namespace?, collection, filter?}` | `number` | query |
| `histogram` | `:141` | `{namespace?, collection, field, bucketSize, origin, filter?}` | `readonly {bucket,count}[]` | query |
| `isEmpty` | `:154` | `{namespace?, collection}` | `boolean` | query |
| `declareCollection` | `:174` | `{namespace?, collection, columns[], indexes?}` | `void` | mutation |

`QueryFilter` (`:7`): `where` (**equality only**), `whereIn`, `whereBetween`
(**inclusive both ends**), `orderBy{field,direction}`, `limit`, `offset`.
**No method declares an auth level** — every one is `protectedProcedure`.

Callers, **27 first-party files**: `addon-post-analysis` 16 files (every
pipeline-analytics and notification-center store), `system` 6 (`auth/*`,
`builtins/local-auth/*`), `addon-auth` 1, `addon-notifiers` 1 (via its port),
`addon-ai` 1 (via its port), `addon-provider-homeassistant` 1,
`server/backend` 1 (`core/agent/cluster-node-history-store.ts:119`), plus the
kernel's forked-addon bridge (`packages/system/src/kernel/moleculer/addon-context-factory.ts:536`).

Adjacent caps that are **file** storage, not database, and are not in scope
here: `storage` (`packages/types/src/capabilities/storage.cap.ts:50`),
`storage-provider` (`packages/types/src/capabilities/storage-provider.cap.ts:122`),
`storage-evictable` (`packages/types/src/capabilities/storage-evictable.cap.ts:34`).

### 4.2 The gaps — the surface is NOT sufficient

Six, each with the caller that works around it and the SQL it wants.

**G1 — no bulk `deleteWhere(filter)`. Every retention path in the system is an
N+1 drain loop.** This is the largest gap by a wide margin.
`delete` takes a key (`settings-store.cap.ts:124`; backend `:307`), so a
retention sweep must `SELECT` a page of full rows and then issue one
`delete.mutate` **per row**:
- `packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts:587` (`evictBefore`), `:640` (`pruneBefore`), `:705` (`deleteByTrack`)
- `packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts:404`, `:579`
- `packages/addon-ai/src/usage/usage-store.ts` (retention is records TTL now; the N+1 prune pattern still applies to every settings-store drain above)
- `packages/system/src/builtins/alerts/alerts.addon.ts:639`

The cost is not theoretical: pruning a day of motion events is ~7,200 tRPC
round trips plus 7,200 prepared `DELETE … WHERE id=?` statements, and the
`SELECT` that finds them **fetches every column**, including the fat ones —
pruning `object-embeddings` reads 10.8 KB of JSON per row purely to learn its
id. The backend already has the primitive: `tableDelete(table, filter)` returns
a deleted count (`sqlite-settings-backend.ts:876`). **It is simply not on the cap.**

**G2 — no bulk `updateWhere(filter, patch)`.** Same shape, three loops in one
file: `event-store.ts:347` (`setLabelForTrack`), `:377`
(`setImportanceForTrack`), `:479` (`clearLabelForTrack`) — each is
`UPDATE … SET x=? WHERE trackId=?` written as query-all-then-loop. Backend
primitive `tableUpdate` exists at `sqlite-settings-backend.ts:857`, uncapped.

**G3 — PARTIALLY CLOSED. `aggregate` (`SUM`/`MIN`/`MAX`) has shipped;
`AVG` and `GROUP BY` have not:**
- `event-store.ts:418` `peakForTrack` loads every object event of a track to compute a max in JS — and is called **up to 500 times per `getKeyEvents`** (`packages/addon-post-analysis/src/pipeline-analytics/index.ts:5421`), polled every 30 s. **Still open**, and now expressible: `aggregate` serves `MAX`.
- ~~`media-store.ts:442` `footprintByDevice` walks 112,658 rows in 113 `OFFSET` pages to compute `SUM(sizeBytes) GROUP BY deviceId`.~~ **Closed 2026-08-30 (D316)** — `histogram` for the grouping key, `aggregate` for the sums. It had reached 1 254 576 rows and a 60 s timeout before it was.
- `packages/addon-ai/src/usage/usage-store.ts:92` `rollup` loads and Zod-parses the whole table to group by `(day, consumer, profileId)`. **Still open**, and the one remaining case that genuinely needs `groupBy` on `aggregate`: three grouping keys, two of them non-numeric, so the `histogram` trick does not reach it.

`histogram` (`settings-store.cap.ts:141`) is the one aggregate that was added,
and only because `densityByKind` (`event-store.ts:530`) could not be done
client-side. That is the precedent: **aggregates get added one at a time, under
pressure.**

**G4 — `where` is equality-only.** No `<`, `>`, `!=`, `LIKE`, `OR`, `IS NULL`
(`sqlite-settings-backend.ts:426` emits only `expr = ?`). Consequences:
- `whereBetween` is the only inequality, and being inclusive forces callers to hand-shift bounds: `whereBetween: { timestamp: [0, input.cutoffMs - 1] }` with a four-line comment explaining the off-by-one (`event-store.ts:631`).
- **No `IS NULL`** is why `queryHistorical` runs two queries instead of one (§3.12).
- The two missing reapers (`scoped_tokens` expiry §3.35, `oauth_sessions` revocation §3.36) both need `<` on a nullable column, and neither exists.
- Prefix matching has no cap expression at all — the backend does it internally with `id LIKE ? || '%'` (`sqlite-settings-backend.ts:582`, `:684`).

**G5 — no transaction, no batch insert.** The cap has neither. The backend uses
`db.transaction()` internally (`sqlite-settings-backend.ts:584`, `:635`) and
exposes none of it. Consequence at `event-store.ts:740`: a per-track loop of
per-page loops of per-row deletes, non-atomic and explicitly best-effort.
A crash mid-cascade leaves a track's media orphaned from its row.

**G6 — silent field drop, and no way to introspect a schema.** `insert`/`update`
discard any key that is not a declared column (`sqlite-settings-backend.ts:285`,
`:299`) with no error. §3.14 shows the live cost: `zoneCrossing`, computed at
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts:696`,
is declared in the Zod schema and **has never reached disk**. There is no cap
method that returns a collection's declared columns, so a caller cannot detect it.

**Where the surface IS sufficient:** key lookup by id, range scan on a declared
composite index, ordered page with LIMIT/OFFSET, and COUNT all map cleanly and
**[measured]** produce correct query plans. The gaps are all *write-side and
aggregate-side*.

### 4.3 The bypass list — the enforcement target

Ordered by how much a guard would have to do about each.

**B1 — `settingsBackend`, a second tRPC door with none of the cap's scoping.
DELETED 2026-08-03.** The router (`settings-backend.router.ts`, mounted in
`trpc.router.ts` and bridged to every forked addon via `core-cap-bridge.ts`)
re-exposed `get/set/query/insert/update/delete/count/isEmpty` on an **arbitrary
`collection: z.string()` with no `namespace` field**, straight onto the raw
`ISettingsBackend`. Any addon could read or write any other addon's collection
through it, and nothing was prefixed. It was not an incidental import; it was a
parallel API with weaker guarantees, reachable from every addon.

It had no callers, and that was **proven against the live nodes** rather than
assumed — including positive controls, because a grep that finds nothing must be
shown capable of finding something:

| Pattern, over deployed addons | hub (27 addons) | agent (14) |
| --- | --- | --- |
| `settingsStore` (control) | 69 | 63 |
| `ctx.api.` (control) | 70 | 63 |
| `api.settingsBackend.` | **0** | **0** |
| `core-caps.settings-backend` | **0** | **0** |
| `settings-backend.<method>` | **0** | **0** |

The `TrpcSettingsBackend` it was written for never existed, and the forked-addon
context factory never populates `ctx.settingsBackend`, so nothing in-tree could
have reached it either.

**B2 — `ISettingsBackend.ensureTable` + the six `table*` methods: a second SQL
surface that is not on any cap.** Declared at
`packages/types/src/interfaces/storage.ts:205`–`:230`, implemented at
`sqlite-settings-backend.ts:768, 844, 857, 876, 884, 917, 928`. Reachable only
by holding the concrete provider object, which four consumers do — and they own
**seven tables**:

| Consumer | Entry | Tables |
| --- | --- | --- |
| `IntegrationRegistry` | `packages/system/src/builtins/sqlite-storage/integration-registry.ts:105` | `integrations`, `integration_settings`, `devices`, `device_settings_kv` |
| `SqliteLocationStore` | `packages/system/src/builtins/storage-orchestrator/location-store.ts:86` | `storage_locations` |
| `BackupScheduleStore` | `packages/system/src/builtins/backup-orchestrator/schedule-store.ts:61` | `backup_schedules` |
| `BackupDestinationPolicyService` | `packages/system/src/builtins/backup-orchestrator/destination-policy.ts:84` | `backup_destination_policies` |

`location-store.ts:65` admits it in its own docblock. This is the bypass that
made the generated map wrong (§1.1).

**B3 — `ISettingsStore`, a third uncapped surface, and the one that has already
caused an outage.** `packages/system/src/kernel/config-manager.ts:43` declares
13 synchronous methods, implemented as raw SQL at
`sqlite-settings-backend.ts:507`–`:647`, wired at
`server/backend/src/core/addon/addon-registry.service.ts:2623`.
It produces a live divergence in which **`AddonSettingsView` has two
implementations that write different tables**:
- **forked / UDS addons** → `packages/system/src/kernel/moleculer/addon-context-factory.ts:546` → the **cap** → `<addonId>:addon-settings`, `<addonId>:addon-devices`;
- **hub in-process addons** → `packages/system/src/kernel/config-manager.ts:361` → `ISettingsStore` → canonical `addon-settings` with row id `<addonId>.<key>`, and `addon-device-settings` with row id `<addonId>:<deviceId>.<field>`.

Different tables, different key grammars, **same API name**. **[measured]** the
consequence is visible in the data: `addon-devices` and `device-runtime-state`
hold zero rows while 51 scoped variants and 991 `__device-state` rows hold the
real state.

**B4 — the raw `Database` handle.** `sqlite-settings-backend.ts:671`
`getDatabase()`, whose docblock says it exists "for components that need direct
SQL access (e.g. DeviceStore, ConfigStore)". **[source]** it has **zero
production callers**: `DeviceStore` and `ConfigStore` are instantiated only in
their own specs. Worse, `packages/system/src/builtins/sqlite-storage/device-store.ts`
selects and inserts `addon_id` and `parent_stable_id` (`:24`, `:32`, `:40`,
`:47`) — **columns the live `devices` table does not have**; it would throw
`no such column` on first call, and its spec passes only because the spec
creates its own table. `packages/system/src/builtins/sqlite-storage/config-store.ts`
targets an `addon_config` table **nothing in the repo creates**.
And `server/backend/src/core/addon/addon-registry.service.ts:2632` carries a
comment saying these are "owned by the `device-persistence` capability addon",
a capability that **does not exist** (absorbed into `device-manager`,
`packages/types/src/capabilities/device-manager.cap.ts:6`). Three leftovers,
each describing a design that is gone.

**B5 — `better-sqlite3` opened outside the storage builtin.**
`packages/system/src/builtins/system-backup/system-backup.service.ts:344`
dynamically imports the driver, walks the data dir discovering databases by
their `-wal` sidecar (`:337`), opens each and runs
`pragma('wal_checkpoint(TRUNCATE)')` (`:357`). Deliberate and documented, but
it is a genuine second opener, and a phase-2 guard must whitelist it explicitly
rather than pretend it is not there.

**B6 — `scripts/migrate-auth-caps-only.ts`.** Uses **`node:sqlite`**
(`:29`), not `better-sqlite3` — so it **evades every `better-sqlite3` grep**,
including the one the phase-2 guard is specified as. It hardcodes the DB path
(`:38`) and runs raw `PRAGMA table_info`, `ALTER TABLE`, `UPDATE`, `DELETE` and
`BEGIN/COMMIT/ROLLBACK` (`:41`–`:206`). A one-shot migration script is a
legitimate thing to have — but **the guard must ban `node:sqlite` too**, or it
checks for a rule that is already being broken by the one file whose whole job
is schema surgery.

**B7 — `StorageManager` legacy shim.**
`packages/system/src/storage/storage-manager.ts:92` takes the raw backend and
builds an `IStructuredStorage` over `query/insert/update/delete/count/histogram`
(`:178`). No new SQL, but a parallel path with a parallel type.

**No addon and no router contains a raw SQL string.** That is genuinely good
news, and it means the enforcement target is seven named items, not a diffuse
problem.

**Build-time references that are NOT DB access** and must be excluded from any
guard: `tools/build/vite-lib.preset.ts:138`,
`packages/system/src/kernel/host-externals.ts:22`,
`packages/system/src/kernel/deps/ensure-native-prebuilds.ts:55`,
`packages/system/src/kernel/deps/manifest-native-deps.ts:188`,
`packages/system/src/kernel/addon-installer.ts:487`,
`packages/node-root/src/root-single-copy.ts:142`,
`packages/node-root/src/root-update-service.ts:108`,
`server/backend/src/core/server-update/system-ensure-prebuilds.ts:12`,
`server/backend/src/agent/agent-update-service.ts:173`,
`packages/addon-pipeline/vite.config.ts:9`. These name the module to stage or
externalise the `.node` binary; none opens a database.

Worth recording as a guard that already works:
`packages/system/src/kernel/host-externals.ts:22` deliberately keeps
`better-sqlite3` **out** of the host-external list, with a test that asserts it
(`packages/system/src/kernel/__tests__/host-externals.spec.ts:33`), so a stray
`import 'better-sqlite3'` in an addon fails to *resolve* at runtime. The
enforcement problem is inside `@camstack/system`, not in the addons.

---

## 5. (B) How `sqlite-settings` disappears

### 5.1 What it is today

Two things wearing one name.

**The addon** (`packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts`,
manifest `packages/system/package.json:52`) registers exactly one capability and
does four things beyond that:

1. **Resolves the DB path itself**, `:28` — `<ctx.dataDir>/camstack.db`, fallback `camstack-data/addons-data/<addonId>/camstack.db`. It deliberately does **not** use the `storage` cap: a documented boot-order deadlock (`:18`), because the storage orchestrator initialises *after* sqlite-settings in order to read its own location table.
2. **Creates the directory and logs boot diagnostics**, `:36`–`:45`.
3. **Passes `RUNTIME_DEFAULTS` into the backend** (`:47`), which first-boot-seeds `system-settings` (`sqlite-settings-backend.ts:120` → `:650`). This is the last remaining addon-id special case in the kernel.
4. **Registers the provider** (`:50`) and owns its lifecycle (`:53`).

It is **Phase-1 infra with `required: true`**
(`packages/system/src/kernel/infra-capabilities.ts:22`) — boot aborts if it
fails — and it carries the `better-sqlite3` native dependency
(`packages/system/package.json:321`), which is why `@camstack/system` is an
addon-bundle external at all.

**The provider object** carries **33 methods**, of which the cap declares 10:

| Surface | Count | Where |
| --- | --- | --- |
| Cap contract | 10 | `sqlite-settings-backend.ts:202, 227, 262, 272, 291, 307, 313, 341, 387, 711` |
| `ensureTable` + `table*` | 7 | `:768, 844, 857, 876, 884, 917, 928` |
| `ISettingsStore` legacy, synchronous | 13 | `:507, 517, 527, 536, 579, 597, 602, 607, 612, 622, 626, 643` |
| Raw handle | 1 | `:671` |
| Lifecycle | 2 | `:91, 193` |

And it owns policy nothing else can see: the canonical allowlist (`:66`, parsed
as a source of truth by **two** separate guards), scoped-variant auto-declare
(`:145`), the PRAGMAs (`:99`), the JSON/BOOLEAN marshaling (`:734`, `:174`), the
`json_extract` fallback (`:422`), the silent field drop (`:285`), and the
**schema-evolution policy** (`:784`) whose destructive branch wiped the whole
`tracks` history on 2026-07-17.

Registering it fires a cascade at
`server/backend/src/core/addon/addon-registry.service.ts:2620`: `activeSettingsBackend`,
`configService.setSettingsStore()`, `storageService.setSettingsBackend()`,
`new IntegrationRegistry(provider)` (which creates four of the seven `ensureTable`
tables), and `loadCollectionPreferences()`.

### 5.2 What absorbs each responsibility

"`sqlite-settings` disappears" cannot mean the addon is deleted — something must
still open a file and be Phase-1 infra. It means **the name `sqlite-settings`
stops being a thing any caller knows about**, and the SQLite-ness stops leaking.
Concretely:

| Responsibility today | Absorbed by |
| --- | --- |
| The 10 cap methods | Unchanged. The cap **is** the door; the ORM lives behind it. |
| The 7 `ensureTable`/`table*` methods (B2) | **Folded into `declareCollection` + the existing cap methods.** These are not a different capability, they are the same one with a different signature. Every one of the four consumers wants "declare a typed table, then insert/update/delete/query it" — which is exactly `declareCollection` + `insert`/`update`/`delete`/`query`. The only genuine difference is `defaultValue`, which `declareCollection` drops (`sqlite-settings-backend.ts:732`) — **add it to `CollectionColumnSchema`** and the gap closes. |
| The 13 `ISettingsStore` methods (B3) | **Deleted, not moved.** Four of the collections they serve hold zero rows (§3.4–3.8). The two that matter, `getAllAddon`/`setAllAddon` and `getAddonDevice`/`setAddonDevice`, must be **redirected to the same scoped tables the forked path uses** — that is the outage fix, and it is the reason this step cannot be skipped. |
| `getDatabase()` (B4) | **Deleted**, along with `device-store.ts`, `config-store.ts`, their specs, the `sqlite-storage/index.ts:14` exports and the stale comment at `addon-registry.service.ts:2632`. Zero production callers. **Stale since 2026-08-06** — WAL maintenance and the sqlite-vec index both call it now, from inside the owning builtin. Deleting it today breaks both; the honest item is "keep it internal to `sqlite-storage`". |
| `settingsBackend` router (B1) | **Deleted.** Its eight methods are the cap's methods minus scoping. Anything reaching it should reach the cap's generated router. |
| DB path resolution + boot ordering | **Stays exactly where it is.** The deadlock at `sqlite-settings.addon.ts:18` is real and the fix is not worth the risk. |
| `RUNTIME_DEFAULTS` seeding | Stays, but should move behind the migration runner (§5.4) as migration `0001-seed-system-settings`, so "seed" and "migrate" are the same mechanism. |
| The engine itself | **Becomes replaceable, which is the whole point.** With B1–B4 gone, `SqliteSettingsBackend` is reachable only as `ProviderRegistration` for one capability, and a `PostgresSettingsBackend` would be a drop-in. |

### 5.3 How the dynamic `<addonId>:<canonical>` tables are served behind the same door

This is the part an ORM is genuinely bad at, and it has a clean answer **because
every one of the 51 tables has the identical shape**.

**[measured]** all 51 scoped variants are `(id TEXT PRIMARY KEY NOT NULL, data
TEXT NOT NULL)` — no exceptions, and structurally there can be none: the
auto-declare path (`sqlite-settings-backend.ts:145`) only fires when the suffix
is one of the nine canonical names, and it hard-codes that DDL at `:150`.

So the ORM does not need 51 models. It needs **one model, parameterised by table
name** — the pattern every typed query builder supports (Drizzle:
`sqliteTable(name, cols)` is a plain function, so a `kvTable(name)` factory
returns a fully typed model for any name; Kysely: a `KvRow` interface plus
`db.withTables<…>()` or a `sql.table()` reference). The typed layer models the
*shape*, and the *name* stays a runtime value.

Two rules make that safe, and both are enforceable:

1. **The name grammar is closed.** A scoped table is `<addonId>:<canonical>` where `<canonical>` ∈ the nine-name allowlist. Anything else already throws (`sqlite-settings-backend.ts:162`). A generated `KvCollection` union type from the allowlist gives compile-time checking of the suffix; the `addonId` half stays a validated string.
2. **The KV shape is the *only* dynamic shape.** Every other table in the system is statically declared. So the escape hatch is exactly one model wide, not "the ORM has an escape hatch".

The one thing that must **not** happen is modelling the scoped variants as
separate typed schemas generated from a live database — that reintroduces the
schema-on-disk-is-a-superset problem the plan is trying to end.

### 5.4 Migration order, and what breaks if a step is skipped

Each step is safe **only** after the one above it.

| # | Step | Breaks if done earlier |
| --- | --- | --- |
| 1 | **Add the missing cap methods** (`deleteWhere`, `updateWhere`, comparison operators, `IS NULL`, aggregates, `defaultValue` on a column) | Nothing depends on it. **Everything below does**: without `deleteWhere` the `ensureTable` consumers cannot be migrated onto the cap, and without `defaultValue` the seven B2 tables cannot be declared through it at all. |
| 2 | **Migrate the four B2 consumers off `table*` onto the cap** | Skipping straight to deleting `table*` breaks `integrations` (7 rows, live), `storage_locations` (4 rows, live) and both backup tables. And deleting them *before* step 1 is impossible — `defaultValue` has no expression. |
| 3 | **Delete `DeviceStore`, `ConfigStore` and the stale comment** (B4) | Nothing — they have zero production callers **today**. Do it early, because every day they stay they read as a supported API. **`getDatabase()` is no longer part of this step**: it has had two callers inside `sqlite-storage` since 2026-08-06 (WAL maintenance, sqlite-vec). |
| 4 | **Redirect the `ISettingsStore` addon-settings paths to the scoped tables** (B3) | **This is the dangerous one.** Deleting `ISettingsStore` before redirecting silently changes which table an in-process addon reads — the exact failure that already cost a live outage. It needs a data migration (`addon-settings` rows `<addonId>.<key>` → `<addonId>:addon-settings`), and it must be reversible. |
| 5 | ~~**Delete the `settingsBackend` router** (B1)~~ — **done 2026-08-03** | The risk was that a forked addon still calling it would lose persistence, so "no caller" had to be proven rather than assumed. It was, on both live nodes, with positive controls (§4.3 B1). |
| 6 | **Introduce the schema module + migration runner**, with a `schema_version` table (**[measured]** `user_version` is `0` today) | Nothing breaks, but doing it *before* steps 1–5 means the schema module has to model three declaration surfaces instead of one. |
| 7 | **Land the ORM behind the cap** | Doing this first is the tempting order the plan already warns against: it builds the abstraction on top of a schema with three back doors, and the escape hatch appears on day one. |
| 8 | **Delete the four empty canonical collections** (§3.6–3.8, and `addon-devices` §3.4) | Only after step 4 proves nothing writes to them. |
| 9 | **Add the CI guard** | Last, because a guard that fails on day one gets an allowlist that never shrinks. |


## 6. (C) ORM fit, per table

### 6.1 The three verdicts

- **Clean** — a typed schema models it exactly: fixed columns, closed types, no runtime-derived name. Nothing is lost.
- **Escape hatch** — typed schema plus one named exception (a JSON column the ORM must treat as opaque, a runtime table name, or a predicate SQL cannot express).
- **Raw** — better left as hand-written SQL behind the cap.

### 6.2 The verdict table

| Table | Verdict | Why |
| --- | --- | --- |
| `system-settings`, `addon-settings`, `addon-device-settings`, `addon-devices`, `device-runtime-state`, `sections`, `provider-settings`, `device-settings`, `alerts` | **Escape hatch** | Two typed columns, but `data` is an opaque per-key JSON value. One `kvTable(name)` model covers all nine. `alerts` additionally wants two generated columns, which Drizzle expresses natively and Kysely does not. |
| The 51 `<addonId>:<canonical>` scoped variants | **Escape hatch — the *one* genuinely dynamic case** | Identical shape to the above, name known only at runtime. Solved by §5.3: one parameterised model, not 51. |
| `pipeline-analytics:media`, `:ops-log` | **Clean** | Zero JSON columns, all scalars, fixed names. Model these first — they are the proof that the typed layer works. |
| `pipeline-analytics:identities`, `:identity-samples`†, `:vehicles`, `:vehicle-samples`, `notification-center:occupancy`, `backup_destination_policies`, `user_totp`, `user_passkey_prefs`, `ai:usage`, `ai:budgets` | **Clean** | Scalars only (†`identity-samples.embedding` is a `number[]`, opaque but never predicated — a `text({mode:'json'}).$type<number[]>()` column types it fully). |
| `pipeline-analytics:audio-events` | **Clean after §3.16** | Today one 3-field JSON column; promote it and the table is fully relational. |
| `pipeline-analytics:tracks`, `:object-events`, `:motion-events`, `:sensor-events`, `:faces`, `:plates`, `:stationary-objects`, `:object-embeddings` | **Escape hatch** | Typed scalars plus 1–5 JSON columns that are read whole and never predicated. Drizzle's `text({mode:'json'}).$type<TrackPosition[]>()` types them **from the same Zod-derived types the stores already use** — this is not really an escape hatch so much as a declared opaque column. **`sensor-events.value` is the real one**: a genuine open union keyed on `kind` with no closed type (§3.17). |
| `notification-center:outbox`, `:rules`, `:timelapse-rules` | **Escape hatch** | Same pattern; `rules.rule` is deliberately a whole-object blob (§3.28) and should stay one. |
| `notification-center:meta` | **Escape hatch** | A singleton scalar in a table. Model as a typed KV, not an entity. |
| `notification-targets`, `ha-notification-targets` | **Escape hatch** | KV shape, `config` an open record. Same `kvTable` model. |
| `users`, `api_keys`, `scoped_tokens`, `oauth_sessions`, `user_passkeys` | **Escape hatch** | Scalars plus `TokenScope[]` / `allowedDevices` JSON. `allowedDevices` is `Record<string, '*'|string[]>` — types cleanly as a `$type<>`, but is genuinely open-keyed. |
| `integrations`, `devices`, `storage_locations`, `backup_schedules` | **Escape hatch, plus a naming exception** | The only `snake_case` tables (§3.39). Drizzle handles this with an explicit column name per field; Kysely needs a plugin or manual mapping. Normalise while they hold 7 rows. |
| `integration_settings`, `device_settings_kv` | **Raw — or rather, fix them first** | No primary key at all. A typed ORM will model them, but modelling a PK-less table is modelling a bug. Add `PRIMARY KEY (integration_id, key)` (§3.40) **before** typing them; `device_settings_kv` should just be deleted (§3.42). |
| `cluster-node-history` | **Clean** | 3 columns, one typed JSON blob with a full Zod schema at `server/backend/src/core/agent/cluster-node-history-store.ts:70`. |
| `llm-profiles`, `llm-meta`, `llm-defaults` | **Escape hatch** | KV shape; same model as the canonical nine. |

**Nothing in this database needs raw SQL.** That is a real finding: there is no
recursive CTE, no window function, no FTS table, no vector extension, no view,
no trigger, and **[measured]** no foreign key. Every query in the system is a
single-table `SELECT`/`INSERT`/`UPDATE`/`DELETE` with equality, `BETWEEN`, `IN`,
`ORDER BY` and `LIMIT`. The two aggregate shapes that are missing (`SUM … GROUP
BY`, `MAX`) are ordinary. A typed query builder covers **100%** of the access
patterns catalogued in §3.

### 6.3 The verdict: Drizzle, inside the capability, for schema and migrations only

**Prisma is already ruled out and I agree** — an engine binary is a hazard for a
multi-arch image and for the Electron build, and this repo has spent real time
on native-prebuild staging (`packages/system/src/kernel/deps/ensure-native-prebuilds.ts:55`)
that a second native artifact would compound.

Between the remaining two:

**Drizzle wins on the one axis this repo actually legislates.**
`CLAUDE.md` states that codegen is authoritative and that anything derivable is
generated — the whole reason `docs/reference/storage.md` exists. Drizzle's
`sqliteTable(...)` declaration is **one artifact from which both the DDL and the
TypeScript types derive**. Kysely is a superb query builder but it does **not**
own the schema: you hand-write a `Database` interface *and* hand-write the
migrations, which are two artifacts that can drift — and "two artifacts that
drift" is the precise disease this whole exercise is treating. §1.1 exists
because a schema had no single declaration point.

The secondary reasons, in order:

1. **`drizzle-orm` is a dependency-free pure-TypeScript package with no binary.** It is a thin layer over the `better-sqlite3` handle the backend already holds (`sqlite-settings-backend.ts:98`). Nothing changes for the multi-arch image or the Electron staging path. `drizzle-kit`, which generates migration SQL, is a **devDependency** and never ships.
2. **Generated columns are first-class.** §3.3 and §3.9 — the two KV tables with real predicates — want `GENERATED ALWAYS AS (json_extract(data,'$.x')) VIRTUAL` plus an index, which is the cheapest possible fix (no rewrite, no row migration). Drizzle expresses this in the schema, so the column survives a rebuild; a hand-added one would be discarded by `ensureTable`'s destructive path (`sqlite-settings-backend.ts:809`). Kysely has no schema to put it in.
3. **`sqliteTable` is a plain function**, so §5.3's `kvTable(name)` factory is idiomatic rather than a workaround.
4. **`text({mode:'json'}).$type<T>()`** lets every JSON column carry the type the store already has from `z.infer<>` — so the blob columns are *declared opaque with a type*, not untyped.
5. **The migration ledger is the thing that does not exist today.** **[measured]** `user_version = 0`; the only mechanism is `CREATE TABLE IF NOT EXISTS` plus a destructive rebuild that has already destroyed production data once (`sqlite-settings-backend.ts:790`). Drizzle ships an ordered, recorded, replayable migration table. §3.18's base64-f32 change and §3.40's add-a-primary-key change are both **impossible to do safely without one**.

**Where Kysely would be the better choice, and why it does not apply here:** if
the schema were owned by something outside the codebase (an existing DB, another
team, a DBA), a query builder that types an externally-owned schema is exactly
right. Here the schema is owned by this repo and has no declaration at all.

**Hand-rolled migrations plus the existing backend** is the honest third option
and it is not absurd — the query surface is small and the backend already works.
Reject it for one reason: it leaves the schema derivable only by *executing* the
code, which means the phase-2 requirement — *"one code path creates an empty
database, another diffs a live one and reports drift"* — has to be built by hand
anyway. That is most of an ORM, written once, by us, without tests.

### 6.4 Four things Drizzle will not fix, stated so nobody expects them

1. **It does not type the cap boundary.** `SettingsRecordSchema` is `{id: string, data: z.record(z.string(), z.unknown())}` (`packages/types/src/capabilities/settings-store.cap.ts:22`). Everything crossing the cap is `unknown`, which is why **[measured]** there are **228** `as Record<string, unknown>` casts in first-party non-test source, 24 of them in the pipeline-analytics stores alone. Drizzle's types stop at the storage builtin. Typing the *cap* is a separate, generics-shaped problem — and CLAUDE.md's "no casts" rule means it is the one that actually pays.
2. **It does not add the missing cap methods.** G1–G6 (§4.2) are cap-surface gaps. An ORM behind an unchanged cap leaves every retention sweep an N+1 loop.
3. **It does not close the bypasses.** B1–B7 (§4.3) are deletions and redirections. Drizzle behind a backend that still exposes `getDatabase()`, `table*`, `ISettingsStore` and a second tRPC router is an ORM with four doors around it.
4. **Emitting real foreign keys would start enforcing constraints this data has never been checked against.** **[measured]** `foreign_keys = ON` but **no table declares one**, and §3.45 documents a real dangling reference pattern (a destination policy whose `storage_locations` row can be deleted). Declare FKs in the schema for documentation, but **do not enable enforcement in the same change** — audit and clean first, or the first migration fails on live data.

**So the honest ordering is: the ORM is the *smallest* of the wins available
here.** The operator's requirement — *"non si deve mai accedere al db
puntualmente"* [the db must never be accessed ad hoc] — is satisfied by deleting B1–B4 and adding the missing cap
methods. Drizzle then makes the schema exist in code and makes migration
possible, which is what phase 2 asks for. Doing Drizzle first would put a typed
layer in front of a schema with four back doors.

---

## 7. Work list, keyed to the remediation phases

Ordered. Each item names its evidence.

### 7.1 Phase 0 — see the real schema · **largely done by this document**

- [x] **Reconcile the live schema against the map.** §2: 102 tables, 100% classified, **zero unaccounted**. The extractor gained `parseEnsureTables` (`scripts/lib/parse-storage.ts`) and `docs/reference/storage.md` now publishes section 4.
- [ ] **Ship the reconcile as a cap method**, not a script — the plan is right that it must work on an agent without shell access. The classification logic is in this document's §2 and is ~40 lines.
- [ ] **Add rows + `dbstat` bytes per table** to that method. §2.2/§2.3 are the shape of the output.

### 7.2 Phase 1 — one declaration path · **smaller than budgeted**

- [ ] **Hoist the two `this.collection` names to module constants** at `packages/addon-notifiers/src/target-store.ts:83` and `packages/addon-provider-homeassistant/src/ha-notification-output.ts:314`. Both already resolve to a literal (§1.2); this removes the last statically unresolvable names and empties §5 of the generated map.
- [ ] **Collapse the remaining identical `SettingsStorePort` interfaces** (`packages/addon-notifiers/src/target-store.ts:44`, `packages/addon-provider-homeassistant/src/ha-notification-output.ts:275`) into one — addon-ai dropped its port when usage moved to `ctx.records`. **The in-memory doubles still silently discard the column list** (`packages/addon-notifiers/src/settings-store-port.ts:63`, `packages/addon-provider-homeassistant/src/ha-notification-output.ts:404`) — the exact "green suite hides a live bug" mechanism.
- [ ] **Give the port a `filter` parameter.** `packages/addon-notifiers/src/settings-store-port.ts:16` is why a PK lookup on `notification-targets` is a full scan (§3.31).
- [ ] Decide S1 (`server/backend/src/core/agent/cluster-node-history-store.ts:119`): route through the cap, or document it as the bootstrap exception.

### 7.3 Phase 2 — the schema exists in code

- [ ] **A declarative schema module per owning addon**, as data. This is the Drizzle schema (§6.3). Start with `pipeline-analytics:media` and `:ops-log` — **[measured]** the only two large tables with zero JSON columns, so they prove the layer with nothing to argue about.
- [ ] **Create-from-schema and verify-against-schema** on the same declaration. §2's reconciliation is the shape of `verify`.
- [ ] **A `schema_version` table and an ordered, replayable migration list.** **[measured]** `user_version = 0` today; §3.18 and §3.40 are both blocked on this existing.
- [ ] **Add `defaultValue` to `CollectionColumnSchema`** (`packages/types/src/capabilities/settings-store.cap.ts:36`) — the one thing `ensureTable` can express and `declareCollection` cannot (`packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts:732`), and therefore the blocker on §5.4 step 2.
- [ ] **The guard** (`scripts/check-storage-schema.ts`), wired into CI. <!-- drift-ok: the guard phase 2 proposes; it does not exist yet --> Must ban `node:sqlite` as well as `better-sqlite3` (§4.3 B6).

### 7.4 Phase 3 — remove what nothing creates · **reframed: nothing is orphaned; things are dead**

**[measured]** every table on disk is created by code. The candidates are dead
code and empty tables, and each needs an export before a drop.

| Candidate | Action | Evidence |
| --- | --- | --- |
| ~~`devices` (0 rows)~~ | **DONE 2026-08-19 (D183)** — table, methods, types, visibility passthroughs and tests deleted; the table is dropped every boot from `RETIRED_COLLECTIONS` | §3.41 |
| ~~`device_settings_kv` (0 rows)~~ | **DONE 2026-08-19 (D183)**, same change | §3.42 |
| `packages/system/src/builtins/sqlite-storage/device-store.ts` + its spec | **Delete** | §4.3 B4 — no prod instantiation, **and its SQL names columns the live table does not have** |
| `packages/system/src/builtins/sqlite-storage/config-store.ts` + its spec | **Delete** | §4.3 B4 — targets `addon_config`, a table nothing creates |
| exports at `packages/system/src/builtins/sqlite-storage/index.ts:14` | Delete with the above | |
| comment at `server/backend/src/core/addon/addon-registry.service.ts:2632` | **Delete** — names a `device-persistence` cap that does not exist | §4.3 B4 |
| `getDatabase()` (`sqlite-settings-backend.ts:942`) | **Do NOT delete as written.** It gained two production callers on 2026-08-06 — WAL maintenance and the sqlite-vec index (`sqlite-settings.addon.ts:156`, `:202`), both inside the owning builtin. Restate the item as "keep it internal to `sqlite-storage`", or drop it | §4.3 B4, whose "zero production callers" is stale |
| canonical `sections`, `provider-settings`, `device-settings` (0 rows) | **Delete after §5.4 step 4** | §3.6–3.8 |
| canonical `addon-devices` (0 rows) | **Delete after §5.4 step 4** — the real data is elsewhere | §3.4 |
| ~~`device-runtime-state`~~ | **DO NOT DELETE.** It had no writer, not no purpose; D131 pointed the writer at it 2026-08-13 | §3.5 |
| `notification-center:timelapse-rules` (0 rows) | **Finish or remove the feature**; do not just drop the table | §3.29 — store is never instantiated outside tests |
| indexes `idx_api_keys_token_prefix`, `idx_oauth_sessions_user_id`, `idx_storage_locations_type`, `idx_stationary_device`, `idx_nc_rules_enabled`, `idx_nc_timelapse_rules_enabled`, `idx_nc_occupancy_device`, `idx_nc_outbox_status` | **Drop or repoint** — eight indexes no query uses | §3.20, §3.25, §3.26, §3.28–3.30, §3.34, §3.36, §3.43 |
| duplicate index `idx_devices_stable` | Drop (duplicates the `unique: true` autoindex) | §3.41 |
| 40 scoped-variant tables with 0 rows | **Leave.** They cost 4 KB each and an addon may write tomorrow. | §3.10 |
| `ai:budgets` | **Leave** — a documented v2 placeholder, not rot | §3.48 |
| `dead: FaceStore.listRecentFaces`/`prune`, `TrackStore.observedClassNames` | Delete or wire — test-only callers, and one has a docblock that lies | §3.20, §3.12 |
| **`VACUUM` once, after the drops** | **[measured]** `freelist_count = 22,106` pages = **86 MiB, 31% of the file** already reclaimable | §2.1 |

### 7.5 Phase 4 — expand JSON into columns · **a short list, as the plan predicted**

In descending measured value.

| # | Change | Mechanism | Measured justification |
| --- | --- | --- | --- |
| 1 | **Bound the embedding query** — pass `limit` and `modelId` at `packages/addon-post-analysis/src/pipeline-analytics/index.ts:5508` | Caller fix, **no schema change** | §3.18 — a default semantic search loads the whole **86.5 MB** table and JSON-parses 7,375 vectors |
| 2 | **Fix `alerts` retention logic** — predicate on `createdAt`, not `read` | Code fix | §3.9 — **[measured]** 2,288 rows, **all `read=0`**, ~128/day, nothing ever deleted |
| 3 | **Add a retention rule to `pipeline-analytics:ops-log`** | Needs G1 | §3.19 — **no prune of any kind**, ~2,060 rows/day |
| 4 | **Index `(ownerKind, ownerId, kind)` on `pipeline-analytics:media`** | `CREATE INDEX`, online | §3.13 — `kind` is a residual predicate on the image data plane, 1–3 queries per byte served |
| 5 | **Index `(deviceId, className, timestamp)` on `:object-events`** | `CREATE INDEX`, online | §3.14 — `className` is a real predicate in no index; also fixes the unbounded package-drop query |
| 6 | **Generated columns on `alerts`** — `readG`, `createdAtG` + index | `VIRTUAL`, **no rewrite** | §3.9 — every alerts query is `SCAN` + `TEMP B-TREE` |
| 7 | **Generated column on `addon-device-settings`** — `deviceIdG` + index | `VIRTUAL`, **no rewrite** | §3.3 — 3,142 rows, `json_extract` predicate, `SCAN` |
| 8 | **Promote `audio-events.classification` into three real columns** | Additive `ALTER TABLE`, backfill online | §3.16 — closed 3-field shape, 59,136 rows, and the predicate cannot even be *expressed* today |
| 9 | ~~**`SUM`/`GROUP BY` on the cap**~~ — **`SUM` done (D316); `groupBy` still open for §3.47** | G3 | ~~§3.13 `footprintByDevice` is O(n²) over 112 k rows~~ (fixed 2026-08-30); §3.47 `rollup` loads the whole table |
| 10 | **`MAX` on the cap**, to kill the `peakForTrack` N+1 | G3 | §3.14 — up to 500 extra queries per `getKeyEvents`, polled every 30 s |
| 11 | **Push `assigned`/`corrected` into the WHERE** on faces and plates | Caller fix, **no schema change** | §3.20, §3.23 — existing columns, hottest JS filters, never in a predicate |
| 12 | **Re-encode `object-embeddings.embedding` as base64 f32** | 4-step online migration; needs §5.4 step 6 | §3.18 — **86.5 MB → ~22 MB**, and the packed form already exists on the wire |
| 13 | **Add `PRIMARY KEY (integration_id, key)`** to `integration_settings` | Destructive rebuild — **do it now, at 5 rows** | §3.40 |
| 14 | **Split `notification-center:occupancy`'s composite `key` PK into columns** | Destructive rebuild — **do it now, at 0 rows** | §3.30 |
| 15 | **Decide whether `motion-events.regions` has a reader**; if not, stop writing it | Investigation | §3.15 — **[measured]** avg **3 bytes** across 101,059 rows |

**Cheap, reversible, and not schema changes at all** — do these first and
re-measure before anything above:

- **`VACUUM` once** — reclaims **86 MiB** of the 277 MiB file **[measured]**.
- **`ANALYZE`** — **[measured]** `sqlite_stat1` is absent, so every plan above is chosen without statistics. Then `PRAGMA optimize` on a schedule.
- **Consider `mmap_size`** — **[measured]** it is `0`. On a 277 MiB database with a 112 k-row hot table this is worth an A/B.
- **Establish where `cache_size = -16000` comes from** — **[undetermined]**; it is not SQLite's default and CamStack never sets it.

### 7.6 Phase 5 — one capability in front of the data

- [ ] **Add the six missing cap methods** (§4.2 G1–G6) — the prerequisite for everything else. **G1 and G2 shipped 2026-08-03** as `deleteWhere` / `updateWhere` on one filter compiler; G3–G6 remain.
- [x] **Delete the `settingsBackend` router** (B1) — the highest-value single deletion on the list. Done 2026-08-03; absence of callers proven on the live hub and agent.
- [x] **Migrate the four `ensureTable` consumers onto the cap** (B2). Done 2026-08-03 — the whole `table*` surface is gone, and it was losing data on the way out.
- [ ] **Redirect and delete `ISettingsStore`** (B3) — with a data migration, reversible. §5.4 step 4.
- [ ] **Keep `getDatabase()`, internal to `sqlite-storage`** — B4's deletion is stale; WAL maintenance and sqlite-vec call it.
- [ ] **The CI guard**, last, and it must ban **`node:sqlite` as well as `better-sqlite3`** — §4.3 B6, because the one file doing schema surgery today uses the module the specified guard would not catch. Whitelist `system-backup.service.ts:344` explicitly (B5).

### 7.7 Decisions this document is ready to feed

The plan lists four decisions. Three now have an evidenced default:

| Decision | Evidenced default |
| --- | --- |
| Migration mechanism | **An ordered recorded list** (§6.3 reason 5). Two of the required changes — base64-f32 and add-a-PK — cannot be expressed as a declarative diff. |
| Generated vs stored columns as the default for indexing JSON | **Generated `VIRTUAL` first, always.** §3.3 and §3.9 are both fully served by it with no rewrite. Promote to stored only for a **closed, typed** shape — which in this database is exactly one case, §3.16. |
| How far the query surface goes before it is an ORM | **To G1–G6 and no further.** Each is justified by a specific caller that works around it today, and the two aggregates are the ones `histogram` already set the precedent for. |
| Whether scoped variants stay implicit or become declared | **Stay implicit** (§5.3) — they have exactly one shape, so one parameterised model types all 51 without a per-addon declaration. |
