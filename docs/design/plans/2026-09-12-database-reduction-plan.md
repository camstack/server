---
title: Settings database reduction plan — 1,117 MB
status: draft — to be reviewed together
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/store/**
  - packages/addon-pipeline/src/recorder/addon/**
---

# Database reduction plan — 1,117 MB

**This is a plan, not a change.** The numbers come from a copy of the live
database, never from the live file (D468), attributed by table and by column.

## 0. The state, measured

| table | data | indexes | rows | B/row |
| --- | ---: | ---: | ---: | ---: |
| `pipeline-analytics:tracks` | 212 MB | 3 MB | 30,457 | 7,285 |
| `pipeline-analytics:media` | 135 MB | **149 MB** | 534,306 | 265 |
| `pipeline-analytics:motion-events` | 126 MB | **115 MB** | 1,674,141 | 79 |
| CLIP + arcface vectors | 98 MB | — | 49 | 2.1 MB |
| `recorder:segment-hours` | 66 MB | 1 MB | 4,036 | 17,239 |
| `pipeline-analytics:audio-events` | 32 MB | 26 MB | 383,184 | 87 |
| `pipeline-analytics:object-events` | 30 MB | 16 MB | 99,947 | 316 |
| `pipeline-analytics:stats-5m` | 16 MB | 17 MB | 213,987 | 79 |

Retention: everything 11 days (`retentionMode: follow-recordings`), `media` three
weeks. **It is not accumulation**: they are rows that weigh too much.

## 1. The pattern that runs through four tables: UUID keys

```
motion-events   id ~36 char   "0000005c-5bb0-45cc-8392-134b9c4acc5e"
audio-events    id ~36 char
object-events   id ~36 char
media           id ~60 char   "event:<uuid>:snapshot:1788363763546"
```

A textual UUID is paid for **twice** — in the row and in the primary-key
index:

| | id in the row | PK index | total |
| --- | ---: | ---: | ---: |
| `motion-events` | 60 MB | 83 MB | **143 MB** |
| `media` | 32 MB | 47 MB | **79 MB** |
| `audio-events` | 14 MB | 18 MB | **32 MB** |
| `object-events` | 4 MB | 5 MB | **9 MB** |

**263 MB — 24 % of the database — are identifiers.**

### The options, and why only one holds up

**A. `INTEGER PRIMARY KEY` (rowid alias).** In SQLite an `INTEGER PRIMARY
KEY` **IS** the rowid: the table itself is that B-tree, and **the primary-key
index does not exist**. The 153 MB of PK indexes are eliminated and the id in the row
goes from 36 bytes to a varint of 4-6. **~228 MB.**

**B. Shorter UUID** (base64url of the 16 bytes: 22 characters instead of 36).
~90 MB. But the ids change anyway, so if migrating, A is the way to go.

**C. Composite natural key**, as `stats-5m` already does
(`1436|audio-dbfs||1788252300000`). ~25-30 characters, orderable in time, but
an order of magnitude worse than an integer.

**D. ULID / KSUID**, 26 orderable characters. Same order as B.

**A is the only one that changes the order of magnitude**, and the reason is structural:
it is the only one that makes an index disappear instead of shrinking it.

### What makes A non-trivial

The ids **are not isolated**. `media.ownerId` points to the ids of motion/object
events — that is how the media cleanup decides what is orphaned
(`media-reclaim.ts` → `motionEventIds(ownerIds)`) — and the notification-center
carries `audioEventId`. Therefore:

1. the migration is **coordinated**: new id + rewrite of every `ownerId`;
2. it must be done in one transaction per table, or the cleanup deletes live media;
3. the ids travel to the client and into notifications: an integer is fine as a
   React key or in an API call, but **every notification already sent that cites
   an id becomes a dead reference**;
4. sequential integers **collide in a merge between databases**. Today sqlite is
   the hub's alone and they are never merged, so it is not a problem — but a
   restore into a different database, or a second hub, would make it one.

**Recommendation: A, but last**, and only after everything else is live and
stable. It is the biggest prize and the only irreversible one.

## 2. The `media` indexes — 149 MB on 135 MB of data

Seven indexes, three of which are `(something, size)` variants:

```
PK=47MB  owner=34MB  location_size=17MB  kind_device_size=16MB
location=15MB  device_ts=11MB  device_size=10MB
```

They smell of indexes added for the storage accounting queries and never removed.
**But an index is not removed on intuition.** The rule is D447's:
`EXPLAIN QUERY PLAN` on the statement the store **really prepares** — spying on
`prepare`, never a hand-rewritten SQL, because it was exactly that difference
that hid the wrong plan for two days.

Procedure: spy on `prepare` for a real working window, collect the distinct
statements, `EXPLAIN` each, and remove only the indexes that **no
plan names**. Prudent estimate: **30-50 MB**, zero risk to the data.

## 3. The rest, in order of value/risk ratio

| | intervention | saving | notes |
| --- | --- | ---: | --- |
| **3.1** | compressed `segment-hours.paths` | **~50 MB** | 99 % of the table; paths that share the prefix compress better than the positions. D471's codec already exists. |
| **3.2** | rounded `object-events.bbox` | ~5 MB | same float tail as the positions: `{"w":1089.6000000000001,"h":398.40000000000003}`. Same function, already written and tested. |
| **3.3** | `media` indexes (§2) | 30-50 MB | subject to measurement |
| **3.4** | `motion-events` retention | **~120 MB** | 1.67 M rows in 11 days = 152 k/day. **A product decision, not a technical one**: those events mostly feed aggregates, and 11 days may be far more than needed. Zero code, one configuration. |
| **3.5** | UUID keys → `INTEGER` (§1) | **~228 MB** | last |

Already done: **D471**, `tracks` from 212 to ~54 MB as the rows are
rewritten.

## 4. What I would NOT do

- **Move the positions to files.** 30,459 files of ~1.5 KB on 4096 B blocks
  occupy **122 MB allocated** to hold 45 — against the 29 MB of the
  same content compressed in the column. Plus 30,000 inodes, a second place
  to delete from, a window of inconsistency between row and file, and 30,000 more files
  in the backup walk (which D27 already records as the cause of a stall).
  Files pay off when the blob is much larger than a block — that is the case
  of `media`, not of a trajectory.
- **Filter the positions in SQL.** The coarse prefilter is already in SQL
  (envelope-overlap, 380 rows → 45). The exact per-position test would run
  on the database's **synchronous and shared thread**, which is precisely what
  D447 fought: a wrong plan held it for 4-7 s and the whole cluster queued up. And D471 made it
  impossible anyway by compressing the column.
- **Touch the vector chunks** (98 MB in 49 rows). It is the normal shape of a
  vector index: it is its cost, not a waste.

## 5. Proposed order

1. **3.1 + 3.2** — small, the codec exists, verified with the tests already
   written. **~55 MB.**
2. **3.3** — measure, then remove. **30-50 MB.**
3. **3.4** — an answer from the operator, not a change. **~120 MB.**
4. **3.5** — the id migration, when everything else is stable.
   **~228 MB.**

From **1,117 MB** to about **550-600 MB** without losing any data, of which the first
two steps are already worth ~100 MB and ship today.

---

# Post-shipping update — 2026-09-12, evening

The plan above was written at 1,117 MB. **It has been executed in part**, and the
numbers below come from a migrated copy of the live database plus the measurement
of the real file after application. Where the plan above and this section
diverge, **this one prevails**.

## What was shipped, and what it yielded

`1.2.275` carries D474 (`INTEGER` event id), D475 (motion episodes), D476 (the
owner type in a media key). The data migration ran with the container stopped: **71 s** of rewriting, **55 s** of `VACUUM`,
`integrity_check: ok`, total downtime **2 min 11 s**.

| | before | after |
| --- | ---: | ---: |
| Database file | 1,130 MB | **814 MB** |
| `motion-events` (data + indexes) | 126 + 115 MB | 55 + 28 MB |
| `audio-events` | 32 + 26 MB | 14 + <8 MB |
| `object-events` | 30 + 16 MB | 21 + small |

**−316 MB, −28%.** The primary-key indexes of the three tables have
*disappeared*: an `INTEGER PRIMARY KEY` **is** the rowid, so that structure
ceases to exist. It is the part of the saving that does not show in the row
count.

The `VACUUM` is not an extra: without it the migration **worsens** the
symptom, because it rebuilds the tables and the old pages remain on the freelist —
measured, 1,280 MB against the 1,130 it started from.

D475 does not appear in this table because it acts on *future* rows. Its
effect measured in production, on a real window:

```
durationMs=27512  edges=[0, 3882, 6829, 15045, 16022, 25921, 26824]
```

One row for a 27.5 s episode with seven high edges kept as
offsets. The same movement, with the 5 s heartbeat, produced ~6 rows.

## Two items of the plan above remain excluded, for the reasons already written

During the session I re-proposed both without remembering that section 4
had already rejected them **with better measurements than mine**: the vector chunks
are the normal shape of an index, and positions on files would cost 122 MB
allocated against 29. They remain excluded. An item rejected with a number is not
reopened with an intuition.

## The items still open, re-measured after the migration

| # | Item | Weight | Blocker |
| --- | --- | ---: | --- |
| A | `tracks` | **211 MB**, 7,285 B/row | none |
| B | `media`: redundant `id` + its autoindex | **30 MB** of index alone | `media-store` refactor |
| C | `media`: two suspect pairs of indexes | **~24 MB** | needs `EXPLAIN` |
| D | `recorder:segment-hours` | **67 MB** in 4,036 rows | none |
| E | `stats-5m` (two collections) | **26 MB** | retention choice |
| F | `metrics:node-load-samples` | **10 MB** | find out who reads it |
| G | `sensor-events` | 207 rows | orphan table |

### B — `media.id` is demonstrably derived

Discovered while looking for a hole in the migration: `media` has **`ownerKind` and
`ownerId` as separate columns**, and `id` is their concatenation with `kind` and
`timestamp` — exactly what `buildKey` produces (`media-store.ts:510`).
The migration verified the consistency between the three columns on **528,559 rows
out of 528,559**, so the redundancy is not a hypothesis.

Cost: ~60 characters per row plus `sqlite_autoindex_pipeline-analytics:media_1`
at **30 MB**. Removing the column means giving `media` an `INTEGER PRIMARY
KEY` and addressing reads by `(ownerKind, ownerId, kind, timestamp)`, which
is already the way `deleteForOwner` and the per-owner reads
query. D476's codec already knows how to build and read the key, so
the only new work is the read path by `id`.

**It is not only space**: as long as `id` exists, there are two ways of naming the
same row, and it is the same class of defect that D476 has just eliminated
from the keys.

### C — the indexes must be measured, not deduced from the name

`idx_media_location` (14 MB) has the same leading column as
`idx_media_location_size` (17 MB), and `idx_media_device_ts` (10 MB) the same as
`idx_media_device_size` (9 MB). It **looks** like redundancy, and that is not enough: D447
showed that a badly chosen index holds the database's synchronous thread for 4-7 s
every five minutes and the whole cluster queues up. The rule is already written there —
`EXPLAIN` on the statement the store **really prepares**, spying on `prepare`,
not on a hand-rewritten SQL.

### F — a table nobody had counted

`metrics:node-load-samples`, 10 MB, does not appear in the plan above. Before
touching it, the question that has already given the useful answer on `stats-5m` must be asked:
**who reads it?** On `stats-5m` the answer was "two debug custom actions, no UI, no
decision path" — and it changed the proposal from "delete" to "roll-up", because a year of
baseline cannot be rebuilt.

## Correctness, not space: the orphans

These do not reduce the database significantly, but they are a leak that
grows, and the session found all three:

1. **676 orphaned `media` rows.** The cascading *exists and is wired*
   (`pruneEventsBefore` → `deleteForEvents`), so 676 out of 300,559 is not a
   missing mechanism: it is the 0.2% that slips through. Two candidate causes, **neither
   demonstrated**: `deleteForOwner` is best-effort per row, so a single error
   leaves the row without stopping the rest; and the motion marker's still
   is written *after* the event insert, so a prune that happens in between
   orphans it as soon as it is born. **How to tell them apart**: if the orphans' timestamps
   are all on the retention edge it is the prune, if they are scattered it is the
   best-effort.
2. **Retention will never sweep them**: it hooks onto the event, which no longer
   exists. A sweep is needed that starts from the *media* and verifies the
   owner.
3. **The cleanup must delete the bytes.** Removing the row and leaving the file
   turns an orphan into a silent leak: the row is the only thing that knows
   where the blob is. It is also the reason a native `ON DELETE CASCADE`
   is not the answer — besides the fact that `ownerId` is **polymorphic** (one
   column references six tables, and the type is in `ownerKind`), and a
   `FOREIGN KEY` points to a single table. The `foreign_keys` pragma has been `ON`
   since 2026: that is not the constraint.
4. **`existingEventIds` still unions the three tables** (found by D476,
   recorded in its ADR), and the same shape is in `disk-reconcile.ts`. After
   D474 it can cause a **missed** recovery, hence a leak — never a wrong
   deletion. The direction of the error is the harmless one, but it is the
   same ambiguity that D476 eliminated from the keys.

## Proposed order

1. **A1 of the orphans** — measurement on the timestamps, one hour, no risk. It decides
   which of the two causes is true and therefore what to fix.
2. **C** — measure with `EXPLAIN`. If it confirms, ~24 MB with no downtime.
3. **B + orphans 2 and 3** — they are the same `media-store` refactor: the
   redundant column, the sweep that starts from the media, and the deletion of the
   bytes. ~30 MB plus the end of the leak.
4. **A** (`tracks`, 211 MB) — the biggest, and it must be opened by understanding *what* weighs
   beyond the positions already encoded.
5. **E + F** — roll-up, after answering "who reads it".
6. **G** — deleting a table that the code does not declare is the only item
   that is truly trivial.

A note on method, paid for today: `applyServerUpdate` updates `@camstack/server`,
**not the addons**. The hub loads the addons from `/data/addons`, and an old copy
there wins over the closure. The migration made a column `INTEGER` that
addon 1.2.223 still declared `TEXT`, and for six minutes every event insert
failed with `datatype mismatch`. The third step of the chain —
`camstack deploy` — is not optional when a migration and a schema have
to meet.

## Complete audit of the keys: 58 `TEXT`, only one is worth the migration

The operator asked to include in the next tranche **any** migratable id.
All the columns declared `primaryKey` were surveyed: **58 `TEXT`
against 3 `INTEGER`**. Measured on the migrated copy:

| Table | Rows | Avg len | MB in the rows | Autoindex | Key cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pipeline-analytics:media` | 528,559 | 43 | 21 | **26** | **47 MB** |
| `stats-5m` (the two) | 217,755 | 29 | 6 | 11 | 17 MB |
| `pipeline-analytics:tracks` | 30,583 | 36 | 1 | 1 | 2 MB |
| `recorder:segment-hours` | 4,135 | 43 | 0 | — | ~0 |
| the other ~54 | — | — | <1 | <1 | negligible |

**The criterion is rows × key length, not the number of tables.** On
`motion-events` the UUIDs cost 143 MB because the rows were 1.67 million.
A 4,000-row table saves nothing whatever the key type,
and counting 58 `TEXT` tables suggests work that the numbers do not
justify.

Three exclusions with their reason, because they are the questions that get reopened:

- **`tracks` cannot**, and not by choice: the trackId is born in RAM at spawn
  (`sort-tracker.ts:2054`, `randomUUID()`) and from that instant frames, detections,
  positions and 198,066 `track:<uuid>` media keys reference it — while the
  track is LIVE and may never be persisted (a spawn under `minHits`
  is discarded). An `INTEGER PRIMARY KEY` is assigned by SQLite at insert. It is the
  same shape of problem that D474 found in `FrameProcessor`, but there the
  solution — emit drafts and have the store assign the id — does not
  transfer, because here the id is needed by other processes before the write.
  And it would pay **2 MB out of 209**.
- **`stats-5m` is not worth it**, and the reason is counterintuitive: its key is
  not a surrogate, it is **natural and composite**
  (`<subject>|<series>|<scope>|<bucketStart>`), and it is what makes the bucket
  upsert correct. Replacing it with an integer forces a UNIQUE index
  on the four columns to preserve that semantics, and that index costs
  about as much as the removed key. Net gain ~0, with a correctness regression
  in the middle. **A natural key is not a candidate.**
- **`segment-hours`** has 4,135 rows. Its 64 MB is the 17 KB per row of the
  payload, not the key.

What remains is therefore **`media` and only `media`: 47 MB**, which is already item B — with the
demonstrated redundancy (consistency `id` = `ownerKind:ownerId:kind[:ts]` on
528,559 rows out of 528,559) and D476's codec that already knows how to build and read
that key.

A measured note: the average length of `media.id` is **43 characters, not ~60**,
because D476 has already shortened the keys — `motion:101314:snapshot:<ts>` against
`event:<uuid>:snapshot:<ts>`. Part of the saving had already been banked.

## The defect that the renumbering opened, and that must be closed in the tranche

Reported by the operator on the UI: a track of camera 101 from 17:34
showed a **night-time** thumbnail, with the internal media correct. Measured:

```
listEventMedia(eventId=101314, deviceId=101) -> snapshot of 02/09 22:35
```

The track has `bestEventId = 101314`, an object-event created TODAY (the migrated
maximum was 100,051). An event created today cannot own a media from 2
September: that row belongs to **motion #101314**.

D476 made the KEYS unambiguous and wired writers and internal probes, but
`getEventMedia` / `listEventMedia` still receive a **bare id without the type**
— a restriction I had imposed myself ("the cap inputs stay `z.string()`").
With UUIDs a bare id was unique; after the renumbering motion and object
both occupy 1..N, so it **no longer identifies a row**.

Reach: **not isolated**. Every object-event has a motion with the same number, and the
tracks with a non-empty `bestEventId` are 27,084.

Two steps:

1. **Right away, surgical**: a track's thumbnail is resolved **only** on
   object-events. `bestEventId` is always an object-event — measured 27,084 out of
   27,084, zero motion, zero audio. It does not touch the cap.
2. **In the tranche**: the type enters the inputs of `getEventMedia` /
   `listEventMedia`. It is a cap change with codegen and touches the viewer, but it is
   the only one that closes the ambiguity instead of working around it — and it must be done together
   with item B, which makes `ownerKind` the primary address of `media`.

## Task: the prune days of artifacts and mosaics must be configurable

Requested by the operator on 2026-09-12. The values **hard-wired** today were surveyed:

| value | where | today | form |
| --- | --- | --- | --- |
| `OUTBOX_RETENTION_MS` | `notification-center/index.ts:733` | **7 days** | days |
| `TIMELAPSE_EXPORT_LIFE_MS` | `timelapse/timelapse-renderer.ts:60` | **7 days** | days |
| artifact shelf (`NcArtifactStore`) | declared in `artifact-index.ts:47` | **14 d / 2,000 rows / 2 GiB** | **three limits** |
| `SUMMARY_MOSAIC_MAX_PER_RULE` | `summary/summary-mosaic.ts:46` | **200 per rule** (~3 d) | **count** |
| `OPS_LOG_RETENTION_MS` | `pipeline-analytics/index.ts:1178` | **30 days** | days |

Three things to decide before writing code, because "make the days
configurable" is not enough as a specification:

1. **The artifact shelf has THREE limits, not one** (days, rows, bytes). The
   first to trigger wins. Making only the days configurable would give an
   impression of control that is not there: an operator who raises the days to 60
   would still find the cut at 2,000 rows. All three are exposed, or
   none.
2. **The mosaic is limited by COUNT, not by days** (`keep: 200` per rule).
   It is a D480 choice: a limit enforced by the writer has no clock.
   If one wants to configure it in days, the mechanism changes, not the value.
3. **`OPS_LOG_RETENTION_MS` has a written reason to stay fixed.**
   `retention-model.ts:343`: *«the one root that must NOT follow a device
   window … deliberately NOT stretched to match a camera configured above it,
   because the audit trail is not history of the camera, it is history of the
   sweep»*. It is the log that lets a future session tell
   an eviction from a bug — which is exactly what served today for the 9.5 GiB
   leak. **Making it configurable contradicts a recorded decision**:
   if done, that record is changed and the reason is stated.

`SUMMARY_LOOKBACK_MS` and `TIMELAPSE_LOOKBACK_MS` (8 days) are **not** prunes:
they are read windows. They must be kept out of this task, or one ends up
configuring how far back a digest looks believing to configure how long
it is kept.

## Re-measured after the wipe (2026-09-13) — the plan above is superseded

The `sqlite-settings` report of 12/09 23:43, on a 394 MB database:

| object | MB | note |
| --- | ---: | --- |
| `vec_object_clip_vector_chunks00` | **82** | 29,471 vectors, **22 live tracks** |
| `recorder:segment-hours` | 65 | item D of the plan, no blocker |
| `pipeline-analytics:motion-events` | 49 | 1.64 M pre-episode rows |
| `idx_motion_device_ts` | 28 | index of the previous one |
| `pipeline-analytics:object-events` | 22 | |
| `vec_face_arcface_vector_chunks00` | 20 | 2,568 vectors |
| `stats-5m` (the two collections) | 27 | item E |
| `metrics:node-load-samples` | 10 | item F |

**Item A of the plan — `tracks`, 211 MB — no longer exists**: the wipe zeroed
it. First place is now something else entirely.

### The 82 MB of CLIP vectors are NOT a code defect

`object-clip` is **one row per track**, the cascade deletes it, and the audit
already has a dedicated scan (`embedding-orphan-scan.ts`) wired into `reclaim`, every
6 hours. The orphans come from the maintenance window's `wipe.sql`, which
deleted the tracks in SQL bypassing the cascade. They will clean themselves up:
29,471 / `maxReclaimPerScope` 2,000 ≈ 15 passes ≈ 4 days. The limit is a
deliberate blast-radius bound and must not be raised in a hurry.

### The real defect that the measurement brought out (fixed, D486)

The audit reclaimed every non-media collection with a **raw**
`settingsStore.delete`, whereas `FaceStore.delete` is `store.delete` **followed by**
`vectors.drop([faceId])`. Every `faces` row collected by the sweep left behind
its ArcFace vector, in an index reachable only by that face's id
and that no sweep walks. It is the same shape the media branch was already
armoured against — «turns an orphan into bytes nothing names» — one layer further out, and
invisible because the raw delete really deleted the row it was asked to.

Fixed with an explicit collection → reclaimer map, with no default: an audited
and undeclared collection **throws**, and `check-orphan-reclaimers.ts`
fails the build before it can happen at runtime.

### Open item: `face-arcface` has no scan of its own — and it has a trap

With D486 the face vectors leave together with their rows, so the continuous leak is
closed. The case that `delete-track-cascade.ts` documents itself remains uncovered: a hub
that starts without the `vector-store` capability builds a cascade without that leg
and prunes tracks for the whole life of the process,
and «every CLIP vector for every track deleted in that window becomes an orphan
that nothing can reach by ownership again».

**Whoever implements it must not copy `object-clip`'s `scanRefs`.** Two reasons, and
the second is serious:

1. In `object-clip` the row's id **is** the trackId, and `scanRefs` falls back on it
   when the metadata is missing. In `face-arcface` the id is the **faceId**: that
   fallback would ask «is this faceId a live track?», would answer no
   for all of them, and would delete the entire face index.
2. An **enrolled** face is exempt from retention and survives its track
   (`enrolmentExempt`, `assigned` column on the ROW). The vector does not carry that
   field in its metadata. A scan that judges on the `trackId` would delete the
   vectors of enrolled people as soon as their track expires — silently degrading
   recognition precisely for the identities the operator registered by hand.

The correct predicate is **«does the `faces` row with this id still exist?»**, not
«is the track alive»: the vector is owned by the face row, not by the
track. A bulk existence probe on `faces` is needed (today there is only
`get(faceId)` one at a time).

## Two items of the plan corrected after looking at them (2026-09-13)

### G — `sensor-events` is NOT an orphan table. Do not delete it.

The plan called it «the only item that is truly trivial: deleting a table that
the code does not declare». That is false, and the way it is false matters: the table has
a store (`store/sensor-event-store.ts`), an entry in the retention model
(`retention-model.ts:323`), an exposed capability method
(`pipelineAnalytics.getSensorEvents`) and it underpins the `device-event` notification
rule — which `notification-rules.cap.ts` documents as «SensorEventStore
insert (doorbell press / sensor state)».

Deleting it would have switched off the doorbell notifications. It is 207 rows, that is,
irrelevant space: the item existed only because nobody had verified the premise.

**The lesson, not the line:** «the code does not declare it» was a deduction, not
a measurement, and it ended up in a plan next to true numbers — where it reads as
if it had been verified too.

### D — `recorder:segment-hours`: the gain is ~40%, not an order of magnitude

65 MB in 4,036 rows = **16 KB per row**, and it is almost all the `paths`
column: the list of that hour's segments. The format of a path is
`<deviceId>/<profile>/<yyyy>/<mm>/<dd>/<hh>/<startMs>-<durMs>-<bytes>.m4s`
(`segment-path.ts`), and the directory prefix is **entirely derivable**
from the columns the row already has — `deviceId`, `profile` and `hourStartMs`.

The honest count, however, scales the item down. A path is ~54 characters, of which
~23 are prefix: removing it saves 43%, and taking `startMs` to a delta
from the hour perhaps gets to 55%. That is **~30 MB out of 394**, not the 65 the plan's
line lets one hope for.

Against: `paths` is what eviction uses to know which files to delete, and the
ledger is write-behind on every finalised segment. It is a refactor of the recordings'
eviction path for 7% of the database. **It is not the next
job**, and the reason must be written here because the big number will keep
catching the eye.
