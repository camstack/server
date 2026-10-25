---
title: Migration of the event keys from textual UUID to INTEGER
status: draft — approved in principle by the operator, details to be reviewed
covers:
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
---

# Migration of the event keys to `INTEGER`

**A plan, not a change.** Numbers from a copy of the live database (never the
live file — D468), attributed by table and by column.

## 1. The gain, and where it comes from

A textual UUID is paid for **twice**: 36 characters in the row and 36 in the
primary-key index.

| | id in the row | PK index | total |
| --- | ---: | ---: | ---: |
| `motion-events` (1,674,141 rows) | 60 MB | 83 MB | **143 MB** |
| `media` (534,306) | 32 MB | 47 MB | **79 MB** |
| `audio-events` (383,184) | 14 MB | 18 MB | **32 MB** |
| `object-events` (99,947) | 4 MB | 5 MB | **9 MB** |

**263 MB out of 1,117** — 24 % of the database.

`INTEGER PRIMARY KEY` in SQLite **IS** the rowid: the table itself is that B-tree
and **the PK index does not exist**. It is the only option that makes an index
disappear instead of shrinking it — the alternatives (shorter UUID, ULID, natural
key) stop at ~90 MB because they only shrink it.

`tracks` is NOT on the list: 30,457 rows, a 1 MB PK index. There is nothing to
gain.

## 2. The machinery already exists, but is half-wired

The backend documents `autoPrimaryKey` with a docblock that describes exactly
this case — *«le tabelle append-only che vogliono la chiave gratis sono
esattamente quelle che verrebbero rotte inventandone una»* [the append-only tables
that want the key for free are exactly the ones that would be broken by inventing
one] — and **`insertMany`
honours it**: it omits the column from the list and lets SQLite assign the rowid
(lines 701 and 715).

**The single `insert` does not.** It does `const id = record.id || randomUUID()`
unconditionally, and events are inserted one at a time
(`store.insert.mutate` in `event-store.ts`). A 36-character UUID bound to an
`INTEGER` column is not convertible: SQLite stores it **as TEXT** and
that row **stops being a rowid alias**, silently.

**Stage 0 is therefore a precondition, not an optimisation**, and there is already
a correct implementation forty lines further down to copy from.

## 3. What breaks

The operator accepted the loss of the notification center's references.
The rest, for completeness:

- **`media.id` contains the owner's id**:
  `event:<uuid>:snapshot:1788363763546`. Changing the event's id changes the
  media key.
- **Media keys are URLs**: `/addon/<addonId>/event-media/<mediaKey>`. Every
  notification already delivered that carries an image points there.
- **`face-store.keyFrameMediaKey` is persisted** on the enrolled identities —
  operator data, not cache.
- `media.ownerId` is what the cleanup uses to decide what is orphaned: 72 write
  sites in `pipeline-analytics` alone. **An error in the coordination
  transaction makes live media get deleted.**

## 4. The staging, and why it changes the risk

The risk is **not uniformly distributed**: the face gallery is touched only by
the smallest stage.

| stage | table | gain | what it touches |
| --- | --- | ---: | --- |
| **0** | `insert` honours `autoPrimaryKey` | 0 | no data — precondition |
| **1** | `audio-events` | 32 MB | **no media** (an audio event has no image). Only `audioEventId` in the notification center, which the operator accepted. **It is the pilot.** |
| **2** | `motion-events` | **143 MB** | motion media (thumbnails), ephemeral |
| **3** | `object-events` | 9 MB | object media |
| **4** | `media.id` itself | 47 MB | **the enrolled identities** and every media URL |

**Stages 1-3 are worth 184 MB of the 263 without touching a single enrolled
face.** Stage 4 is worth 47 MB and is the only one that touches operator data:
it must be decided separately, not dragged in for completeness.

## 4-bis. What the plan had NOT foreseen (discovered while implementing, 2026-09-12)

Two things emerged on contact with the code and change the size of the work.
Both are written here because the plan assumed them solved.

**1. Per-table staging does not work.** The id is defined ONCE for
all three event types, at two levels: `BaseEventFields` in
`packages/types` and `COMMON_BASE_COLUMNS` in `event-store.ts`. Doing only
`audio-events` as a pilot would mean forking two shared definitions
and reuniting them two stages later — more work and more risk than doing them
together. **Stages 1-3 must be done in one go** (184 MB), `media.id` stays separate.

**2. `insert` must RETURN the assigned id, and today it returns `void`.** This is the
real blocker. With a key assigned by SQLite the caller no longer knows it,
and it REALLY needs it right afterwards:

```ts
await this.eventStore.insertAudio(ev)
this.notificationCenter?.onAudioEventPersisted(ev)        // reads ev.id
await this.captureMotionMarkerStill(deviceId, ev.id, ...)  // builds a media key from it
```

A placeholder id is not enough: it would end up on the bus and inside the media keys. So
`settingsStore.insert` / `dataStoreProvider.insert` must return the rowid
(`better-sqlite3` already exposes it as `lastInsertRowid`) — which is a **capability
signature**: codegen, and live only inside a published `@camstack/server`
closure (D16).

**Consequence for the order.** The migration is not "change a column type":
it is a capability change plus a public-contract change
(`MotionEvent.id`, `AudioEvent.id`, `ObjectEvent.id` become numbers for the API
and the viewer too) plus a rewrite of the data with the server stopped. Three jobs, not
one.

## 5. Migration mechanics

A primary key cannot be updated: the table is **rewritten**. For each
stage, in ONE transaction:

1. create the new table with `id INTEGER PRIMARY KEY`;
2. copy the rows assigning rowids, keeping a `uuid → integer` map;
3. rewrite `media.ownerId` (and `media.id`) for the rows of that `ownerKind`
   using the map;
4. swap the tables.

**The constraint that matters: that thread is synchronous and shared.** 1.67 M rows are
a few seconds of SQLite work, but every configuration read in the cluster queues
behind it — which is exactly what D447 fought (4-7 s of stall and
the whole cluster stopped). So the migration must be run **at boot, before the
addons register**, not hot.

**Discarded alternative: let it age out.** Retention is 11 days, so
in theory it would be enough to write the new rows with the new schema and wait. It is
not possible: a table has **one** primary-key type, not two. Either it is
rewritten, or it is not migrated.

## 6. Verification

For each stage, before considering it done:

- `dbstat` per table before and after — the declared gain is measured, not
  projected;
- the media cleanup must find **zero** new orphans (`media-reclaim` on
  a copy, before the real one);
- a single `insert` on an `autoPrimaryKey` table must produce an **integer**,
  and the test must prove it by disarming the stage-0 line;
- the row count before and after must match exactly.

## 7. Proposed order

Stage 0 and stage 1 (`audio-events`) **together**, as a pilot: 32 MB, no
media, and they prove the mechanics on a tenth of the volume before touching the
million and a half rows of `motion-events`.
