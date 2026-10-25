---
id: D312
title: "A filter NAMES null, and a method that answers with a NUMBER refuses a predicate it cannot apply"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/filter-compiler.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/types/src/interfaces/relocate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-store.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
---

## Context

`pipelineAnalytics.countUnstampedEventMedia` is the safety gate for the pending
`eventMedia` migration: a row with `locationId: NULL` means *"wherever
`eventMedia` points now"*, so a repoint aims every such row at the new disk
while its bytes sit on the old one. Until that count answers, **152 GB /
1 254 576 rows cannot be moved**.

It timed out at exactly 60 s, on the live hub, **every time it ran since it
shipped**. It paged the whole collection at 200 rows per RPC ordered by
`timestamp` — a column leading no index — and counted `locationId` in JS.
~6 300 round trips, each paying its own sort.

That shape was chosen deliberately, and the reason was written down in three
places: *"a `WHERE locationId IS NULL` filter is not expressible through the
store's equality filter — SQL NULL semantics"*. Half true, and the wrong half.

**What was actually happening.** `where: { locationId: null }` compiled to
`"locationId" = ?` with NULL bound. SQL three-valued logic makes that
expression NULL for every row, so the filter matched **nothing** and `count`
answered **`0`**. Not "the whole table", which is what a *dropped* predicate
does and what the design note in the inventory doc assumed — a **zero**. And
zero is the single value this gate treats as "safe to cut over". The escape
hatch built to avoid an inexpressible predicate was in fact avoiding an
expressible one that silently returned the go-ahead.

`whereNot: { locationId: null }` carried the mirror defect. It compiled to
`(expr IS NULL OR expr != ?)` — the NULL-safe exclusion that exists so rows
predating a column are kept — which with a NULL parameter is TRUE for a NULL
row and NULL for every other. It selected **precisely the rows it was asked to
exclude**.

Nothing could have MEANT `= NULL`. There was no caller to preserve.

Separately: `compileFilter`'s `select` mode drops a predicate naming a field the
collection cannot express, and the rationale it carries is *"the cost is extra
rows, which the caller can still see and filter"*. That rationale is true of
`query` and **false of `count`, `aggregate` and `histogram`**, which hand back a
number. `aggregate` already refused an unresolvable *field* for exactly this
reason — *"a dropped aggregate returns a NUMBER that is wrong and looks exactly
like a real one"* — and then compiled its *predicate* forgivingly, two lines
apart. This repo has already paid once for a dropped predicate reaching a
counting method (`countStaging`, the `retrainStatus` column that did not exist).

## Decision

Three rules.

1. **A filter NAMES null.** `where: { f: null }` compiles to `f IS NULL` and
   `whereNot: { f: null }` to `f IS NOT NULL`. Neither binds a parameter. A
   comparison against NULL is never emitted, because it is never an answer.

2. **A method that answers with a NUMBER refuses a predicate it cannot apply.**
   `count`, `aggregate` and `histogram` compile in `measure` mode: an
   unresolvable field throws `UnsafeFilterError` instead of being skipped. An
   EMPTY filter stays legal there — `COUNT(*)` over everything is a question,
   unlike `DELETE` over everything. `query` keeps `select` mode and stays
   forgiving: it returns rows, and the caller can see the filter did not bite.

3. **The gate asks the cheap question first, and `null` is not zero.**
   `countUnstamped` performs one indexed existence probe (`limit: 1`) and, only
   if it hits, one indexed `COUNT(*)`, per collection — two round trips per
   lane instead of thousands. `present` decides the gate; `rows` decorates the
   refusal. `UnstampedEventMediaCount` is nullable at both levels, and every
   consumer treats "could not measure" as a refusal, never as an absence.

`pipeline-analytics:media` and `pipeline-analytics:retrain-frames` each declare
an index on `locationId`, through `declareCollection` — the migration path the
settings store already has.

## Consequences

**What the index costs.** `pipeline-analytics:media` is write-heavy: ~92 000
inserts/day today, and it holds 1.25 M rows. It gains one b-tree that every
insert must maintain (~25 bytes of index per row, ~30 MB at present size). At
roughly one insert per second, sustained, that maintenance is noise beside the
JPEG write the same call performs. The cost that is NOT noise is the one-off:
the first `declareCollection` after this ships builds the index over every
existing row on a recordings volume that is currently at 95 % and running a
drain — expect the analytics addon's boot to stall for tens of seconds to a
couple of minutes, once. It must not be deployed beside the running drain.

**What it buys.** NULLs sort first in a SQLite index, so `WHERE locationId IS
NULL` is a contiguous range from the head of the b-tree: its cost is
proportional to the ANSWER, not to the table. The question the gate must answer
fastest — *"are there none left"* — becomes one descent onto an empty range,
whatever sits behind it. A partial index (`WHERE locationId IS NULL`) would be
smaller still and free once sealed; it is not used because
`CollectionIndexSchema` carries no predicate and the schema fingerprint does not
hash one, and adding both to serve one query is a larger change than the query
earns.

**What rule 2 forbids.** A caller may no longer count with a filter naming a
field the collection cannot express. The full `packages/system` suite (3 355
tests) passes unchanged, so no live caller was relying on the old leniency — but
a future one will now meet a 400 rather than a plausible number, which is the
point.

**What rule 3 requires elsewhere.** Every consumer of a "how many are left"
number must keep the null distinction alive to the operator. The plan gate
refuses `null` in `nonBlocking` and reports it as a finding in `blocking`; the
in-job `sealing` re-count fails the job on `null` before anything is paused or
repointed. `{ present: true, rows: null }` — *some, size unknown* — refuses just
as hard as a known non-zero count, which is why presence and size are separate
fields rather than one number carrying a sentinel.

**What this does NOT change.** The relocate PASS still pages. It must visit
every row to act on it, so a predicate cannot replace its walk. Only the
QUESTION stopped paging.

## Enforcement

- `packages/system/src/builtins/sqlite-storage/__tests__/null-predicate.spec.ts`
  — both null predicates, over a structured table and a KV blob collection,
  against fixtures holding **both** stamped and unstamped rows (a fixture where
  every row is unstamped passes against a query that ignores the filter, which
  is the bug); a row that never WROTE the column, which is the oldest and
  largest unstamped population; the `measure`-mode refusal on `count` /
  `aggregate` / `histogram` beside `query` still dropping; and an
  `EXPLAIN QUERY PLAN` assertion that the planner actually reaches for the
  index — "we added an index" and "the query uses it" are different claims.
- `media-relocate-engine.spec.ts` — a **round-trip budget**: two `query` and two
  `count` calls for the whole answer, asserted over a 500-row fixture that the
  retired walk would have needed six pages for. No assertion about the returned
  number can see the shape that timed out.
- `media-store.spec.ts` — the `locationId` index is declared, so losing the
  declaration fails rather than silently reverting a fresh install to a table
  scan.
- `storage-migration-coordinator.spec.ts` — unknown refuses a non-blocking plan,
  is reported on a blocking one, and fails the job at the post-seal re-count.
- Every assertion above was disarmed by reverting its implementing line and
  observed RED before being restored.
