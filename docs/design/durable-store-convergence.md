---
title: Durable store convergence — what the 44-store backlog actually is, and whether the objective is clear
last-verified: 2026-09-27
applies-to:
  - scripts/check-durable-state-declared.ts
  - packages/addon-post-analysis/src/durable/durable-ledger.ts
  - packages/addon-pipeline-orchestrator/src/durable/durable-ledger.ts
covers:
  - packages/addon-post-analysis/src/notification-center/device-mute-store.ts
  - packages/addon-post-analysis/src/notification-center/rule-store.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-store.ts
  - packages/addon-post-analysis/src/notification-center/text-catalog-store.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/timelapse-store.ts
  - packages/system/src/builtins/core-blocks/core-block-store.ts
  - packages/system/src/builtins/storage-orchestrator/location-store.ts
  - server/backend/src/core/agent/cluster-node-history-store.ts
---

# Durable store convergence

> **STATUS: EXECUTED, 2026-08-14.** This was analysis only when it was written;
> it is not any more, and leaving the old banner up would make a done thing read
> as a pending one. What landed, against the plan in §5 and the questions in §7:
>
> | Item | Outcome |
> | --- | --- |
> | Phase 1 — classify all 44 (§5) | **DONE.** The guard's backlog went 44 → **0**; 13 → 57 classified. `parse-storage.ts` was relaxed to bind an annotation to a module-private `const`, since half the collection-name constants are not exported. |
> | Phase 2 — the three NC migrations (§5) | **DONE.** `rules`, `timelapse-rules`, `summary-rules` now sit on `DurableLedger`. The load-failure direction is held by `rule-store-load-failure-direction.spec.ts`, which was confirmed RED with `clear()` hoisted above the `await` in all three stores. |
> | `storage_locations` re-entry guard (§3.1, §7.10) | **FIXED.** `attachStore` now latches only after a successful `loadAll()`. Test neutralisation documented in the spec. |
> | `share_view_tokens` full scan (§3.2, §7.10) | **FIXED**, and more generally: the backend now renders an index on a KV-blob field as an expression index matching the predicate, so any KV collection can be indexed. Asserted with `EXPLAIN QUERY PLAN`, not by checking the DDL ran. |
> | June `preswap`/`rekey-bak` leftovers (§6.4, §7.7) | **DELETED** on the hub — 9.2 MB, 10 files (the 4 named plus their `-shm`/`-wal` companions). `PRAGMA quick_check` on the live DB: `ok`. |
> | NVMe placement (§6.1, §7.6) | **RECORDED as D147**, with one finding that changes the answer: the Appdata Backup gap D96 predicted is REAL but arrives by a different mechanism — the path resolves fine; the `CamStack` container is on the plugin's skip list. Operator action, still open. |
> | `liveness` 263 → 730 (§6.6, §7.9) | **NOT A LEAK.** 728 device subjects + 2 nodes, 728 distinct deviceIds, zero unknown ids against 781 configured devices. Recorded in the ledger's docblock. |
> | Phase 3 — framework home (§5) | **NOT DONE**, as recommended. Deferred and decoupled — and the price of deferring is now visible: a **third** byte-identical copy of the primitive landed in `addon-pipeline` on 2026-08-17, and `TWINS` in `scripts/check-durable-state-declared.ts` pins three pairs where it pinned one. |
> | `device-mutes` / `texts` (§7.4) | Classified, not migrated — the recommended split. |
> | 244 legacy `__device-state:*` rows (§6.5, §7.8) | **NOT DONE** — still open, needs the D131 per-device migration confirmed complete first. |
>
> Every row count, byte figure and file claim below was measured or read on
> 2026-08-14 — the live hub via `sqlite3` in `mode=ro`, the working tree via
> direct reads. No number is carried over from the 2026-08-13 census without
> being re-measured, and the two places where the census has drifted are called
> out in §6.

The question that started this: looking at **148 tables**, shouldn't the
long-term/durable-state concept live in *one common structure — maybe a JSON
blob instead of many different tables*?

The short answer is in three parts, and only the third is work:

1. **148 is not 148 domain tables.** 68 of them are auto-created per-addon KV
   variants (41 completely empty), 13 are sqlite-vec shadow tables, 9 are the
   canonical KV list. The domain surface is **58**, and the whole discussion is
   about 44 of those (§1).
2. **The "one JSON blob" shape is already in this repo, and it lost a camera's
   entire night 14 hours ago.** It is not a hypothesis to evaluate — it is a
   measured failure mode with a fix committed today (§2).
3. **The real backlog is an ANNOTATION debt, not a MIGRATION debt.** Of the 44,
   **36 must never move** onto the primitive and need only a four-line comment;
   **8 genuinely duplicate its mechanics**, and only **5 of those can move
   today** — the other 3 are blocked on a framework home that does not exist
   (§3, §4).

**Verdict on "is the objective clear": no, and it is worth restating before any
code is written.** The guard prints *"44 on the shrink-only backlog"*, which
reads as a to-do list of 44 migrations. It is not: it is a list of 44
collections that have never declared **what class of fact they hold**.
Classifying all 44 empties the backlog and migrates nothing. See §4.

---

## 1. What the 148 tables actually are

Measured with `sqlite_master` + `dbstat` on the live file
(`/data/addons-data/sqlite-settings/camstack.db`, `mode=ro`).

| Group | Tables | On-disk | What creates them |
| --- | ---: | ---: | --- |
| Canonical KV (storage.md §1) | 9 | 1.88 MB | fixed list in `SqliteSettingsBackend` |
| Per-addon scoped `:addon-settings` / `:addon-devices` (§2) | **68** | **0.34 MB** | created ON DEMAND at first write, declared nowhere |
| `vec_*` sqlite-vec shadow tables (§4) | 13 | 36.96 MB | `${registryTable}` in `vector-index-vec.ts` |
| Declared domain collections (§3) + `sqlite_sequence` | 58 | ~315 MB | `declareCollection` |
| **Total** | **148** | **354.4 MB** | |

Two facts worth sitting with before designing anything:

- **41 of the 68 scoped tables hold zero rows.** They exist because an addon
  wrote once, or because the backend materialised the variant. They cost 4 KB
  each and answer to no design decision. **Nearly half the "148" is an artefact
  of the KV mechanism, not a proliferation of domain models.**
- **The 68 scoped tables ARE the "one common structure" already.** Every one is
  `(id TEXT PRIMARY KEY, data TEXT NOT NULL)` with the whole record as JSON in
  `data` — exactly the shape the question proposes. They total **0.34 MB across
  68 tables**. The table count is what that uniform shape *produces*: one table
  per addon per canonical collection. Converging the domain tables onto the same
  shape would raise the table count, not lower it.

### 1.1 Where the 355 MB actually is

| Table | Rows | On-disk | Bytes/row |
| --- | ---: | ---: | ---: |
| `pipeline-analytics:tracks` | 10,605 | **114.45 MB** | **~10,800** |
| `pipeline-analytics:media` | 177,331 | 41.80 MB | 236 |
| `vec_object_clip_vector_chunks00` | 16 | 33.62 MB | — |
| `pipeline-analytics:motion-events` | 272,141 | 25.15 MB | 92 |
| `pipeline-analytics:audio-events` | 247,716 | 20.37 MB | 82 |
| `pipeline-analytics:object-events` | 53,381 | 12.76 MB | 239 |
| `pipeline-analytics:ops-log` | 47,941 | 7.85 MB | 164 |
| `pipeline-analytics:faces` | 601 | 7.40 MB | 12,300 (embeddings) |

**`tracks` alone is 32 % of the database** — 10,605 rows against 272,141
motion-event rows that occupy a fifth of the space. The reason is measured:

```
avg(length(positions)) = 9,158 bytes   max = 36,189
avg(length(snapshots)) =   564 bytes   max = 17,982
```

`positions` is a JSON array serialised into one column. **The single largest
consumer of disk in this database is already a JSON blob**, and it is 120×
heavier per row than the columnar event tables next to it. That is the empirical
answer to "maybe a JSON blob instead of different tables": on this installation
the blob column costs two orders of magnitude more per fact than the columns do.

---

## 2. Why a shared blob is the wrong common structure — measured, today

The proposal's appeal is real: one mechanism, one place to get the failure
direction right. **That is exactly what `DurableLedger` already is** — but it is
a shared *contract over per-key rows*, not a shared blob, and the difference is
not stylistic.

`DurableLedger.persist` writes **one row per key**:

```ts
await this.store.set.mutate({
  collection: this.spec.collection,
  key: this.spec.keyOf(row),
  value: this.spec.toValue(row),
})
```

Two writers touching two different keys never contend. A blob store has the
opposite property, and it bit 14 hours ago.

### 2.1 The export-store race (2026-08-14)

`packages/addon-pipeline/src/recorder/addon/export-store.ts` **kept** every
export job in **ONE blob** under a single store key (`RECORDING_EXPORTS_KEY =
'recordingExports'`), `exportId → ExportRecord`. **Since 2026-08-19 it does not:
it is one row per export in `recorder:exports`, through `RowMapStore`**
([D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md)).
This section's argument was executed, not merely accepted — and the serialiser
it asks for below stays, now keyed per export id rather than per store, because
a per-row upsert still does not order two writers of the SAME row. The file
documented what the blob cost, in its own words:

> EVERY mutation here is a read-modify-write of the SAME blob, and both halves
> are async — so two overlapping cycles read the same snapshot and the second
> `set` discards whatever the first one added. Last writer wins, silently.
>
> That is not a hypothetical. The engine patches `progressPct` roughly once a
> second for an in-flight render, unawaited; on 2026-08-14 a `createExport` for
> camera 101 landed between one such patch's read and its write, the row was
> erased, and five seconds later the poll answered `unknown export
> "547ea182-…"`. **The camera's whole night was lost to it** — the scheduler read
> a vanished row as a failed render and re-queued, forever.

The fix is a per-handle mutation chain — a mutex. **A mutex is the
tax a shared blob charges and a per-key row does not.** Generalising the blob
shape to the durable stores would generalise that tax, and every store that
forgot to pay it would fail the same silent way.

### 2.2 What the common structure already is

So the convergence the question asks for exists, and it is the **contract**, not
the container:

| Concern | Where it is solved once |
| --- | --- |
| declare, RAM mirror, boot reseed, write mode | `DurableLedger` (the primitive) |
| one row per unit, NO mirror, validation per ROW, an explicit `loadLimit` | `RowMapStore` (`packages/addon-pipeline/src/durable/row-map-store.ts`), added 2026-08-19 by [D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md) — the shape for a map read on demand, where a mirror would only add a staleness surface. A value a DECISION is gated on still belongs on the ledger. |
| what a value MEANS, retention, pruning | the `@durable` annotation on the owner's constant |
| "what survives a restart, and who owns it" | `docs/reference/storage.md` §3a, generated |
| a new store that declares neither | `scripts/check-durable-state-declared.ts` |

The residue is that **44 collections predate the annotation** and sit on the
guard's shrink-only backlog. That residue is what the rest of this document
measures.

---

## 3. The 44, classified

Row counts are live, 2026-08-14. Classification criteria, applied uniformly:

- **(a) TWIN** — loads the whole collection into a RAM Map at boot, serves reads
  from RAM, writes behind/through, and hand-rolls a load-failure direction. This
  is precisely the 120 lines the primitive was extracted to end.
- **(b) DIFFERENT** — serves reads by indexed SQL per query, and/or grows
  unbounded. **Structurally cannot use the primitive**: `DurableLedger.load()`
  mirrors *every row* into a `Map` (default cap 100,000). A collection with
  272,141 rows, or one whose reads are `where`/`orderBy`/`limit` pushdowns,
  would need the whole table in RAM and would still lose the index.
- **(c) DEAD** — zero rows *and* no reachable writer.

### 3.1 (a) TWINS — 8 collections

| # | Collection | Rows | Store | Blocked? |
| --- | --- | ---: | --- | --- |
| 1 | `notification-center:rules` | 14 | `rule-store.ts` (332 L) | **no — actionable today** |
| 2 | `notification-center:timelapse-rules` | 2 | `timelapse/timelapse-store.ts` (365 L) | **no** |
| 3 | `notification-center:summary-rules` | 0 | `summary/summary-store.ts` (277 L) | **no** |
| 4 | `notification-center:device-mutes` | 0 | `device-mute-store.ts` (138 L) | **no** |
| 5 | `notification-center:texts` | 1 | `text-catalog-store.ts` (166 L) | no (partial fit) |
| 6 | `core_blocks` | 0 | `core-blocks/core-block-store.ts` (192 L) | **yes — framework home** |
| 7 | `storage_locations` | 4 | `storage-orchestrator/location-store.ts` (234 L) | **yes** |
| 8 | `cluster-node-history` | 3 | `core/agent/cluster-node-history-store.ts` (421 L) | **yes** |

**All five actionable ones live in `addon-post-analysis`, which already holds a
copy of the primitive.** That is the whole reason they are actionable and the
other three are not.

**The latent bug this would close.** In `rule-store.ts`, `summary-store.ts` and
`timelapse-store.ts` the mirror survives a failed load *only because of
statement ordering*:

```ts
const rows = await this.store.query.query({ ... })   // throws here …
const idsByName = await this.readIdentityIds()
this.byId.clear()                                     // … so this is never reached
```

Nothing states this. No test names it. **Moving `clear()` three lines up
silently reverses the failure direction** in three stores at once — and
reversing that direction is exactly what produced the notification flood
(D130) and the occupancy cold-seed loss. The primitive's rule 2
("a failed load NEVER clears the mirror — deliberately no knob") makes the
reversal unexpressible.

`core_blocks` is the near-exact twin — same `static declare`, same
skip-malformed-with-count, same keep-mirror-on-failure — and would be a drop-in
the day a framework home exists.

`storage_locations` carries a **real defect** the primitive's contract would have
prevented: `attachStore` latches its re-entry guard *before* the load, so if
`loadAll()` throws, no retry ever rehydrates and the orchestrator runs for the
process lifetime on seed defaults while `upsert` overwrites rows it never read —
silently replacing the operator's persisted `minFreePercent`.

`cluster-node-history` is the **anti-twin that would gain the most**. D131 cut
its writes from 8,640/day to ~864/day, but did it by adding a **read before
every write** to decide whether to write — so it now offers ~8,640 reads +
864 writes a day to maintain **three rows**, with SQLite on the path every 30 s.
A RAM mirror answers `worthWriting` for free.

### 3.2 (b) DIFFERENT — 36 collections, annotation only

These are on the backlog for one reason: **nobody has written down what class
of fact they hold.** None should move.

**pipeline-analytics — columnar query surfaces (15).** Every read is
`store.query.query({ collection, filter })` with `where`/`orderBy`/`limit`
pushed down onto declared indexes. `event-store.ts` states the anti-twin case
outright: *"Each has typed (deviceId, timestamp) indexes so the UI timeline gets
sub-linear queries even at high volume."*

| Collection | Rows | Rows/day (7 d) | Proposed class |
| --- | ---: | ---: | --- |
| `pipeline-analytics:motion-events` | 272,141 | 38,862 | `ledger` |
| `pipeline-analytics:audio-events` | 247,716 | 35,382 | `ledger` |
| `pipeline-analytics:media` | 177,331 | 15,698 | `ledger` |
| `pipeline-analytics:object-events` | 53,381 | 6,216 | `ledger` |
| `pipeline-analytics:ops-log` | 47,941 | 3,437 | `audit` |
| `pipeline-analytics:tracks` | 10,605 | 1,513 | `ledger` |
| `pipeline-analytics:faces` | 601 | — | `ledger` |
| `pipeline-analytics:identity-samples` | 46 | — | `ledger` |
| `pipeline-analytics:plates` | 40 | — | `ledger` |
| `pipeline-analytics:sensor-events` | 21 | — | `ledger` |
| `pipeline-analytics:identities` | 4 | — | `config` |
| `pipeline-analytics:vehicles` | 0 | — | `config` |
| `pipeline-analytics:vehicle-samples` | 0 | — | `ledger` |
| `pipeline-analytics:retrain-annotations` | 0 | — | `ledger` |
| `pipeline-analytics:retrain-frames` | 0 | — | `ledger` |

**auth + integration registry (12 when classified; 10 since 2026-08-19).** The premise that these are raw DDL is
**wrong** — every one goes through `declareCollection`; the only hand-written
`CREATE TABLE` in the repo is inside the backend that *implements* it. They are
still `DIFFERENT`: no mirror, no boot load, a fresh SELECT per read.

| Collection | Rows | Proposed class | Note |
| --- | ---: | --- | --- |
| `scoped_tokens` | 25 | `config` | last used 0.0 d ago |
| `integrations` | 12 | `config` | |
| `oauth_sessions` | 9 | `ledger` | grows per login |
| `integration_settings` | 6 | `config` | |
| `share_view_tokens` | 6 | `config` | see warning below |
| `users` | 2 | `config` | |
| `user_totp` | 1 | `config` | |
| `auth-webauthn:user_passkeys` | 1 | `config` | |
| `api_keys` | 0 | `config` | |
| `auth-webauthn:user_passkey_prefs` | 0 | `config` | |
| ~~`devices`~~ | 0 | — | **collection DELETED 2026-08-19** ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)) — never written on any install, and the declaring code is gone |
| ~~`device_settings_kv`~~ | 0 | — | **collection DELETED 2026-08-19**, same change |

> **Worth a separate ticket, found while classifying.** `share_view_tokens` is
> declared with only `(id, data)` columns, yet every share-link validation
> queries `filter: { where: { tokenHash } }` — and `tokenHash` is not a column.
> The backend rescues it by rewriting the predicate to
> `json_extract("data",'$.tokenHash')`, so **every share-link request is an
> unindexed full-table JSON scan**. Six rows today, so it is invisible; it is a
> latency cliff the moment shares are used in anger. Not a durable-state issue —
> a schema one.

> **Also worth a ticket — MOOT since 2026-08-19.** `devices` carried a UNIQUE
> index (`idx_devices_stable`), and `DurableLedgerSpec` has one `keyOf` and
> opaque `indexes`, so it cannot enforce a secondary unique constraint from RAM.
> That was a second, independent reason `devices` must never migrate; the table
> is gone ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).
> The limit on the primitive itself still stands for any future collection.

**notification-center (2).** `outbox` (225 rows) + `meta` (1). The primitive's
own docblock pre-excludes the outbox — per-target attempt counts, backoff,
dead-lettering, a 7-day dedup horizon rather than a full mirror, and a genuine
indexed query surface. Proposed: `ledger` both.

**addon-ai (5).** `ai:usage` (14) and `ai:budgets` (0) are append-only with a
90-day prune — a mirror here would be an unbounded RAM copy of an audit table.
`ai:llm-defaults` (2), `ai:llm-profiles` (3), `ai:llm-meta` (1) *would* gain a
mirror, but two blockers make them a bad first move: addon-ai speaks the flat
`SettingsStorePort`, not the tRPC-shaped `SettingsStoreClient` the primitive
requires; and adopting it would add yet another byte-identical copy under the
guard's equality check — there are **three** since 2026-08-17
(`addon-post-analysis`, `addon-pipeline-orchestrator`, `addon-pipeline`), so
addon-ai would be the fourth. Proposed: `audit`, `config`, `config`,
`config`, `config`.

**backup orchestrator (2).** `backup_schedules` (1), `backup_destination_policies`
(1) — pure operator-intent CRUD, no in-process copy, nothing gates on them.
Proposed: `config` both.

### 3.3 (c) DEAD — zero collections

**Nothing on the backlog is dead.** Twelve of the 44 hold zero rows, but every
one has a reachable writer and a live feature behind it; they are *unexercised*,
not abandoned. No orphaned pre-migration tables survive either — the 2026-08-04
namespace migration (`ns-migration-old-tables.json`) moved `llm-defaults`,
`llm-meta`, `llm-profiles` and `notification-targets` to scoped names and
**dropped the originals cleanly**; none is present in `sqlite_master` today.

This deserves to be stated plainly rather than filed as a null result: **a
zero-row store is the highest-risk annotation candidate, not a removal
candidate.** Both cold-start bugs D132 closed —
`NodeStressController`'s move history and `DeviceFeaturesMirror` — were found in
state that was empty and unexamined. `pipeline-orchestrator:node-stress-moves`
is *still* at 0 rows today, which is the correct and expected reading (no
failover has been applied since it shipped) and exactly the shape that hid the
bug before.

### 3.4 The tally

| Class | Count | Work |
| --- | ---: | --- |
| **(a)** twin, actionable now | **5** | migrate — ~200 lines deleted |
| **(a)** twin, blocked on framework home | **3** | annotate now, migrate later |
| **(b)** different — annotate only | **36** | 4-line comment each |
| **(c)** dead | **0** | — |

---

## 4. Is the objective clear? No — and here is the restatement

**The backlog conflates two debts with different sizes, different owners and
different risk.**

| | Debt A — classification | Debt B — mechanics |
| --- | --- | --- |
| Size | **44 collections** | **8 stores, 5 movable** |
| What it fixes | nothing answers "what survives a restart, and who owns it" for 44 of 58 domain tables | ~200 duplicated lines; 3 stores whose failure direction depends on statement ordering |
| Risk | **zero** — a comment | medium — data-shape preserving refactor + deploy |
| What the guard measures | **this one** | **not visible to any guard** |
| Blocked by | nothing | a framework home, for 3 of the 8 |

The guard's line — `44 on the shrink-only backlog` — measures **Debt A only**.
Reading it as a migration queue is the misunderstanding worth killing: **39 of
the 44 will still be on their current mechanism when the backlog reaches zero,
and that is the correct outcome.**

So the objective, restated:

> **Classify all 44 so the catalogue can answer "what survives a restart, and
> who owns it" for the whole domain surface. Separately, and second, retire the
> five duplicated ledger mechanics that live in the one addon that can host
> them today.**

Two consequences fall out of that phrasing:

1. **Debt A can be finished in one sitting and is nearly risk-free.** It is 44
   comment blocks plus 44 deletions from `BACKLOG`. The guard already enforces
   the pairing: it *fails* if a name is classified but still listed, so the two
   halves cannot drift.
2. **Debt B should not be sized from the number 44.** It is five stores, and
   the honest benefit is not the ~200 lines — it is that a reversal of the
   load-failure direction in three notification stores becomes unexpressible.

### 4.1 The blocker that has to be named

Three of the eight twins (`core_blocks`, `storage_locations`,
`cluster-node-history`) live in `packages/system` and `server/backend`. **They
cannot adopt the primitive at all today:**

- The primitive exists only as byte-identical copies **inside addons** — two
  when this was written, **three since 2026-08-17** (`addon-post-analysis`,
  `addon-pipeline-orchestrator`, `addon-pipeline`), pinned pairwise by `TWINS`
  in `scripts/check-durable-state-declared.ts`. The framework home did not
  arrive; the duplication grew instead.
  `grep -rn "DurableLedger\|durable-ledger" packages/system/src packages/types/src packages/sdk`
  still returns **zero hits** (re-checked 2026-08-19).
- `packages/system/package.json` has no `addon-*` dependency, so the import
  cannot even resolve.
- `packages/types/src/addon/durable-state.ts` is a **different mechanism**
  (a typed handle over one store key — no collection, no mirror, no boot load,
  no write mode). It is not a home for this.
- Per D132, a framework home is not live until a whole `@camstack/server` is
  published, which is the release-train reason the duplication exists.

There is also a **door mismatch**: `DurableLedger` is typed against
`SettingsStoreClient` (the tRPC namespace, `ctx.api.settingsStore`).
`core_blocks` already holds that door and is a drop-in. `storage_locations`,
`cluster-node-history` and the backup stores hold `ISettingsStoreProvider` (the
direct provider object) and would need either a switch or a widened primitive.

> **Hard constraint on any migration, from the backend's own docs.** A column
> list that reaches DDL differently than before "counts as non-additive and the
> next boot **REBUILDS the collection, discarding every row**". Any adoption must
> preserve each collection's declared columns byte-for-byte. `location-store.ts`
> is already built around dodging this (`__nodeId`/`__enabled` ride inside the
> `config` JSON blob rather than as columns) — which is itself a warning about
> how sharp the edge is.

---

## 5. The plan, ordered

### Phase 1 — classify all 44 (Debt A). ~4 h, no runtime risk.

Batched by owning file, largest batch first. Each is a `@durable` block on the
collection-name constant plus the matching deletion from `BACKLOG`.

| Batch | Collections | Owner |
| --- | ---: | --- |
| 1 | 15 | `pipeline-analytics/store/**`, `retrain/**` |
| 2 | 12 | `local-auth/auth-schema.ts`, `integration-registry.ts`, `share-token.service.ts`, `passkey-store.ts` |
| 3 | 7 | `notification-center/**` (the 5 twins + outbox + meta) |
| 4 | 5 | `addon-ai/**` |
| 5 | 5 | `core-block-store.ts`, `location-store.ts`, `cluster-node-history-store.ts`, `schedule-store.ts`, `destination-policy.ts` |

Ships as one docs/guard commit. `npm run codegen` + `npm run docs:check`
regenerate storage.md §3a; the guard flips to `0 on the shrink-only backlog`.
**Annotating a store does not change its behaviour** — this phase is safe to do
in full before any migration decision is made.

### Phase 2 — the three migrations that pay for themselves. ~2 h each.

Ordered by *bug class closed*, not by lines removed:

1. **`notification-center:rules`** (14 rows, live, edited 0.9 d ago). The
   biggest twin, the one whose ordering-dependent failure direction is most
   load-bearing — a wiped rule mirror is a hub that stops notifying. Removes
   ~50 lines. The one wrinkle: the identity-name map is read once per load and
   consumed per row, while `fromRecord` is sync and per-row — stage it on a
   field before `load()`, or lift `migrateIdentityNames` to a pass over the
   rows `load()` already returns.
2. **`notification-center:timelapse-rules`** (2 rows). Same shape, same hazard.
   Removes ~45 lines. Carries a deliberate documented exception to primitive
   rule 6 — `withCreatedAt` *repairs* a legacy row rather than skipping it,
   because skipping was "a silently vanished rule". `fromRecord` can host it,
   but the memoised `synthesisedCreatedAt` map must stay on the owner.
3. **`notification-center:summary-rules`** (0 rows). Its own docblock calls
   itself "a deliberate copy of `TimelapseStore`'s shape" — the third copy of
   the mechanics, self-declared. Removes ~40 lines. Zero rows means zero
   migration risk, which is why it is a good third rather than a skipped one.

Then, if the first three land clean: `device-mutes` (~35 lines) and `texts`
(~22 lines, partial fit — a scalar single-key mirror that degrades a malformed
row half-by-half instead of skipping it; adopt only if a one-key ledger is
judged in-contract).

**No data migration, no format change, no downtime.** Each store keeps its
declared columns and its keys; only the code that surrounds them changes. Ships
via `camstack deploy packages/addon-post-analysis`.

**Verification, per D132's own standard:** each migration must be paired with a
test whose CONTROL fails when the seed/keep-RAM gate is neutralised. A green
suite that passes because the fake supplied what production forgot is the
failure mode this repo has hit twice.

### Phase 3 — the framework home (unblocks the other three). Separate decision.

Not recommended as part of this work. It requires either a third byte-identical
copy (and widening the guard from a 2-way to a 3-way comparison) or the real
`types`/`system` extraction gated on a `@camstack/server` publish. **The three
stores it unblocks hold 3, 4 and 0 rows.** The one with real value is
`cluster-node-history`'s read-per-write, and that can be fixed with a five-line
RAM cache without the primitive at all.

---

## 6. Housekeeping — measured, with recommendations

### 6.1 The census has drifted in two places. Both are good news.

- **`camstack.db` is no longer on shfs.** `df` reports `/data` on
  `/dev/nvme1n1p1` (btrfs, NVMe, `/mnt/cache`), not `/mnt/user`. **D96's lever 1
  — ranked first in every write-volume argument in the 2026-08-13 census, and
  listed there as the one open item — appears to be DONE.** Every "commits
  offered to the checkpoint lottery" argument in that document now sits on top
  of a direct NVMe write instead of a 43× FUSE multiplier. The census's §5
  question 6 should be re-asked rather than assumed open.
- **`device-runtime-state` is populated: 704 rows / 117,848 bytes.** D131's
  redirect works; the census measured 0.

### 6.2 VACUUM — not needed, and it is not close

```
page_count 86,675 × page_size 4,096 = 355.0 MB
freelist_count 146 pages           =   0.598 MB  (0.17 %)
auto_vacuum = 0
```

**99.83 % of the file is live data.** A `VACUUM` would reclaim ~600 KB, needs
~355 MB of free scratch, and takes a global write lock for the duration. **Do
not run it.** The database is large because `tracks` carries 114 MB of JSON
position arrays (§1.1) — that is a retention/shape question, not a slack
question.

### 6.3 WAL — healthy

`camstack.db-wal` is **5,018,192 bytes (5.0 MB)** against
`wal_autocheckpoint = 1000` pages (≈4.1 MB), `journal_mode = wal`. It is sitting
just above one checkpoint threshold, which is the normal steady state. D96's
pathological range was 15–33 MB. **No action.**

### 6.4 The June leftovers — safe to delete, operator's call

| File | Size | Date |
| --- | ---: | --- |
| `camstack.db-wal.preswap-1111` | 4.26 MB | 2026-06-30 |
| `camstack.db.preswap-1111` | 1.64 MB | 2026-06-30 |
| `camstack.db.preswap-1112` | 1.64 MB | 2026-07-01 |
| `camstack.db.rekey-bak` | 1.55 MB | 2026-06-30 |
| **total** | **9.1 MB** | **45 days old** |

Verified: each opens read-only and contains **135 objects** — full database
snapshots taken before the 2026-06-30 device-id rekey (referenced in that
session's worklist). **No code in the repo references `preswap` or `rekey-bak`**
(`grep` over `packages`, `server`, `scripts`: zero hits) — they are manual
operator backups, not machine-managed state. They are pre-analytics-growth
snapshots, so they cannot serve as a recent restore point.

*Recommendation: delete all four.* 9.1 MB is not the reason — a stale
`camstack.db.*` sibling next to a live SQLite file is a foot-gun during an
incident, when someone greps the directory at 2 a.m. Also present and harmless:
`b2-device_settings_kv.json`, `b2-integration_settings.json` (2 B / 607 B) and
`ns-migration-old-tables.json` (2.2 KB, the Aug-4 namespace migration's rollback
data — keep until the AI profiles are confirmed good).

### 6.5 Two leftovers inside the database

- **244 rows still keyed `__device-state:*` in `addon-device-settings`** — the
  pre-D131 layout, superseded by the 704 rows in `device-runtime-state`. The
  legacy read fallback keeps them harmless, but they are exactly the "leftover
  that describes the right design" CLAUDE.md warns about: a future reader finds
  two device-state stores and has to work out which is live. *Recommendation:
  confirm the per-device migration is complete, then drop the prefix.*
- **41 empty `:addon-settings` / `:addon-devices` tables**, including five
  `core-block-<uuid>:addon-settings` for core blocks that no longer exist
  (`core_blocks` itself is at 0 rows). Created on demand, declared nowhere, 4 KB
  each. Cosmetic — but they are 28 % of the 148 that prompted this question.

### 6.6 One observation worth a second look

`notification-center:liveness` has grown **263 → 730 rows in one day**
(638 `device-online`, 90 `device-offline`, 2 `node-online`). Its annotation says
retention is *"none, deliberately — one row per device plus one per node,
bounded by the installation"*, and explicitly forbids pruning against the device
directory (a prune is work destroyed on a fallible read, D49/D130). That rule is
right and should not change. But 728 device subjects against 704
`device-runtime-state` rows is worth confirming: **if the installation really
holds ~700 devices this is correct and bounded; if it holds ~370, then subjects
are being minted for device ids that never existed, and nothing will ever remove
them.** Cheap to check, and the answer decides whether this is a non-issue or a
slow leak in a store that by design cannot self-clean.

---

## 7. Questions for the operator

Batched, each with a recommendation.

1. **Do we accept the restatement in §4** — that the 44-item backlog is a
   *classification* debt, and that emptying it correctly leaves 39 of 44
   collections on their current mechanism?
   *Recommendation: yes.* It is what the guard actually measures, it is the
   cheap half, and it is the half that answers the question nothing in this repo
   answers today.

2. **Phase 1 in one commit, or batched over five?**
   *Recommendation: one commit.* Annotations change no behaviour, the guard
   enforces the annotate/delist pairing atomically, and a partial pass leaves
   the backlog in a state where nobody can tell "not yet done" from "decided to
   leave".

3. **Do the three Phase-2 migrations ship, or is ~200 lines not worth the
   deploy?**
   *Recommendation: ship the first three.* Not for the lines — for the fact that
   three notification stores currently keep their mirror on a failed load
   *because of where `clear()` sits relative to an `await`*. That is a one-line
   accident away from the flood D130 fixed, in the subsystem where it hurts
   most.

4. **`texts` and `device-mutes` — migrate, or leave and just test the failure
   direction?**
   *Recommendation: migrate `device-mutes` (a clean fit), leave `texts`.*
   `texts` is a single-row scalar snapshot that degrades a malformed row
   half-by-half instead of skipping it; forcing it into a keyed-map primitive
   trades a good local design for uniformity.

5. **The framework home for `DurableLedger` — this session, or deferred?**
   *Recommendation: deferred, and decoupled.* It unblocks three stores holding
   3, 4 and 0 rows. Fix `cluster-node-history`'s read-per-write with a small RAM
   cache instead — same win, no release train, no third copy of the primitive.

6. **`camstack.db` is on NVMe, not shfs (§6.1). Is that deliberate and
   permanent?** If yes, D96's lever 1 is closed and the 2026-08-13 census's one
   remaining open item should be marked done.
   *Recommendation: confirm and record it in an ADR* — several documents still
   reason from a 43× FUSE multiplier that no longer applies, and that is the
   kind of stale premise that makes a future design over-conservative. Check
   the backup story once: Unraid's Appdata Backup walks the share, and a
   cache-only path may sit outside it.

7. **Delete the four June `preswap`/`rekey-bak` files (9.1 MB)?**
   *Recommendation: yes.* No code references them, they predate the analytics
   growth so they are useless as a restore point, and a stale `camstack.db.*`
   sibling is a hazard during an incident.

8. **The 244 legacy `__device-state:*` rows — drop them?**
   *Recommendation: yes, after confirming the D131 per-device migration is
   complete.* Two device-state stores where one is live is precisely the
   "leftover that reads as verification" failure.

9. **`notification-center:liveness` at 730 rows (§6.6) — how many devices does
   this installation actually have?**
   *Recommendation: check before doing anything.* If ~700, nothing is wrong. If
   ~370, a store that by design never prunes is accumulating subjects for
   devices that never existed, and that needs its own fix — not a relaxation of
   the no-prune rule.

10. **Two schema issues found while classifying, neither a durable-state
    problem — file them separately?** `share_view_tokens` validates every share
    link with an unindexed `json_extract` full scan (§3.2); `storage_locations`
    latches its load guard before the load, so a failed `loadAll()` is never
    retried and the operator's persisted settings are silently overwritten
    (§3.1).
    *Recommendation: file both; the `storage_locations` one is a real data-loss
    path and does not need the primitive to be fixed.*
