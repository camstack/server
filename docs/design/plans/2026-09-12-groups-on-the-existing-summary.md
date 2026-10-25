---
title: subject groups on the existing summary — supersedes tracks-v2
status: superseded by D680 (2026-09-29) — not implemented
covers:
  - packages/addon-post-analysis/src/notification-center/summary/**
---

> **2026-09-29 — superseded by
> [D680](../../decisions/adr-0680-nearby-track-grouping-is-deleted-with-its-tables-and-its-cap-surface.md):**
> the session summary and the proximity grouping were
> deleted. This plan will not be implemented.

# Subject groups on the existing summary

**This is a plan, not a change.** It supersedes
`2026-09-11-tracks-v2-subject-groups.md`, which stays on record because its
measurements still hold: the *container* has changed, not the goal.

## 0. What changed since the draft of the 11th, and why

The draft proposed a new table, `TrackGroup`, next to `Track`. Three
measurements from today made it disproportionate:

| measurement | value |
| --- | ---: |
| summaries with **a single** member | **94.6 %** (14,132 out of 14,940) |
| tracks that the grouping would merge (probe §9 of the draft) | **7 %**, zero on six cameras out of eight |
| columns that `TrackGroup` would add to what `summaries` already has | **three** |

A third level — summary → group → track — would be **1:1:1 in 94.6 % of
cases**. And the draft itself, at §3, had already reached half of this
conclusion: *«tracks-v2 should NOT invent a second envelope»*. The step it
was missing is that the summary is not merely to be not-duplicated: it is to be **reused as
the group**.

Comparison of the columns, which is the argument:

```
summaries (exists)   id, deviceId, openedAt, lastActiveAt, sealedAt,
                     openDeviceId, memberCount, groupShotKey
TrackGroup (draft)   id, deviceId, summaryId, openedAt, lastActiveAt, sealedAt,
                     members, keyFrameKey, primaryClass, classes
```

The real difference is `role` and `className` on the member. (The draft also counted
the sub-crops; that item was withdrawn — see §2.)

## 1. The operator's decisions, on record

- **The `groupId` to be removed does not exist.** It was an idea, not a field. The
  open question of §4 of the draft is closed: virgin ground.
- **Reset accepted.** Tracks and media can be zeroed before launch,
  so no data migration.
- **No JSON where a queryable table is needed.**
- **Do not upend things.** The concept of a track stays; grouping is a
  case to be handled, not a refoundation. (A rewrite taking the "event" as the root
  entity was evaluated and set aside: it would replace the model that
  zone rules, notifications, retrain export, timeline and viewer read today.)

## 2. The model

**No new entity.** The session summary *is* the group.

```
summaries          (unchanged)  id, deviceId, openedAt, lastActiveAt, sealedAt,
                                openDeviceId, memberCount, groupShotKey
summary-members    + role       'primary' | 'sibling' | 'child'
                   + className
```

**Two columns. No new table.**

### `member-crops` was proposed and WITHDRAWN on 2026-09-12

The first draft of this plan added a `member-crops` table for the sub-crops,
inheriting from the draft of the 11th the claim that *«two faces in one
track stop fighting for one slot, which is what they do today»*. The operator
challenged the premise — «una traccia rimane una sola persona con una faccia» [a
track remains a single person with one face] — and the measurement proves him right:

| | |
| --- | ---: |
| tracks with a face | 2,550 |
| **maximum faces per track** | **1** |

And it is no accident: `FaceStore` is documented as *«one entry per track»*, with
*«one UPSERT per track that produced a face detail … `set` replaces an existing
row»*. The 1:1 ratio is **by design**. For ONE subject, keeping the best one is
not a loss: it is the right behaviour.

The crops are moreover **already tables**, one per type, already keyed by track
(`faces`, `plates`, each with its own `trackId`). `member-crops` would be a
fourth table that duplicates the first two, and the multiplicity across TYPES — a
track with a face and a plate — is already served by the fact that they are distinct
tables.

What remains to look at, and only this: if a track should ever want to keep
**more samples** of the same face by embedding quality, that is a
decision about `FaceStore` and its upsert — not about a group table.

- **The relation sits on the edge** (`role`), not in a composite class. A dog
  carried by a person is one summary: person `primary`, dog `sibling`. A
  face inside a person is `child`. A `person+animal` class
  would multiply the taxonomy and break every class filter in the viewer
  and in the rules.
- **The summary gains nothing descriptive.** Classes present and
  envelope remain **derived** from the members. A stored derived value is a
  derived value that goes stale, and the join is immediate.

### Positions and zones sit on the MEMBER

Not to please a consumer: because **it is the member that is a
subject**. The summary answers «who was present» (`memberCount`); the member
answers «where it passed and in which zone» — which is what the notification
center needs.

During the discussion the alternative was proposed (positions relative to the
group) and discarded by the operator himself in the same sentence in which he asked for
per-member detail: the two things cannot hold together, and the detail
wins.

### People who split up: `sealedAt`, which already exists

A summary is not a permanent identity: it is an **assertion with an
interval**. When the trajectories diverge and the co-motion rule no longer
holds, the summary is **sealed** and the members continue as independent tracks.
Nothing is rewritten after the fact, because what it asserted **was true within its
interval**.

This also covers «the group can vanish»: vanishing *is* sealing.

And it drops a complication that was raised in the discussion —
membership varying over time would require a validity interval per
member. It is not needed: the summary's interval delimits its members. **A
field instead of a table.**

To be written in the code, because today `sealedAt` exists and nobody says what makes it
fire.

## 3. The best shot

**It is not chosen at the end.** `group-shot.ts` is a gate on *when* a frame
is worth a native round trip, kept in RAM on purpose: *«it is not the record of
the shot. The record is the media row the caller writes under the summary's
id»*. The shot is materialised **during** the session, every time a
candidate materially beats the one delivered. At the seal it already exists.

After a restart an open summary starts from zero and replaces the row the
first time it beats what it remembers, that is, nothing: *«a weaker shot for one
session, never a wrong one»*.

**The hole to close.** The draft proposed as a tie-break, at equal visible
members, *«fall back to `compareBestFrame` on the primary member»*. The primary
member is **not known during the session**: it depends on roles and classes that are resolved
only at the end. That tie-break is not computable at the instant the
gate decides, and must be replaced with a criterion available on the spot.

Remember what getting this gate wrong cost (D470, today): a pure argmax over
a continuous score produced **135 `getNativeCrop`/min at ~970 kB** — the
most expensive call of the addon — because `quality` rises at almost every frame of a
subject walking towards the centre; and the maximum advanced when the fetch was
*ordered*, not when it *landed*, so a summary whose first attempt
missed held a phantom maximum that nothing could beat any more.

## 4. Notifications: the digest does not exist as an entity

Today there are **two different things called "summary"**, and the collision has already
produced a failure.

| | session summary (D359) | notification summary |
| --- | --- | --- |
| when | **during**, `openOrAbsorb` at the birth of a track | **after**, retrospective |
| granularity | one camera, one continuous session | one rule, one window (lookback **8 days**) |
| id | the session's id | `summary-<ruleId>-<windowEndMs>`, synthetic |
| reads | its members | up to **2,000 tracks** per camera per window |

The notification digest **becomes pure runtime**: it reads the session summaries
in the window, composes, sends. It persists nothing of itself. Three consequences:

1. **Fewer rows to read** — 14,940 summaries against 30,583 tracks, with
   `memberCount` already computed.
2. **The mosaic is composed from already materialised shots** (`groupShotKey`)
   instead of redoing the work, with D470's protection already in between.
3. Retention holds: lookback 8 days, summaries 11.

### The mosaic needs an owner, and a real one exists

The mosaic is the only artifact that **must** survive, because it has been
delivered. Today it is archived under `ownerKind: 'event'` with a synthetic id that
was never an event's id — **675 rows, 271 MiB, +27 MiB per day on
camera 101**, and D474 made them unrecoverable because `'event'` is neither in
`OWNER_KINDS` nor among the retired ones (D480).

The natural owner is the **notification**: the outbox already has a real retention
(`pruneBefore(now - 7d)` on terminal rows, in `NotificationCenter.start`).

The constraint: the mosaic is written **inside the producer**, at composition time,
before the outbox row exists. So the owner's id is
not available when it is needed.

**The solution already exists in the repo.** `MediaStore.reown` — *«move a single media
entry from one owner to another; the new copy is written before the old one is
removed»* — is already used to re-assign the crops of **enrolled** faces and plates to
`identity`/`vehicle` at assignment time. So: write under a temporary
type, and **re-assign to the notification** when the outbox lands. The mosaic's
life becomes that of the notification, already delimited and already swept,
**without invented limits to remember to maintain**.

**Order**: D480 is implementing the weak version (own type with a limit
enforced by the writer) and should be allowed to land — it **stops the bleeding** and makes
the 9.5 GiB recoverable. The re-own is the final state, and comes later. The
objective of a job in flight is not changed while a leak is active.

## 5. The consumers — the part the draft did not have

The draft has **zero** occurrences of admin UI and of "events page", and only one of
"zone", in the list of consumers not to disturb. They are here because the
reused summary touches them.

- **Events page and timeline**: a switch between **summary** and **tracks**. The
  summary is the «what happened» view; the track is the «who moved» view.
  With 94.6 % singletons the two views almost always coincide, and the
  difference shows exactly where it is needed.
- **Notification center**: «which member passed where and in which zone» is a
  query **on the member**; «who was present» is `memberCount` on the summary. This is
  why positions and zones do not rise to the group.
- **Admin UI**: to be mapped. Nothing is written and it must not be discovered during
  implementation.
- **`dedupeFragmentItems` (viewer)** collapses the tracker's fragments client-side.
  If the summary becomes the displayed entity, that logic is redundant or
  wrong: it must be looked at, not inherited.

## 6. What NOT to do, with the numbers next to it

This section exists because on the same day I re-proposed twice things
already rejected with better measurements than mine.

- **Do not normalise `positions`.** Measured: 30,583 tracks, **1,352,354**
  positions (44 average, max 300), 145 bytes each in JSON.

  | | |
  | --- | ---: |
  | new rows | **1,352,354** |
  | data (~100 B/row) | ~135 MB |
  | index `(trackId, timestamp)` | ~60 MB |
  | **total** | **~195 MB** |
  | **compressed** positions (D471) | **~29 MB** |

  **Seven times as much**, and the repeated `trackId` alone — a 36-character UUID —
  would be 48 MB: exactly the error corrected today on `motion-events`, where
  1.67 M rows with a textual key cost 143 MB. And the
  queryability argument is weaker than it looked: the coarse question
  («did this track enter zone X?») is already answered by `zonesVisited`,
  which is a column and weighs ~0; the fine one («where was it at instant T») is
  per-track and is served by a scrub, not by a SQL query.

- **Do not optimise `tracks` for space.** `positions` was 186 MB out of 209
  **because D471's compression was not running** — the deployed addon was stuck at
  September 9, and it is the same defect that caused the events failure.
  Now it runs: with retention at 11 days the table goes down towards ~50 MB **by
  itself**. The id is worth 2 MB and is not migratable (it is born at spawn in RAM, needed before
  the row exists). The envelope is **already** normalised into four
  `REAL` columns. `snapshots`, `zonesVisited` and `classes` together make 1 MB.

- **Do not rename now.** `summary` is an unfortunate name for what it is, but
  calling it `Track` and calling the current track `TrackMember` **re-points every
  consumer** — zone rules, notifications, retrain export, timeline, viewer.
  It is the upheaval to avoid. The rename is a change of its own, cheap, and
  is done when the model is stable.

- **No groups across cameras or across different summaries.** Out of scope, declared
  here instead of discovering it later.

## 7. Sequence

0. **Media addressing** — the real prerequisite: `snapshots[].mediaId` and the
   `mediaKey`s of the ten reference columns do not exist until media
   are addressable by their own id. It is also what closes the defect of the night thumbnail
   (`listEventMedia(101314)` returns the snapshot of a motion with the same number,
   because after D474 every object id has a motion with the same number).
1. `role` + `className` on `summary-members`. (And nothing else: see the
   withdrawal of `member-crops` at §2.)
2. The seal on divergence, with the threshold **per device** and on whoever generates
   the event — never a classifier default.
3. The best-shot tie-break, replaced with a criterion computable during
   the session.
4. The notification digest as pure runtime; the mosaic re-assigned (after D480).
5. A single reader, behind a flag — the viewer timeline, as the draft said.
6. Events page, admin UI, notification center.

**The value is not the volume**, and the draft already said so: 7 % overall, zero
on six cameras out of eight. It is a feature for the case the operator named —
the family that arrives together at the entrance — and the proportion of the work must
resemble that number.

## Step 2 presupposes something that does not exist (2026-09-13)

The plan says: «The seal on divergence, with the per-device threshold and on whoever
generates the event». Before writing it I looked at what a
summary groups today, and the premise does not hold.

**A summary is one per CAMERA SESSION.** `summary-store.ts` declares it at the
top, and `openOrAbsorb` absorbs *any* track born while a summary
is open on that device. Membership is **temporal**: «you were on the same camera in the same window».
There is no co-motion, proximity or trajectory rule anywhere
in the subsystem.

One therefore cannot seal «when the co-motion rule no longer holds»: there
is no rule that could stop holding. The current seal fires when
everyone has left (no open track **and** camera quiet), which is
a different thing and works.

### The decision needed, and why I did not make it

There are two paths and they change what a summary *means*:

- **Leave membership temporal.** Step 2 disappears: divergence is not
  observable because the group never asserted spatial co-presence.
  Zero cost, and the summaries continue to say what they say today.
- **Make membership co-motion.** It needs a proximity rule with
  its per-device threshold, and it changes the meaning of every downstream summary —
  notifications, digests, mosaics — because a summary would stop saying «who was
  present together in this window» and would start saying «who was moving
  together».

The second is the feature the operator named (the family arriving
together at the entrance). It is also far more than the line step 2 seems to
ask for — and §7 of this very plan already warns: «The value is not the volume
… 7% overall, zero on six cameras out of eight … the proportion of the work must
resemble that number».

**Step 2 therefore stays suspended on a decision, not on an implementation.**

### The `primary` of step 1 is by ORDER OF ARRIVAL, not by class

A defect in the work of step 1, found by re-reading it an hour after having
shipped it. §2 illustrates the roles with «a dog carried by a person: person
`primary`, dog `sibling`», and I had copied that example into the type's
docblock — while the writer assigns `primary` to **whoever opens the summary**.

With the dog entering first, the role comes out reversed. The example describes
a CLASS priority (which subject matters most), the implementation has
a positional one, and they are not the same question.

Fixed by documenting what the code really does, and pinning it with a test that
verifies precisely the surprising case. I did **not** invent a class
priority: deciding whether a person beats an animal, a vehicle, a parcel is
a taxonomy choice that nobody has made, and putting it in a docblock
would be the least visible place possible to make it.

Consequence for §3 (the best shot): the «`compareBestFrame` on the primary
member» tie-break **would now be computable** during the session, because the
role is assigned at insert. But it would be a tie-break on the first to arrive, which
is not what §3 intends. The hole stays open until the class priority
is a decision taken.

## Proximity membership: the rule exists, the wiring has a consequence

The operator chose «they move together» and corrected my wrong reading
(«same covered area» is not the zones: *«le cose che camminano insieme sono un gruppo,
cosa c'entrano le zones»* [things that walk together are a group, what do zones have
to do with it]).

### The threshold is measured, not chosen

54 pairs of **simultaneous** tracks, six hours, eight cameras (2026-09-13),
minimum distance between the centroids during the overlap, normalised
on the framing:

| percentile | 25% | 50% | 75% | 90% | max |
| --- | --- | --- | --- | --- | --- |
| distance | 0.045 | 0.080 | **0.125** | 0.280 | 0.386 |

There is a **step between 0.125 and 0.280**: below it the subjects that are together, above
the tail of those who share only the framing. The default (`0.15`) sits in that
gap. The clearest confirmation in the data is a pair at **0.001** on camera 101,
classes `animal` and `person` — someone carrying the dog, that is, the case the
operator had named.

`summary-proximity.ts` implements the rule, pure and tested. What follows is
not yet wired.

### The consequence to accept before wiring

`summaries_open_device` is a **UNIQUE** index: the store refuses a second open
summary per camera, and it is a deliberate decision of D359 (eleven sealed rows
for a single group, on 2026-08-24).

So, with proximity membership, a track born **far** from the open group
cannot open one of its own: it remains **without a summary**. It is not
unreasonable — a group of one is not a group, and whoever was not walking with
the others was not with them — but it is a change of meaning that must be stated first,
not discovered afterwards:

- **today**: everyone framed in the same window is in the same
  summary;
- **with proximity**: only those close to the first to arrive are in the summary;
  the others are in none.

The alternative is concurrent groups per camera, which means removing that index
and changing the opening key — much more than the line the plan lets
imply, and §7 already warns about the proportion of the work.

### What the wiring is missing

1. The position of the newborn at the instant of birth (it exists: the track's first
   position).
2. The last known positions of the open members (`openTrackIds` + the track store).
3. The frame dimensions per camera — they are **not** on `SummaryStore` today; they
   can be derived from `envelope` + `positions`, but a direct route is needed.
4. The per-device threshold, on whoever generates the event and never in a
   classifier default.

The comparison is on ONE instant, not on a trajectory: true co-motion
would require a history of positions per member that the summary does not keep.
It is written in the module, so the next reader knows which half is missing.

## State at 2026-09-13, evening

Steps **0, 1, 2** done and in the repo (D482, D489, D490). Step 2 arrived complete:
split on divergence with a hysteresis of two sweeps, and `summaryTogetherFraction`
per camera on whoever generates the event, not in a classifier default.

**Step 3 was already satisfied, and I had not noticed while writing the plan.**
The hole that §3 describes is in the DRAFT — the `compareBestFrame` tie-break on the
primary member, not computable during the session. In the code that
tie-break never existed: `scoreSummaryFrame` orders lexicographically on visible,
non-occluded members, and at equal count uses a blend of
quality (confidence .30, bounded area .25, recognition AT THE INSTANT .25,
position .20) — all quantities available at the moment the gate
decides. Verified: no occurrence of `compareBestFrame` or of `primary` in
`group-shot.ts` or `summary-score.ts`. Nothing to do, and this line exists so that the step
is not redone by somebody else.

**Step 4 (pure-runtime digest) was not started, on purpose.** The
notification producer today reads the TRACKS (`listTracks`, up to
`SUMMARY_TRACK_QUERY_LIMIT` = 2,000 per camera) and is tuned. Moving it onto the
summaries would mean making the path that reaches the operator's phone depend on data
that has not yet run in production even for an hour:
the commits for concurrent groups and for the split are in the repo and NOT shipped. The
tracks-v2 draft said the same thing in its own words — *«switch only after the
shadow numbers hold for a week»* — and it applies here. First ship, then the rows
accumulate, then look at what they say.

The re-own of the mosaic to the notification remains valid and independent of the point above.
