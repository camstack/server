---
id: D323
title: "A timer may keep its poll when the QUESTION becomes a predicate — and a name map is a lookup for the page, never a read of the collection"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/plate-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/vehicle-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/plate-gallery-provider.ts
---

## Context

[D320](./adr-0320-a-walk-that-answers-a-question-is-bounded-single-flighted-and-never-on-a-timer.md)
retired a 10 s timer that drove a 1.26 M-row walk, and its remedy was a Refresh
button: *"no timer starts a whole-collection read."* The audit in
`docs/design/2026-08-31-timer-driven-collection-reads.md` then listed seven more
timer-driven reads and said each one is owed the same treatment.

Item 6 is `UnassignedFaces.tsx:259` → `faceGallery.listRecentFaces`, every 30 s
→ `FaceStore.listAllRecentFaces`, a page loop bounded at
`FACE_SWEEP_MAX_PAGES` (1 000) × `FACE_SWEEP_PAGE` (1 000), `offset`-paged,
plus an unbounded `identityStore.listIdentities()`.

**The operator refused the remedy and named a better one.**

> *"Va bene il refetch continuo, ma devono essere query ottimizzate al massimo,
> cachate dove possibile."*
>
> [Continuous refetch is fine, but the queries must be optimised to the maximum, cached where possible.]

That is not a softening of D320. It is the observation that D320's rule has two
halves and the audit only carried one of them forward. A Refresh button is what
you are left with when the question genuinely cannot be made cheap — the media
residue is 1.26 M rows and no index makes "how many are relocatable" a range
scan. It is not the remedy for a question that was expensive **because nobody
expressed it**.

**Why the faces sweep existed, in its own words.** The docblock was explicit:
*"`limit` counts rows that PASSED the filter, never rows that were discarded.
That is the whole reason this pages instead of asking the store for `limit`
rows: with `filter:'unassigned'` the newest N rows may be entirely assigned
while matches wait just beyond them."* Correct reasoning from a false premise.
The premise was that `filter` could not be a store predicate — *"a computed
predicate"*. All four views are predicates:

| view | predicate |
| --- | --- |
| `unassigned` | `where: { assigned: false }` |
| `recognized` | `where: { assigned: false }`, `whereNot: { recognizedIdentityId: null }` |
| `identified` | `whereNot: { recognizedIdentityId: null }` |
| `all` | none |

Two of them name null, and that is the reason this could have been quietly
wrong. Before [D312](./adr-0312-a-filter-names-null-and-a-method-that-answers-with-a-number-refuses-a-predicate-it-cannot-apply.md),
`whereNot: { f: null }` compiled to `(f IS NULL OR f != NULL)` — TRUE for a NULL
row and NULL for every other, i.e. **precisely the rows it was asked to
exclude**. A gallery that reported "no recognized faces" forever would have
looked exactly like a gallery with no recognized faces. Verified against the
live hub before shipping: 1 612 rows, `{assigned:false}` → 1 444,
`whereNot {recognizedIdentityId:null}` → 247.

**And the cost was never where the file said it was.** The docblock justified
the sweep by row WIDTH — *"every face row carries a JSON `embedding`… 10.8 KB
average"* — and recorded the table at *"372 rows / 4.0 MB"* on 2026-08-25. Both
are stale. D304 drained the embeddings into the vector index, so a projected row
is 23 B narrower than an unprojected one, measured. The table is **1 612 rows**,
4.3× the recorded figure in six days, on a table nothing bounds but
`pruneCapOverflow`. The defect was never the bytes per row; it was that the
work grew with the TABLE while the answer did not.

**The second half: `listIdentities()`.** Unbounded, unprojected, on every poll,
to build an `id → name` map for a page. The table holds **4 rows** — and the
vehicle twin behind `RecentPlates` holds **0**. The bytes are nothing. The
shape is the whole point: a question proportional to a collection, asked on a
timer, to decorate a page; carrying no `limit`, so past
`SETTINGS_QUERY_DEFAULT_ROW_CAP` it would hand back a name map missing entries
and shape-identical to a complete one. The obvious fix — cache it — is the one
[D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
forbids: a second copy in the consumer, stale by design on the one write an
operator makes (here, a rename).

## Decision

**A timer may keep its poll when the question it asks is a PREDICATE whose cost
is the answer.** D320's rule is unchanged for a walk; this is the other branch
of it. Concretely, four rules:

1. **A view is pushed into the query, or it is not a view.** Every filter a list
   method exposes compiles to a store predicate in ONE place
   (`faceFilterPredicate`), so `limit` is the store's limit and one statement is
   the whole answer. A predicate naming null goes through D312's `IS NULL` /
   `IS NOT NULL` path and is proved against a fixture holding BOTH populations —
   a fixture where every row matches passes against a query that ignores the
   filter, which is the bug.

2. **A predicate needs its index, and "we added an index" is not "the query uses
   it".** Every gallery read of these two collections was
   `SCAN … | USE TEMP B-TREE FOR ORDER BY`: a full scan plus a sort of the whole
   table to return the newest 500. Measured with `EXPLAIN QUERY PLAN` over a
   20 000-row copy of the faces schema:

   | query | before | after |
   | --- | --- | --- |
   | newest N | `SCAN + TEMP B-TREE` | `SCAN USING idx_faces_ts` |
   | newest N unassigned | `SCAN + TEMP B-TREE` | `SEARCH USING idx_faces_assigned_ts (assigned=?)` |
   | newest N recognized | `SCAN + TEMP B-TREE` | `SEARCH USING idx_faces_assigned_ts (assigned=?)` |
   | one identity's faces | `SCAN + TEMP B-TREE` | `SEARCH USING idx_faces_identity_ts (recognizedIdentityId=?)` |

   The sort disappearing is the point: with an ordered index the statement stops
   at the `LIMIT`. A bound caps what comes BACK; only the index caps what is
   READ, which is why `listRecentPlates` — bounded at 200 since it shipped —
   still sorted its whole table.

3. **A name map is a LOOKUP for the page.** `IdentityStore.namesFor(ids)` /
   `VehicleStore.namesFor(ids)`: `whereIn` over the ids the page references,
   `columns: ['name']`, an explicit `limit`, and **no round trip at all when
   the page references none** — which is the `unassigned` view, the one the
   operator lives in. This is not a cache, so D224 is satisfied by construction:
   there is no second copy to go stale, and a rename is visible on the next
   poll. The owner of the fact is the store, and the store answers in one
   indexed `IN`.

4. **A read whose window it cannot take whole REFUSES.** `limit` from the caller
   is honoured verbatim at any table size — asking for 500 and getting 500 is
   being served. A read the caller did not bound (an unbounded list, the
   `suggestionConfidence` order which cannot stop early, the plate text corpus)
   asks for `CEILING + 1` and throws when it gets it. Ranking the part that fit
   is "most certain among the newest N", the exact defect that order was added
   to remove, and it is invisible in the rows returned (D295 r2, D320 R3).

`offset` goes with the sweep and does not come back: the recognizer UPSERTs into
both collections continuously, so page two at `offset: N` starts N rows past a
set that may have gained or lost its first N (D295 r1).

## Consequences

**Per poll, measured on a 3 000-row fixture** (the live table is 1 612 and
growing; the caps permit 29 × 250 = 7 250):

| view | before | after |
| --- | --- | --- |
| `unassigned`, limit 500 | 1 query / 1 000 rows | 1 query / 500 rows |
| `recognized`, limit 500 | 4 queries / 3 000 rows | 1 query / 60 rows |
| identity name map | 1 unbounded query, always | 1 `whereIn` of the page's ids, or **none** |

The `recognized` line is the shape claim: the work stopped being proportional to
the table and became proportional to the ANSWER. Nothing about the rows returned
can see that — both versions return the same 60 faces.

**Nothing is single-flighted and nothing is cancellable, deliberately.** D320's
first rule exists because a walk outlived its caller and ~500 of them
accumulated. A bounded statement settles; there is no walk left to join or to
retire. Saying so is part of the record: if a future change reintroduces a loop
here, it also reintroduces the obligation.

**What still walks.** `FaceStore.pruneCapOverflow` and `PlateStore`'s twin keep
their page loops. They must touch every row to ACT on it and they run on the
maintenance pass, not on a request — the shape D320 permits. They now project
the four scalars their docblock already claimed they read.

**Three latent defects surfaced rather than introduced**, each forced by the
work rather than chosen:

- `rowToFace` never normalised `embeddingModelId`, so SQL NULL has been leaking
  into a `string | undefined` field on every row written before 2026-08-20 —
  confirmed on a live row. The test that pins *"no own property holds null"*
  could not see it: the FAKE omitted the key for a column the seed never wrote,
  where the engine SELECTs it and returns NULL. **Projecting the read made the
  fake model the column, which is what exposed it.**
- `deleteIdentity` / `deleteVehicle` detached by listing the whole buffer and
  comparing in JS. Past the engine's row cap that detaches the rows that fit and
  leaves the rest pointing at a deleted owner, silently.
- `listAllRecentPlates({})` carried no `limit`, so `searchPlates` has been
  searching the newest 2 000 plates and reporting it as a search of all of them.

**What it costs.** Three new b-trees on `faces` and two on `plates` — tens of KB
at present size, maintained at one UPSERT per track that produces a face or a
plate read. The first `declareCollection` after this ships builds them over the
existing rows; at 1 612 and 50 rows that is imperceptible, unlike D312's
1.25 M-row case.

**What it does NOT license.** "Keep the timer" is conditional on rule 1. A site
whose question is not expressible as a predicate is still D320's: bounded,
single-flighted, operator-driven, and `null` when it cannot answer. The other
five clear defects in the audit are untouched by this record.

## Enforcement

Two spec files, each asserting SHAPE — round trips, rows materialised, and the
predicate/projection the store was ASKED for. Nothing asserts wall clock.

- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-gallery-poll-shape.spec.ts`
  — one round trip per poll; `rowsRead` equal to the answer, not the table; no
  `offset`; the predicate per view; `embedding` absent from the projection; the
  refusal past the ceiling beside a caller `limit` served at the same table
  size; the identity lookup asking for exactly the page's ids and for nothing
  when there are none; the index declarations. **Plus an oracle**: the retired
  JS filter is replayed over the same 3 000-row fixture and the pushed-down
  predicate must select an identical result set, for all four views. No shape
  assertion can see a predicate that silently matches nothing.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/plate-gallery-poll-shape.spec.ts`
  — the same for the vehicle name map, `deleteVehicle`'s predicate, the corpus
  read's explicit bound, and the plate indexes.

One existing test was CHANGED rather than added, and it is worth naming:
`face-review-query.spec.ts` asserted `issued.length > 1` for the confidence
order — *"it did NOT stop after the first page to find it"*. That pinned the
sweep, not the contract. One statement covering the window satisfies the
contract in one round trip.

Fifteen implementing lines were each removed and the guarding test observed RED
before being restored.

**No guard script.** D320 already recorded that "a timer must not drive a
collection walk" could not be stated precisely enough to be cheap; "a list
method's filter must reach the store" is no easier — a JS `.filter()` after a
query is sometimes exactly right (the confidence RANK still is). Review is what
catches this, and the two specs are what stop it regressing where it has already
been fixed.
