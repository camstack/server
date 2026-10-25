---
title: Database remediation — one door, a schema that exists in code, and tables worth querying
last-verified: 2026-08-26
covers:
  - packages/system/src/builtins/sqlite-storage/**
  - packages/types/src/interfaces/storage.ts
  - scripts/lib/parse-storage.ts
---

# Database remediation

> **This page is a PLAN, not a description of the current code.** It records a
> sequence decided on 2026-08-03 and carries a dated status box per phase; the
> `last-verified` ratchet is deliberately not armed on it (`covers:`, not
> `applies-to:` — D145), because a phase that has not been built cannot be
> "verified against the code". The status boxes below are the thing to read, and
> each states its own date. Re-read against the code on 2026-09-15: every
> status claim above still held — phase 2 is still entirely absent (no
> `schema_version`, no migration ledger), the `table*` bypass is still gone from
> the cap, and the phase-4 mechanisms are still in place, with one addition
> noted in that section.

> **STATUS, re-verified 2026-08-14. Phases 0 and 1 are DONE; phases 2 and 3 have
> not started; phase 4 is half done.**
>
> **BUILT — phase 1, the whole deliverable.** `storage-orchestrator` owns the
> public surface and dispatches to engines registered behind
> `data-store-provider`; SQLite is one engine ([D44](../decisions/adr-0044.md)).
> One filter compiler with a mode, then `deleteWhere` / `updateWhere` on the
> door — G1 and G2 closed, which is what made **B2 closable, and B2 is closed:
> the `table*` bypass is gone** (and was losing data on the way out). The
> prediction this page makes about the vector store came true almost
> immediately: sqlite-vec moved INTO the sqlite builtin as a registrant rather
> than a second door, with no flag and no fallback.
>
> **BUILT, and it removes two of the creation paths below.** The map corrected
> "four different ways" to five; two of those five are gone. `ensureTable` and
> the `table*` methods went with B2, and **legacy auto-create on first write was
> removed.** `SqliteSettingsBackend` fail-fasts on an undeclared collection
> outside the `CANONICAL_KV_COLLECTIONS` allowlist, and two guards hold the
> line — `scripts/check-collection-declarations.ts` (access implies a
> declaration) and `scripts/check-collection-namespacing.ts` (an addon may not
> take a bare collection name; five had).
>
> **NOT built — phase 2, entirely.** No declarative schema modules, no
> create-from-schema/verify-against-schema, no migration ledger and no
> `schema_version`. The guard this phase names does not exist, and the rule it
> would enforce is visibly broken: `better-sqlite3` is imported today by
> `addon-post-analysis`, `system-backup`, `device-manager` and `node-root`,
> and `scripts/migrate-auth-caps-only.ts` still reaches the engine through
> `node:sqlite` — the exact B6 lesson this page records.
>
> **STARTED 2026-08-19 — phase 3.** Two tables are gone, and the mechanism this
> page assumed did not exist now does: `RETIRED_COLLECTIONS` +
> `purgeRetiredCollections` drop a table whose declaring code was deleted in the
> same change, at every boot of the settings engine
> ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).
> The instance is the device half of the integration-registry — `devices` and
> `device_settings_kv`, 0 rows against 974 live devices. **Nothing was exported,
> deliberately: both tables were empty.** `lost_and_found` (18 738 rows, a
> `.recover` artefact) was dropped by hand the same evening. Two sibling purges
> landed with it, both gated on a POPULATED successor — `RETIRED_SETTINGS_ROWS`
> for whole rows
> ([D182](../decisions/adr-0182-a-fleet-is-rows-not-a-blob-and-a-per-device-question-costs-one-row.md))
> and the addon-owned `retireRootKeys`
> ([D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md)).
> Still not done: any `VACUUM`.
>
> **HALF built — phase 4.** The connection tuning landed 2026-08-06 (see the box
> in that section, [D55](../decisions/adr-0055.md)). Scheduled `ANALYZE` /
> `PRAGMA optimize`, the `EXPLAIN QUERY PLAN` audit and any generated-column
> work are untouched.
>
> **NARROWED 2026-08-25 — phase 4.** Two of the three "untouched" items above
> no longer are, and the third stays deliberately out. `EXPLAIN QUERY PLAN` is
> now attached automatically to every slow-call WARN, on the same connection
> that ran the statement (`sqlite-settings-backend.ts:351,1205`,
> `packages/system/src/builtins/sqlite-storage/query-profiler.ts`) — the audit
> this paragraph asked for is a live mechanism, not a one-time review. And the
> live 900 MB database had in fact never been `ANALYZE`d: `sqlite_stat1` did
> not exist, so the planner guessed between two fitting indexes and got it
> wrong — 727 ms walking 150 133 rows of one camera where the right plan is
> 3.2 ms. It now runs once, 120 s after boot, only if the statistics are
> missing (`analyze-stats.ts`). **This is deliberately not "on a schedule"** —
> the module doc is explicit ("never on a schedule") because a full `ANALYZE`
> of that database is a 14 s synchronous statement on the one thread the
> cluster reads configuration through, so re-analysis on staleness stays a
> separate, undecided question. `PRAGMA optimize` and any generated-column work
> remain untouched.
>
> **Deliberately dropped.** The ORM. It left the plan on 2026-08-03 (see the
> decision below) and nothing since has brought it back.

Operator, 2026-08-03: optimise the tables, delete the ones nothing creates any
more, guarantee the schema can be recreated from code, expand the JSON blobs
into columns where SQLite gets faster for it, and put **one capability** in
front of all of it — *"non si deve mai accedere al db puntualmente, perché un
giorno potremmo cambiare db"* [the db must never be accessed ad hoc, because one day we might change db].

This is the plan for that. It is sequenced so each phase pays for the next, and
so nothing destructive happens before the thing that makes it safe exists.

## What we actually know

Not opinion — this came out of building the generated
[storage map](../reference/storage.md), and each item bit during that work.

> **Superseded in detail by
> [2026-08-03-storage-table-map.md](2026-08-03-storage-table-map.md).** That
> table-by-table map corrected three premises below: creation paths are **five**
> (`ensureTable` is a whole path this page missed, carrying the device and
> integration registries), **30 of 33** declared tables have real columns (not
> 23), and the auth tables are declared rather than raw DDL — there is no raw
> `CREATE TABLE` in first-party source at all. It also found **zero unaccounted
> tables** on a live hub, which reshapes phase 3 from "find the orphans" into
> "delete dead code and empty tables". Read the map for anything table-specific;
> this page keeps the sequencing argument.

**A table can be created four different ways.** The canonical KV list in
`SqliteSettingsBackend`; per-addon scoped variants auto-created on first write;
`declareCollection` with typed columns; and raw `CREATE TABLE` run by addons
that own their schema. Nothing reconciles them. *(No longer true as written —
auto-create-on-first-write is gone and an undeclared collection now fail-fasts.
The argument this premise supports is unaffected: the paths that remain are
still not reconciled with each other.)*

**The same operation has three call shapes** — `declareCollection({collection,
columns})`, `declareCollection(name, columns)`, and the tRPC
`declareCollection.mutate({…})`. The map's first cut matched two of them and
silently lost the largest tables in the system; **6 tables became 33** once the
third was handled. A human grepping for a schema hits the identical trap.

**The JSON-blob shape is narrower than it first looks — measured, after an
earlier draft of this page overstated it.** The `(id TEXT PRIMARY KEY, data TEXT
NOT NULL)` shape is the CANONICAL settings collections and their scoped
variants. The domain tables are already columnar: **23 of the 33 declared tables
have real columns**, led by `pipeline-analytics:tracks` (24), `:faces` (15),
`notification-center:outbox` (14), `:object-events` (12) and `:media` (9). Of
the remaining 10, several (`api_keys`, `oauth_sessions`, `user_passkeys`) are
raw-DDL tables whose columns the extractor simply does not read.

That matters twice: phase 4 is much smaller than "convert the database", and
there is already enough real schema for a typed layer to be worth discussing.

**Scoped variants exist on a live hub and in no source file.** `<addonId>:<canonical>`
is created on demand and declared nowhere, so the schema on disk is a superset
of the schema in the repository — permanently, by design.

**Columns cannot be extracted statically.** There is no single declaration
point, which is why the generated page publishes none.

## Decision, 2026-08-03: unify FIRST, ORM later or never

Operator: *"se invece iniziamo a bonificare tutto senza inserire ORM? Se un
giorno vogliamo passare ad ORM avremo un solo entry point. Intendo di unificare
tutte le API di connessione a storage settings."* [What if we started cleaning everything up without introducing an ORM? If one day we want to move to an ORM we will have a single entry point. I mean unifying all the connection APIs to storage settings.]

Adopted, and the table map argues for it more strongly than the ORM proposal
did. An ORM closes **none** of the seven bypasses, types **none** of the
capability boundary (228 casts survive it), and adds **none** of the six missing
methods — the absence of a bulk delete is why every retention sweep is an N+1
loop. "One door" is achieved by deleting the other doors, not by re-flooring
the room behind one of them.

The sequencing argument is the decisive one: with a single entry point, adopting
Drizzle later is swapping one implementation behind one interface. In the other
order it is adopting Drizzle across seven entry points at once, while the schema
is still unenumerable.

**So the ORM leaves the plan and becomes a later, optional, internal choice.**
The recommendation stands if it is ever picked up (Drizzle: one artifact yields
both DDL and types, no engine binary, and `sqliteTable` being a plain function
models the 51 dynamic scoped tables cleanly). It is no longer on the path.

### What this does NOT excuse

"No ORM" must not become "no schema in code". Two things Drizzle would have
supplied still have to be built, and they are the point of phase 2:

- **A migration ledger.** `user_version = 0` — none exists. This is not an ORM
  feature; it is an ordered, recorded, idempotent list plus a version row, and
  it is small enough to own.
- **Declarative schema modules**, so the schema can create an empty database AND
  verify a live one. Hand-rolled loses only the automatic diff-to-migration
  generator, which is a convenience, not the requirement.

### Revised phase order

| Phase | What |
| --- | --- |
| 0 | Reconcile — **done**, see the table map. Zero unaccounted tables. |
| 1 | **Collapse every entry point into one.** The whole deliverable now. |
| 2 | Schema as code + migration ledger + a guard that covers EVERY sqlite entry point |
| 3 | Delete the dead code and empty tables the map lists |
| 4 | The measured storage wins (they do not depend on 1–3 — see below) |
| — | ORM: optional, later, behind the door built in phase 1 |

### Phase 1, concretely — the doors to collapse

From the map's bypass list, in the order their risk suggests:

1. **B1 — the `settingsBackend` tRPC router takes an arbitrary `collection` with
   no namespace scoping**, from every forked addon. Any addon can read or write
   any other addon's settings. This is an isolation hole, not just an
   inconsistency, and it is the first thing to close.
2. **B2 — `ensureTable` plus six `table*` methods**: a second creation path the
   extractor did not see, carrying the device and integration registries.
3. **B3 — `ISettingsStore`**: the two-implementations-of-`AddonSettingsView`
   split that already caused a live outage, and is still visible in the data.
4. **B4 — the raw `Database` handle**, plus three leftovers describing a
   `device-persistence` capability that does not exist. Delete the leftovers:
   a comment describing the right design reads as verification.
5. B5 `system-backup` opening every `.db` it finds; B7 the `StorageManager`
   shim; B6 `scripts/migrate-auth-caps-only.ts`.

**The guard lesson from B6:** it uses `node:sqlite`, not `better-sqlite3`. The
guard this plan originally proposed would not have caught it. Check every route
to the engine — `better-sqlite3`, `node:sqlite`, and direct `.db` file access —
or it grants a false sense of enforcement.

## Goals, and one explicit non-goal

1. **One door.** A single capability every read and write goes through, so the
   storage engine is an implementation detail.
2. **The schema exists in code**, completely enough to recreate an empty
   database and to diff a live one against it.
3. **Nothing orphaned.** Tables no code creates are identified and removed —
   after (2), never before.
4. **Query what is queried.** Columns and indexes for the hot paths; JSON stays
   where JSON is the right answer.
5. **Faster, measured.** Every performance claim has a before/after number.

**Non-goal: replacing SQLite.** The point of the single door is that we *could*,
not that we will. Designing for a migration we have not decided on is how the
abstraction becomes worse than the thing it wraps.

## Phase 0 — see the real schema (prerequisite for everything destructive)

Nothing here changes data. It exists so phase 3 is not guesswork.

- **A reconcile command.** Read `sqlite_master` on a live node, classify every
  table against the generated map: *canonical*, *scoped variant* (matches
  `<addonId>:<canonical>` where the addon is installed), *declared*, or
  **unaccounted**. Report row counts and on-disk size per table.
- **Ship it as a capability method**, not a script — it must work on an agent
  without shell access, and it becomes the operator-facing "what is my database
  doing" view.
- **Size and cost telemetry.** Bytes per table and rows per table, so "optimise"
  has a target rather than a feeling.

Exit criterion: for a real hub, every table falls into a known class or is on
the unaccounted list with an explanation.

## Phase 1 — one declaration path

The map proved the ambiguity, so this is the first thing to collapse.

- **One entry point** for declaring a collection. The tRPC route becomes a
  *transport* of it, not a rival API; the port interfaces in addons
  (`addon-notifiers`, `addon-provider-homeassistant`, `addon-ai`) forward to it.
- **Names must be static.** `declareCollection(this.collection, …)` currently
  hides two tables from any static reader. A collection name should come from a
  module-level constant so it is greppable and generatable.
- **Regenerate the map**; the unresolved list should shrink to the scoped-variant
  rule alone, which is genuinely dynamic.
- **A collection declares its engine** ([D44](../decisions/adr-0044.md)), and the
  orchestrator routes on it. This is the whole preparation a vector store needs:
  the engine is chosen at declaration, so adding one is a registration. Do not
  build the engine here — the embeddings are still float64-as-decimal-text
  (phase 4) and nothing can consume them until they are not.

This phase is mechanical, has no data risk, and immediately makes the generated
map complete enough to trust for phase 3.

## Phase 2 — the schema exists in code

"Assicurare la mappatura su codice per ricreazione quando necessario." [Ensure the mapping in code so it can be recreated when necessary.]

- **A declarative schema module per owning addon** — table, columns, types,
  indexes — as data, not as imperative `CREATE TABLE` calls. Imperative DDL is
  why columns cannot be read statically today.
- **Create-from-schema and verify-against-schema** built on the same
  declaration: one code path creates an empty database, another diffs a live one
  and reports drift. A schema that can only create, never verify, drifts
  silently.
- **A real migration story.** Today it is `CREATE TABLE IF NOT EXISTS` plus
  auto-declare, which cannot change a column type, add a NOT NULL, or backfill.
  Minimum viable: an ordered, recorded, idempotent migration list with a
  `schema_version` table. It does not need to be clever; it needs to exist and
  be replayable.
- **A guard** (`scripts/check-storage-schema.ts`, wired into CI): every table the <!-- drift-ok: the guard this phase proposes; it does not exist yet -->
  map finds must be reachable from a declared schema, and no package outside the
  storage builtin may import `better-sqlite3`. A rule nothing checks has already
  been broken somewhere.

## Phase 3 — remove what nothing creates

Only now, and only with phase 0's report and phase 2's guarantee that anything
still wanted can be recreated.

- Classify the unaccounted list: renamed collection, removed feature, or a
  scoped variant of an addon that is no longer installed.
- **Export before dropping.** A table nobody can name is exactly the table
  someone will miss; dump to a file under the data dir first.
- **Drop behind an explicit operator action**, never automatically at boot. An
  automatic dropper plus a mis-parse is data loss, and this repo has already
  seen "a wrong first diagnosis" cost real recordings.

  > **Superseded 2026-08-19 by
  > [D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md).**
  > The drop IS automatic, at every boot — because a hand `DROP` cleans one
  > machine once, and the next restore of any earlier backup brings the schema
  > straight back. What replaces the operator gate is that the list is not
  > derived: a table is listed in `RETIRED_COLLECTIONS` only in the same change
  > that deletes its last declaration, and the drop reports the rows it
  > destroyed (`info` at zero, `warn` otherwise). The row- and key-level purges
  > keep a stronger gate still — they REFUSE while the successor collection is
  > empty, and an evidence read that FAILS counts as empty.
- **`VACUUM` once afterwards**, not routinely — it rewrites the whole file.

## Phase 4 — expand JSON into columns, where it measures

The instruction is conditional (*"se aumentano le performance"*) and that
condition should be honoured literally.

**Measure first, and expect a short list.** The hot analytics tables are ALREADY
columnar (see above), so this phase is not "convert the database" — it is
finding the specific predicates still served from inside a JSON blob. Phase 0
gives rows and bytes per table; the candidates are high-row tables filtered by
something other than `id` that are still KV-shaped.

**Prefer the cheap mechanism.** SQLite can index into JSON without changing the
storage format: a `GENERATED ALWAYS AS (json_extract(data,'$.deviceId')) VIRTUAL`
column plus an index on it turns a full scan into a seek, with **no rewrite and
no migration of existing rows**. That is the first thing to try, per table, with
a measured before/after. Promote a field to a real stored column only where the
generated column is not enough.

**Do not convert everything.** Settings collections are read whole, by id, and
are the wrong place to spend this. The win is where row counts are large and the
predicate is not the primary key.

**Also in scope for "optimise the tables"**, and cheaper than any schema change:
confirm WAL mode, run `ANALYZE` / `PRAGMA optimize` on a schedule, review
`mmap_size` and `cache_size`, and check that the indexes that *do* exist are
being used (`EXPLAIN QUERY PLAN`) rather than assumed. Several of these may
close the gap on their own, and each is reversible.

> **Done 2026-08-06 — the connection tuning half.** `cache_size`, `mmap_size`
> and `journal_size_limit` are now set from `sqlite-pragmas.ts` and asserted on
> the open connection, and a gated truncating checkpoint bounds the WAL
> ([D55](../decisions/adr-0055.md)). It was driven by a measurement rather than
> a review: 210 of 2,561 syscall samples on the live hub were `pread64` on
> `camstack.db`/`-wal`. Two premises this page shares with everyone else were
> wrong — the page cache was ~16 MiB (better-sqlite3 compiles
> `SQLITE_DEFAULT_CACHE_SIZE=-16000`), not ~2 MiB, and `synchronous` was already
> `NORMAL` under WAL. **Still open from this paragraph:** scheduled `ANALYZE` /
> `PRAGMA optimize`, and the `EXPLAIN QUERY PLAN` audit. And the tuning only
> narrows the window — the structural fix is getting the analytics stores off
> hub-main's thread, which is not in this plan either.
>
> **Extended 2026-09-11
> ([D452](../decisions/adr-0452-a-process-tables-cost-is-the-forking-caller-not-the-scan-and-a-wal-checkpoint-runs-off-the-writers-thread.md)),
> and it is the "structural fix" this box says is not in the plan, arriving
> anyway.** The gated truncating checkpoint is still there
> (`wal-maintenance.ts`), but it was never the whole exposure: under
> `synchronous = NORMAL` a WAL database fsyncs at the CHECKPOINT and nowhere
> else, and SQLite runs the auto-checkpoint INSIDE the commit of whichever
> writer crosses 1000 frames — measured at 1–10 s on the saturated shared
> drive, on the one thread every configuration read in the cluster queues
> behind. The PASSIVE checkpoint now runs on a dedicated worker thread over its
> own connection at the same 1000-frame rule (`wal-checkpoint-policy.ts`,
> `wal-checkpoint-worker.ts`, `wal-checkpointer.ts`), and the settings
> connection's own `wal_autocheckpoint` is raised to
> `SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES = 10_000` — a bound that only engages
> if the worker dies, and `WalCheckpointer` logs an ERROR when it becomes the
> only checkpoint.

> **Narrowed 2026-08-25.** The `EXPLAIN QUERY PLAN` audit now runs
> continuously — every slow-call `WARN` carries the plan for the exact
> statement shape that triggered it, taken on the connection that ran it
> (`sqlite-settings-backend.ts`, `query-profiler.ts`,
> `statement-shape.ts`). Separately, `ANALYZE` now runs once, 120 s after
> boot, if and only if `sqlite_stat1` is missing (`analyze-stats.ts`) —
> deliberately a one-shot gap-fill, not the recurring schedule this section
> asked for; the live database had never been analysed at all, and the
> planner had picked the 727 ms plan over the 3.2 ms one for want of it. Still
> open: `PRAGMA optimize` and any generated-column work.

## Phase 5 → now phase 1 — one capability in front of the data

This was the last phase; the decision above makes it the FIRST and the main one.
The operator's actual requirement: **no pointwise DB access anywhere.**

> **Amended 2026-08-03 — the door is the storage ADDON, not this cap.** As
> originally written, "one capability" meant `settings-store` — which is the SQL
> addon's own cap, so unifying on it makes SQLite the interface rather than an
> implementation. The target is the shape that already exists for files:
> `storage-orchestrator` owns the public surface and dispatches to engines
> registered behind an internal collection cap (`data-store-provider`, sibling of
> `storage-provider`). A vector store then becomes a registrant rather than a
> door. See [D44](../decisions/adr-0044.md); it also revises the query-surface
> paragraph below.

- **A single storage capability** exposing declare / get / set / query /
  delete / transaction. Everything else — addons, routers, the admin UI —
  goes through it.
- **Enforced, not requested.** The CI guard from phase 2 fails a build where any
  package outside the storage builtin imports the driver. Doctrine here is
  explicit that a rule nothing checks is already broken.
- **Scope resolution in ONE place.** A writer and a forked reader must not be
  able to disagree about which table they mean. That disagreement has already
  cost a live outage: settings written to a table a forked addon never read.
- **The query surface is the hard part.** Too thin and callers reach around it;
  too thick and it is an ORM nobody asked for. Add only on evidence — and the
  evidence is already collected: the six gaps in the map's §4.2, each with the
  caller that works around it. G1 (bulk delete) and G2 (bulk update) are not even
  new code; `tableDelete` and `tableUpdate` exist in the backend and are simply
  not on the cap, which is precisely why the `table*` bypass exists and why every
  retention path is an N+1 loop. **Closing B2 and closing G1/G2 are the same
  work.** Aggregates (G3), an expression grammar past equality (G4),
  transactions and batch insert (G5) and schema introspection (G6) follow the
  same rule: a door that cannot express what a caller needs stops being the only
  door.

## Order, and why

Phase 0 before anything destructive; phase 1 before the map can be trusted;
phase 2 before dropping a table, because "we can recreate it" must be true and
not hoped; phase 3 before measuring, so the numbers describe the schema we are
keeping; phase 4 on evidence; phase 5 once there is one declaration path to put
behind one door.

The tempting order is the reverse — write the nice capability first. That builds
the abstraction on top of a schema nobody can enumerate, which is how it ends up
with an escape hatch on day one.

## Decisions this will need

Each of these is a real choice with alternatives, so each gets its own record
rather than being settled inside an implementation PR:

- the migration mechanism (recorded list vs. declarative diff-and-apply);
- generated columns vs. promoted stored columns as the default for indexing JSON;
- how far the unified query surface goes before it becomes an ORM;
- whether scoped variants stay implicit or become declared per addon.
