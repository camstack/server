---
id: D474
title: An event id is the rowid, and a reference to one keeps the type it already had
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
  - packages/addon-post-analysis/src/pipeline-analytics/rebuild-source-loader.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-shared.ts
last-verified: 2026-10-03
---

## Context

`pipeline-analytics`'s three event tables keyed their rows with 36-character
UUID strings. On the live hub that cost **263 MB of a 1 117 MB settings
database** across 2.1 million motion, audio and object rows — and it was paid
**twice** per row, once in the row and once in the primary-key index.

The shorter-string options were considered first and all fail for the same
reason: they shrink an index, they do not remove one.

- **A shorter UUID / base62 key** — a 22-character key still needs its own
  unique B-tree beside the table. Half the bytes, the same structure.
- **A ULID** — sorts by time, which would have made the range scans prettier,
  and still needs its own index.
- **A natural composite key** (`deviceId + timestamp + trackId`) — wider than
  the UUID it replaces, not narrower, and it is not unique: a frame emits
  several object events for one device at one instant.

An `INTEGER PRIMARY KEY` in SQLite **is** the rowid. The table's own B-tree is
the key, so the primary-key index stops existing rather than merely getting
smaller. No string does that, at any length.

Two preconditions shipped before this record: `insert` honours `autoPrimaryKey`
(it omits the key column so SQLite assigns it), and `insert` **returns** the id
the row actually got. With an auto key, the insert is the only place the id is
knowable — which is why the write had to learn to answer before any of this was
expressible.

What did not work first: the id was minted by the PRODUCER at four (really
five) construction sites, and two of them — the package detector and the frame
processor — used the id as something other than a key. The detector's
`pa-pkg-<entryId>-delivered` id WAS its idempotence gate, the only reason a
restart does not re-deliver every parcel on a doormat; the frame processor
stamped a UUID on an event minutes before anything wrote it. A mechanical sweep
of `readonly id: string` in that addon also breaks face identities, zones, media
locations, videoclips and photo-enrollment samples, none of which are event ids.

## Decision

**An event id is a NUMBER. A reference to an event id held somewhere else keeps
the type it already had.**

`MotionEvent.id`, `AudioEvent.id` and `ObjectEvent.id` are `number` — the rowid
SQLite assigned. Everything that merely POINTS at an event stays as it was, and
the boundary does `String(id)`:

- a **media owner id / media key**, because a key is a URL component
  (`event:<id>`, `events/<id>` in a training archive);
- `recordId` on a notification, and `eventId` on an outward projection;
- `Track.bestEventId`, a pointer HELD on the track row and read back by the
  viewer — and one that may hold a trackId instead;
- `KeyEvent.id`, which is an event id OR a trackId OR a media key;
- the viewer's own timeline `ObjectEvent`, which is a view model built from a
  TRACK (`trackToTimelineEvent`), not from a hub event row.

Stringifying a rowid is lossless, and widening those contracts would push the
same choice onto every consumer, including the viewer and the published SDK.

A producer that cannot choose an id builds a **DRAFT**
(`ObjectEventDraft` / `MotionEventDraft` / `AudioEventDraft` =
`Omit<…Event, 'id'>`), inserts it, and composes the event from what came back.
A draft never reaches anything that owns media, names an event on the bus, or
feeds a notification rule. An insert that did not land yields **no event**: the
branch logs what it dropped and returns, because an invented id puts
`event:NaN` in a media key and the next pass re-does the work anyway.

A producer that needed its id to be DETERMINISTIC keeps that key, off the
primary key: `ObjectEvent.idempotencyKey` (declared as a column, nullable, only
the package detector writes it) carries the same `pa-pkg-<entryId>-delivered`
text it always did. The detector matches on it OR on `String(id)`, so a row
written before the table was rebuilt still pairs with the pick-up that follows
it.

**The code assumes the table has already been rebuilt with an INTEGER key.**
There is no migration here, by decision: the existing rows are rewritten
offline, at server shutdown, by the operator.

## Consequences

- The primary-key index on all three event tables ceases to exist. The
  (deviceId, timestamp) and trackId/frameId indexes are unaffected.
- `SettingsRecord.id` stays `string` — it is the generic store's shape, shared
  with every TEXT-keyed collection — so every event READ converts at the
  boundary (`Number(r.id)`), in the store and nowhere else.
- `settingsStore.insert` answers `string | number`, so the event store narrows:
  a string on one of these three collections means the table in front of it is
  still TEXT-keyed. It returns `null` and WARNS with the deviceId rather than
  pretending the write failed silently.
- A producer can no longer pick an event id. Anything that needs a stable,
  producer-chosen handle needs a column of its own, as the detector now has.
- The bus payload for `PipelineAnalyticsDetectionEvent` now carries a numeric
  `eventId` (it is the id, not a reference). `advanced-notifier` reads it out
  of a loosely-typed `data` bag; a consumer comparing it to a string will stop
  matching.
- Adding `idempotencyKey` to `ObjectEventSchema` is a cap change, so
  `npm run codegen` is part of it.

### Citation note

Code comments about the event KEY cite `D474` — this record. Comments about the
`insert` precondition that shipped ahead of it (`settings-store.cap.ts`,
`data-store-provider.cap.ts`, `sqlite-settings-backend.ts` and their specs) cite
`D473`, which the docs index gives to an unrelated allocation-rate record merged
the same day. The number was double-booked before this record existed; D474 is
the one that decides how an event is keyed.

## Enforcement

Review, plus three things that fail loudly:

- `npm run typecheck` — the change is expressed in the types, which is why the
  53-project sweep was the worklist. `packages/addon-post-analysis`'s tsconfig
  EXCLUDES `__tests__`, so a fixture is only checked by running it.
- The fake settings store in
  `packages/addon-post-analysis/src/pipeline-analytics/__tests__/test-helpers.ts`
  now ASSIGNS the key for an `INTEGER PRIMARY KEY` collection and returns it.
  Without that, a store that forgot to read the insert's answer still passed —
  the exact shape of green-on-a-live-bug this repo has been bitten by twice.
  Verified by removing it: 22 of 23 `event-store.spec.ts` tests fail.
- The package detector's restart-safety specs fail (15 of 34) if the draft stops
  carrying `idempotencyKey`. Verified the same way.

Nothing checks the rule's SECOND half — that a reference keeps its own type.
That one is review only, and the tell is a `String(...)` with a comment saying
which of the three things (media key, pointer on another row, outward
projection) the caller is holding.
