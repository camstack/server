---
id: D482
title: A media row is addressed by its own id, and a listing by owner names the table
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/types/src/capabilities/data-store-provider.cap.ts
  - packages/types/src/interfaces/storage.ts
  - packages/types/src/media/media-owner-key.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/system/src/builtins/storage-orchestrator/data-store-dispatch.ts
  - packages/system/src/builtins/storage-orchestrator/hub-settings-forward.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-file-url.ts
  - packages/addon-post-analysis/src/pipeline-analytics/event-media-handler.ts
  - packages/addon-post-analysis/src/pipeline-analytics/event-thumbnail-resolver.ts
  - packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts
last-verified: 2026-10-02
---

!!! note "A fusion re-key writes by id, not by upsert — the slot index still holds (2026-10-01)"

    D683's L2 fusion re-points a single-instance row to its new owner with
    `MediaStore.relocateAndReassign` (a `set` against the row's OWN `id`, which
    is the primary key here — D474's saving one level down) and a losing row's
    media with `moveOwner` (`updateWhere`). Neither goes through `upsert`
    against `idx_media_slot`, which this record's "every write an upsert
    against it" describes for a NEW capture. Nothing is contradicted: the row
    already exists, addressed by the same id it keeps, and `idx_media_slot`'s
    UNIQUE constraint still binds the write — two rows racing for one slot
    throw rather than duplicate, exactly as the index is declared to. An
    ownership move re-keys by id; the slot index still enforces uniqueness.

## Context

A media file was addressed by a COMPOSITE key that embedded a FOREIGN id:

```
<ownerType>:<ownerId>:<fileKind>[:<timestampMs>]      motion:101314:snapshot:1788363763546
```

D474 made every event id a per-table SQLite rowid alias, so motion, object and
audio each number their rows from 1 independently. D476 then split the key's
`event` owner type three ways so a key could at least say which table it meant.
Both records left the API alone — `getEventMedia` / `listEventMedia` still took
a bare `eventId` and the provider probed `motion` → `object` → `audio`, taking
the first table that owned anything. That restriction was imposed on D476
deliberately, and D476's own Decision section says the residual ambiguity is
"honest, not exact".

It was neither. Reported by the operator and reproduced here: a track from
2026-09-12 17:34 on camera 101 showed a **night-time** picture. Its
`bestEventId` is `101314`, an object event created that afternoon (the migrated
maximum was 100 051), and `listEventMedia(eventId: "101314", deviceId: 101)`
answered with one row — a `snapshot` from 02/09 22:35. An event created today
cannot own media from eleven days earlier. The row belonged to **motion
#101314**.

The probe was not a coin flip. Measured on a read-only copy of the live
database (`/mnt/mixed/camstack/migr-rehearsal/prova3.db`, 2026-09-12):

| | |
| --- | ---: |
| media rows | 528 559 |
| `ownerKind = 'motion'` | 299 883 |
| `ownerKind = 'object'` | **0** |
| `max(object-events.id)` | 100 051 |
| `max(motion-events.id)` | 1 665 459 |
| tracks with a non-empty `bestEventId` | 27 084 |

Object events own **no** media directly — their pictures hang off the TRACK —
so the probe's first rung answered for every object id in 1…100 051, and every
one of those has a motion namesake. The failure produced no error and no log
line, only a picture that did not belong to the row it was shown on.

**What was tried first and rejected.** Adding `ownerType` to the two cap
methods and stopping. That fixes the report and leaves the class open: every
address in the system would still embed a foreign id, so the next table whose
numbering changes reopens it somewhere else. The operator chose the elimination
instead.

**What the operator's argument for it got right, and where it does not hold.**
The composite key's one real benefit is that a consumer holding an owner id can
build a media address without a round trip. The argument for giving that up was
that consumers already batch-load media before rendering, so they hold the rows
and a surrogate id costs nothing. Verified in the viewer, and it is **half
true**: the track DETAIL view does exactly that (`use-track-detail-media.ts`
issues one `listTrackMedia({ trackId, deviceId })` per open and every tile
renders from the rows it already holds — 25 ms / 0.7 KB against
`getTrackMedia`'s 1 223 ms / 1 536 KB), but the list, reel and timeline surfaces
hold no media rows at all. `EventThumb` has a track id and an `<img>`, and
nothing else. So the surrogate id could not be the only address; there had to be
a second form, and it is a QUESTION rather than an address (below).

Three other things the brief said that measurement corrected:

- The reference columns are **fifteen**, not ten, plus two JSON-embedded sites
  and the vector-store metadata.
- `RetrainAnnotation.mediaKey` is **not** a media key at all — it is a
  retrain-FRAME id. Left alone.
- Four of the five viewer components named for updating (`EventMediaStrip`,
  `CropTile`, `TrackCropImage`, `TrackMediaGallery`) have **no importer**, and
  `src/data/use-track-media.ts` does not exist — `useTrackMedia` lives under
  `components/camera/theater/detail/` and is likewise unreferenced.

## Decision

**A media row is addressed by its own id. A media row's OWNER is asked for by
naming the table AND the id.**

`pipeline-analytics:media.id` is an `INTEGER PRIMARY KEY` — the rowid SQLite
assigns. Nothing in the address names an owner, a kind or an instant, so no
address can name the wrong owner's row. The primary-key index ceases to exist
(28.0 MB over 528 559 rows on the measured copy), which is D474's saving one
level down.

**The uniqueness rule moved to `slotTsFor` + one UNIQUE index.** `media.id` was
never a derived cache: it WAS the constraint. `buildKey` omitted the timestamp
for `SINGLE_INSTANCE_KINDS` (`keyFrame`, `keyFrameSmall`, `thumbnail`,
`thumbnailSmall`, `firstFrame`, `lastFrame`) so N racing re-captures of one
`(owner, kind)` addressed one row (RC-1), while every other kind carried its
timestamp and accumulated. Those two rules are now ONE derived column:

```ts
slotTsFor({ kind, timestamp }) = isSingleInstanceKind(kind) ? SINGLE_SLOT_TS : timestamp
```

with `UNIQUE (ownerKind, ownerId, kind, slotTs)` (`idx_media_slot`), and every
write an upsert against it. **Two partial indexes were the obvious shape and
the wrong one.** SQLite supports `CREATE UNIQUE INDEX … WHERE …`, but
`CollectionIndexSchema` has no predicate and `schemaFingerprint` does not hash
one — so it is a cap change — and, worse, the predicate would be a `kind IN
(…)` list: a SECOND spelling of `SINGLE_INSTANCE_KINDS`, inside DDL, that
nothing keeps in step with the TypeScript set. The brief's own worry ("if these
do not reproduce the two rules exactly, re-captures either duplicate rows or
start failing") is CAUSED by re-expressing the rule. One derived column leaves
one spelling. It is also ~8 bytes a row against the ~43 a stored composite key
would have cost (`avg(length(id))` = 43.4, measured).

**`settings-store` gained `upsert`.** `set` is already an upsert but its slot is
the PRIMARY KEY, which a collection SQLite keys cannot name. `insert` can
express the rule via the index but only by THROWING at the loser of a race — and
the loser here is a legitimate re-capture. The alternative was read-then-write
with a recovery path that recognises a UNIQUE violation **by its message,
across an RPC door**; a string match as the whole gate, losing the media row
silently the day the store rephrases its error. `upsert({ collection, conflict,
record })` is one statement, `INSERT … ON CONFLICT(<slot>) DO UPDATE …
RETURNING <pk>`, and answers with the id the row HAS. `RETURNING` and not
`lastInsertRowid`: on the UPDATE branch the latter is whatever the connection
last inserted, possibly in another table — it answers confidently and wrongly.

**`getEventMedia` / `listEventMedia` take `{ ownerType, eventId: number,
deviceId }`, and `ownerType` is REQUIRED.** This is not a "qualification" of
the ambiguity that a surrogate id would have avoided: a listing BY OWNER has no
address to make surrogate. The owner IS `(table, id)` and half of it is not a
question. `eventId` is a `number` because an event id IS one (D474) — the
rule's "a reference keeps the type it already had" covers a pointer HELD
elsewhere, not the id itself.

**The plane has two forms, and neither guesses:**

```
/addon/<addonId>/event-media/m/<mediaId>              one media row
/addon/<addonId>/event-media/o/<ownerType>/<ownerId>  the best media OF an owner
```

The bare id is GONE. It had to be: after D474 a bare number could be a media
row's id or an event id, with nothing to tell them apart. The `o/` form is what
serves the list and reel surfaces that hold no media row, and it names its
table for the same reason the cap methods do. A path that is neither form 404s.

**`EventMedia` carries its `kind` as a field.** The variant path must know a
`thumbnailSmall` is already a ready-to-serve square or it pays a Sharp encode
per request, and it used to learn that from `media.key.includes(':thumbnailSmall')`
— the kind read out of the address. A surrogate spells nothing, and the fix is
to carry the fact, not to smuggle it into another string. The ETag is derived
from `(mediaId, variant)` in one place (`eventMediaEtag`), because a 200 and a
304 that build it differently never match and the only symptom is that every
tile is re-downloaded for a year.

**The reference columns hold a `mediaId: number`, not a key.** Fifteen columns
(`faces.mediaKey`/`keyFrameMediaKey`, `plates` ×2, `identities.coverMediaKey`,
`identity-samples.mediaKey`/`sourceMediaKey`, `vehicles.coverMediaKey`,
`vehicle-samples.mediaKey`, `object-events.mediaKey`,
`stationary-objects.keyFrameMediaKey`,
`stationary-evidence.keyFrameMediaKey`, `retrain-frames.sourceMediaKey`) plus
`tracks.snapshots[].mediaKey` inside JSON and the object-embedding rows'
`mediaKey`/`keyFrameMediaKey` inside vector-store metadata. **"Resolve by query
and hold nothing" was considered per site and rejected at all but none of
them**: a face's crop and a track's keyFrame are derivable from
`listInfoByOwner`, but an identity cover, an identity sample, a stationary key
frame and a track snapshot each name a row CHOSEN among several and are not
derivable at all — and making the two classes differ would mean two ways to
find a picture. `Summary.groupShotKey` became `groupShotMediaId` and stays
DERIVED at query time (it always was).

`packages/types/src/media/media-owner-key.ts` is **kept** — `parseMediaOwnerKey`
is still the only reader of a legacy key. It can go when no stored column and
no cached client holds one: concretely, after the reset below, once
`select count(*) from "pipeline-analytics:media" where typeof(id) = 'text'` is
0 on every hub in the fleet and no `@camstack/server` older than this release
is installed anywhere. `formatMediaOwnerKey` has no remaining producer and is
retained only as the codec's other half; a future session may delete it first.

## Consequences

- **THE RESET IS A PRECONDITION, NOT AN OPTIMISATION.** There is no data
  migration here, by decision — the operator authorised resetting all tracks
  and media before launch. `declareCollection` is ADDITIVE: it will not rewrite
  an existing `id TEXT PRIMARY KEY` into an `INTEGER` one, and it will not
  backfill `slotTs`. Shipping this code to a hub whose media rows still carry
  composite ids means `put` throws (see the guard below) and every reference
  column holds a string where a number is expected. **Do not deploy it without
  either wiping `pipeline-analytics:media` (plus the fifteen reference columns
  and the two JSON sites) or writing the rewrite.** The guard makes the wrong
  order loud rather than silent, which is the most that can be done from
  inside the code.
- **`put` REFUSES when the collection is still TEXT-keyed.** `upsert` answers
  `string | number`, and a string means the table in front of it was not
  rebuilt. It logs `error` with the device and throws, rather than returning an
  address nothing can resolve — the same discipline `EventStore` applies to its
  three tables (D474), escalated from D474's WARN-and-return-null because a
  media address that does not resolve is a blank tile on every surface at once.
- **A wrong slot declaration is a LOUD failure on the first write.** If
  `MEDIA_SLOT_COLUMNS` and `idx_media_slot` ever disagree, SQLite refuses the
  statement — `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
  constraint` — rather than inserting duplicates. Verified by disarming the
  index's `unique: true`. That is why the two are declared once and spread into
  both.
- **`slotTs`'s column DEFAULT does nothing for a bulk insert.** It is declared
  `notNull` with `defaultValue: 0`, and `settingsStore.insertMany` normalises
  every row to the collection's declared column set and binds `row[k] ?? null`
  — an explicit NULL, which the DEFAULT never sees. So a bulk insert into
  `pipeline-analytics:media` MUST supply `slotTs`, and one that forgets fails
  loudly on the NOT NULL constraint rather than writing 0. Two real-SQLite
  specs found this the hard way. The default is kept for the `declareCollection`
  path (SQLite cannot add a NOT NULL column to a populated table without one),
  not as a convenience for writers.
- **An object SPREAD defeats TypeScript's excess-property check, and this
  refactor was hiding a live bug behind one.** `package-stillness-tracker.ts`'s
  `toEntry()` spread a `keyFrameMediaKey` field into a `StationaryEntry` whose
  field is `keyFrameMediaId`: every promoted or departed package entry was
  losing its key-frame reference, and no `tsc` error ever fired. Found while
  converting, not by the compiler. If a rename of this shape is done again,
  grep the spreads — the type system will not help.
- **`idx_media_owner` was NOT dropped**, although `idx_media_slot` leads with
  the same two columns. Two extra columns of key make the per-owner range scan
  wider for no gain, and `listByOwner` / `listInfoByOwner` are the hottest reads
  on this table. D481's rule, read for this table: a narrower index is dropped
  only when the wider one is MEASURED serving its queries.
- **Space is roughly a wash, and correctness was the point.** The PK autoindex
  (28.0 MB) goes; `idx_media_slot` (~25–30 MB at that row count) and 8 bytes a
  row of `slotTs` (~4 MB) arrive. D474 bought 263 MB; this record buys none, and
  saying otherwise would be a false claim in its favour.
- **`upsert` is a new method on a SYSTEM cap**, so it reaches a node only inside
  a published `@camstack/server`. An addon deploy alone cannot expose it: a hub
  running an older closure will answer "method not found" for every media write.
- **Clients break, by authorisation.** `getEventMedia` / `listEventMedia`
  reject a call with no `ownerType`, and every consumer of `MediaFileRef.key`
  sees `mediaId` instead. The operator's words: *"non ci sono altri
  utilizzatori, solo io. È un sistema in sviluppo e non importa se va
  coordinato."* [there are no other users, only me. It is a system under development and it does not matter if it has to be coordinated.]
- **`advanced-notifier` reads `keyFrameMediaKey` / `bestCropMediaKey` out of a
  loosely-typed `data` bag** on the event bus. Those are now
  `keyFrameMediaId` / `bestCropMediaId` and numeric; a consumer matching the
  old names silently stops finding them. Same shape of consequence D474
  recorded for its numeric `eventId`, and it is out of this repo's compiler.
- **The viewer's dead media components were left dead**, not converted:
  `EventMediaStrip`, `CropTile`, `TrackCropImage`, `TrackMediaGallery` and
  `useTrackMedia` have no importer. Deleting them is a separate change; what
  matters here is that the four files the brief named are not the surfaces that
  render media, and a future session must not read them as evidence of how the
  viewer works.
- **The plane's owner form re-opens one thing the id form closes**, and it is
  named here rather than discovered later: `/o/<ownerType>/<ownerId>` still
  resolves through a ladder, so a caller that names the WRONG table gets that
  table's answer (usually nothing). It cannot get another table's row by
  accident, which is the defect; it can still ask the wrong question. The
  admin-ui surfaces that hold only a polymorphic `bestEventId` ask for
  `o/track/<trackId>` where the row carries one, which is the answer the
  pre-D474 code was already converging on.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/store/__tests__/media-slot-idempotence-over-real-sqlite.spec.ts`
  — nine assertions over the REAL `SqliteSettingsBackend` (a fake store cannot
  have an index, and the index is the whole mechanism). Disarmed in BOTH
  directions:
  - `slotTsFor` → always `params.timestamp` (nothing collapses): 4 fail,
    including "N CONCURRENT captures of one slot leave ONE row (RC-1)";
  - `slotTsFor` → always `SINGLE_SLOT_TS` (everything collapses): 2 fail,
    including "an accumulating kind inserts a NEW row per timestamp";
  - `idx_media_slot` `unique: true` removed: 8 of 9 fail with SQLite's
    `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` —
    the loud failure this record relies on.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-media-names-its-table.spec.ts`
  — the reported defect reduced to a test: motion #101314 owns a snapshot from
  02/09 22:35, object #101314 owns nothing, and asking for the object event
  answers EMPTY. Disarmed by restoring the `EVENT_OWNER_TYPES` first-hit probe:
  "asking for the OBJECT event returns nothing — not the motion namesake"
  fails, showing the 02/09 row.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-address-is-not-ambiguous.spec.ts`
  — 15 assertions on the plane path, most of them about what is REFUSED (a
  bare id, a legacy composite key, an undeclared owner type, a non-numeric
  media id). Disarmed by accepting a bare id as a media row: the two
  "what is gone" cases fail.
- `packages/system/src/builtins/sqlite-storage/__tests__/upsert-addresses-a-slot.spec.ts`
  — 8 assertions on the new store method. Disarmed by pointing the `ON
  CONFLICT` target at the primary key (what `set` already does): 3 fail,
  including "a SECOND write to the SAME slot updates the SAME row".
- `npm run codegen:check` — `settings-store` and `data-store-provider` both
  gained a method, so the generated routers, `method-access-map`,
  `system-proxy`, `system-hooks` and `addon-api` all move.
- Nothing checks that a NEW caller of `MediaStore.put` stores the returned id
  rather than dropping it, and nothing checks that a reference column holding a
  `mediaId` is read back as a number rather than coerced. Both are review only
  — the same half-rule D474 and D476 each left to review, for the same reason:
  the compiler sees the type, not the intent.
