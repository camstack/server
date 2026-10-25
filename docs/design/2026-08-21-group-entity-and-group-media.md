---
title: The group ENTITY — a second detection line beside the track, with one media of its own, for the summaries
---

# The group entity — a detection line parallel to the track

> **The pipeline-analytics group entity was DELETED on 2026-09-01**
> ([D330](../decisions/adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)).
> Its tables, its crop, its cap methods, its cascade leg and its two digest
> ladder rungs are gone; the tables are dropped at boot from
> `RETIRED_COLLECTIONS`. Everything below describes a design that was built,
> kill-switched the same day (2026-08-24) and then removed — read it as the
> record of an attempt, not as a description of the system.
>
> The `covers:` frontmatter below points at
> `notification-center/group/**`, which is the burst-merge
> ([D143](../decisions/adr-0143.md)) and is still live.

> **Status: DESIGN. Nothing here is built.** This is the Phase-2 half of
> [`track-grouping-analysis.md`](./track-grouping-analysis.md), re-opened with a
> different first consumer: the operator now wants the group for the **digest
> mosaic**, not for the notification merge (which shipped as Phase 1 on
> 2026-08-14, [D143](../decisions/adr-0143.md)).
>
> Every number below was measured on the live hub (<hub-ip>) on **2026-08-21**
> over the **72 h window 2026-08-18 20:45 → 2026-08-21 20:45**, 29 cameras,
> **6 723 tracks**. The probes are kept in `scratchpad/_ge_*.mjs` (gitignored):
> `_ge_fetch.mjs` (tracks), `_ge_clusters.mjs` (sessions), `_ge_pairs.mjs` /
> `_ge_reasons.mjs` (pair geometry), `_ge_group2.mjs` (the criterion sweep),
> `_ge_square.mjs` (group crop geometry), `_ge_summary_repro.mjs` /
> `_ge_dupes.mjs` (the real digests), `_ge_proof3.mjs` (the crop rendering).

The operator's request, restated: produce a **new kind of entity — a track of a
different type** — that binds individual tracks together and carries, above
them, **one new media** showing a group of objects that is reasonably separated
from the rest of the frame and moves together. One media for now, taken at the
best possible moment of the passage, cropped so that the same image serves both
a square and a rectangular presentation, with the **unmodified native frame
saved alongside**. A session may hold several groups. The first consumer is the
**summaries**, which must stop using individual tracks. Metadata is limited to
what is needed to locate the group on the frame; everything else is read through
links to the member tracks. The entity must be pruned when all its tracks are.

---

> **Operator decisions, 2026-08-21 — Phase 1 is now DECIDED and implementable.**
> Stationary objects in the *registry* sense are excluded from membership and
> the existing authority is reused, never a threshold of our own (§2.2); the
> native frame is a **pointer** to the anchor (§4.5); the parked-car problem is
> **task #15**, separate and immediately after (§7.4); the Phase-1 burst table
> is **kept** with a corrected contract (§6.1); `maxTiles` moves to **12 (4×3)**,
> derived from the measurement (§7.5). **No question is open — Phase 1 is a
> mandate, and §9 is the one-page version of it.** The D212 correction below is recorded as an
> amendment on [D212](../decisions/adr-0212-a-best-shot-square-must-deliver-the-subject.md)
> itself, which is where it belongs.

## 0. Seven findings that decide the design

Read these first. Four of them change what the cheapest correct answer is, and
two of them correct the premise.

1. **The premise about the summaries is CORRECT, and the reality is worse than
   described.** The digest picks **one tile per TRACK** and has no notion of a
   passage at all (`summary-selection.ts:selectSummaryTiles`). On the real
   mosaic delivered at 2026-08-21 19:37 (recordId
   `summary:6f294ef8-…:1787333686885`), **9 tiles show 5 distinct moments, and
   two pairs of tiles are the SAME frame** — the 19:07:07 pair is one image
   twice, the 19:10:07 pair is one image twice. §1.2 shows the picture.

2. **But grouping fixes only a third of that waste.** Of the **65 tiles**
   delivered by the 12 real digests measured, **29 (45%) are near-static
   subjects** (`totalDistance < 100 px` over the track's whole life) and
   **40 (62%) are `vehicle`** — parked cars on the *parking* camera,
   re-detected as fresh idle tracks. A co-movement group deliberately does not
   merge two parked cars, so it cannot recover those tiles. **Grouping removes
   12% of the tiles as redundant; the parked-car share is a separate defect**
   and it is bigger. Saying so now is cheaper than the operator discovering it
   after the entity ships (§7.4).

3. **A cohort's representative frame really shows the whole cohort — a burst's
   does not.** For a burst, the 2026-08-14 measurement found max co-presence
   **3 of 7 members**. For the 788 co-moving groups measured here, the ratio of
   *members visible at the peak instant* to *members* has a **median of 1.00**.
   That is the structural reason the operator's "gruppo che si muove insieme" is
   the right unit for a media, and the burst is not: you can photograph a
   cohort.

4. **The group needs NO new crop geometry, and the arithmetic proves it.** The
   union bbox of a group's members is **11% of the frame at the median, 30% at
   p90** — "reasonably separated from the rest of the frame" is literally true
   — and `wideCentralSquareLayout` (D52 / D212) applied to that union bbox
   already produces one 16:9 image whose central square contains the group.
   §4.2 renders it from real pixels.

5. **D212's containment line is calibrated for ONE subject and under-serves a
   group.** On the measured family group the default layout scores **0.53**,
   which passes `CENTRAL_SQUARE_CONTAINMENT_MIN` (0.5) — and the delivered
   square **cuts the second person in half**. The `{ containSubject: true }`
   variant that already exists scores **1.00** on the same input. For a group,
   half the subject is not "acceptable degradation": it is the wrong group.
   §4.3.

6. **The name is already taken, by the Phase-1 half, which documents its own
   replacement.** `notification-center:track-groups` exists today
   (`nc-group-store.ts:44`), holds the burst record for the notification merge,
   and its own header says: *"When Phase 2 lands, this table is replaced by the
   entity and its rows cascade from their members — at which point the ring goes
   away."* That promise is false, and the table has **zero rows on the live
   hub** for a reason that is not neglect. §6.1.

7. **The measurement was ALREADY computed on the corrected population, and the
   proof is exact.** `pipelineAnalytics.listRecentTracks` defaults to
   `excludeStationaryPromotions: true`
   (`analytics-query-facade.ts:124,149`), so every number in this document was
   taken over a track set from which the stationary registry's promotions had
   already been removed — by the authority that owns them, at the layer that
   owns it. Re-fetching the same window with `includeStationary: true` returns
   **7 350 rows instead of 6 723: 677 rows (8.4%) are the exclusion**, and all
   99 promotions the hub logged in the window are inside it. §2.3.

---

## 1. What the summaries do today, measured

### 1.1 The code, and what it has no idea about

One live digest rule on this hub (`nc.listSummaryRules` via
`addons.custom { addonId: 'pipeline-analytics' }`):

```
"Test summary"  6f294ef8-db7c-4c7c-b4fb-ea9826db710c   enabled
  deviceIds  [101 front door, 102 parking]
  window     motion, quietSeconds 300, maxWindowSeconds 3600
  filters    classes [person, animal, vehicle], minImportance 0.2
  maxTiles 9   maxAiImages 6   rank importance   barrierSeconds 120
```

The selection is three pure functions in
`packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts`:

| stage | function | unit |
| --- | --- | --- |
| promotion + parked + class/zone/importance/dwell filters | `filterSummaryCandidates` | **one TRACK** |
| per-camera quota, then global rank fill | `selectSummaryTiles` | **one TRACK per tile** |
| which blob becomes the tile | `pickSummaryMedia` over `SUMMARY_MEDIA_LADDER` | **one TRACK's media** |

`SummaryCandidate` carries `trackId, deviceId, className, firstSeen, lastSeen,
importance, zones, classes, stationary, confirmed`. **There is no session, no
passage, no group and no co-occurrence key anywhere in the module** — grep for
`session` in `summary/` returns one hit, in a comment about session-gated
routes. The quota hands every contributing camera its single best track and then
the fill pass spends the rest of the budget on pure ranking, which is exactly
how one passage takes four tiles.

### 1.2 A real mosaic, reconstructed tile by tile

`docker logs CamStack | grep 'summary produced'`, the 19:37 delivery:

```
ruleId=6f294ef8 deviceIds=101,102 windowStart=1787331237907 windowEnd=1787333686885
scanned=37 matched=20 droppedStationary=2 droppedUnconfirmed=0 droppedByClass=0
tiles=9 cameras=2 camerasDropped=0 droppedNoMedia=0 mosaicBytes=517471
```

Re-running the same filters and `selectSummaryTiles` offline over the real track
rows (`_ge_summary_repro.mjs`) reproduces it — `scanned` 37 vs 37, `matched` 21
vs 20 (the one row of difference is the `stationary`/`confirmed` gate, which the
offline repro approximates). The nine tiles group into **five passages**:

```
front door    18:57:29–18:57:49   1 tile   person/d0f63887  imp 0.78
parking  19:07:09–19:07:37   2 tiles  vehicle/301e6984 0.68 · vehicle/6319402d 0.67
parking  19:10:09–19:10:28   4 tiles  vehicle/cb9d8cf6 0.63 · vehicle/e24de79c 0.62
                                          person/202d3a4b  0.61 · person/3dbbcb02  0.60
front door    19:23:44–19:23:51   1 tile   person/06ebfe22  0.63
parking  19:29:16–19:29:44   1 tile   vehicle/655a7b65 0.69
```

The delivered mosaic (fetched with
`pipelineAnalytics.getEventMedia { deviceId: 101, eventId: 'summary-6f294ef8-…-1787333686885' }`)
confirms it visually: six of the nine tiles are the same parking lot with the
same green Kia, and tiles 2/3 and 4/5 are **pixel-identical pairs** — the same
`keyFrameSmall` instant, once per track.

The 19:10 passage is the operator's own example, verbatim: **a woman with a pram
and a man walking past two parked cars.** Of its four tiles, two are the parked
cars (`totalDistance` 23 px and 29 px over 19 s, `state: 'idle'`) and two are
the couple. The human answer for this scene is **one group of two people**, plus
whatever we decide about the parked cars.

### 1.3 Redundancy over every real digest in the window

Twelve digests were produced on 2026-08-21 between 14:43 and 20:01. Applying the
grouping criterion of §2 to their tile sets (`_ge_dupes.mjs`):

| | |
| --- | --- |
| digests | 12 |
| tiles delivered | **65** |
| distinct co-moving groups behind them | **57** |
| tiles that repeat a group already shown | **8 (12%)** |
| tiles whose subject barely moved (`totalDistance < 100 px`) | **29 (45%)** |
| tiles whose class is `vehicle` | **40 (62%)** |

Windows where the repetition is visible:

```
18:53:57  9 tiles → 6 groups  (3 redundant)
16:16:01  8 tiles → 6 groups  (2 redundant)
17:37:31  7 tiles → 5 groups  (2 redundant)
14:40:52  9 tiles → 8 groups  (1 redundant)
```

**Read the two rows together.** The group entity buys back 12% of the mosaic; a
stationary-gating fix would buy back up to 45%. Both are worth doing and they
are independent. §7.4 says what to do about the second one, which is *not* this
design.

### 1.4 Concurrency across the fleet

Tracks clustered per camera by temporal overlap with 3 s slack
(`_ge_clusters.mjs`) — this is the SESSION, the operator's *sessione*:

| | |
| --- | --- |
| tracks (72 h, 29 cameras) | 5 440 (slim page) / 6 723 (full page, includes late rows) |
| sessions | 3 799 |
| sessions with ≥2 tracks | 891 |
| tracks inside a multi-track session | **2 532 / 5 440 (46.5%)** |
| session size histogram | 1×2908 2×557 3×190 4×60 5×38 6×16 7×10 8×3 9×4 10×2 11×4 12×1 13×2 20×1 21×1 24×1 25×1 |

Class composition of the multi-track sessions, top rows:

```
321  2person      104  3person      58  1animal+1person   56  2vehicle
50   1audio+1person  39  4person    39  2animal           20  1audio+2person
19   3vehicle     18  5person       18  1animal+2person   16  1person+1vehicle
```

Three consequences:

- **`person`+`person` dominates**, and `person`+`animal` (58+18+8 = 84 sessions)
  is the second real cohort — the dog-and-owner case, exactly as the 2026-08-14
  measurement found.
- **`audio` tracks are in the same sessions** (50+20+9 = 79). An audio track has
  no bbox and no `positions[]`; it can never be a spatial member. §3.4.
- The big sessions are indoor (*hall* 25 tracks, *sala da pranzo* 21). §2.6
  shows what those actually are, and it is not 25 people.

---

## 2. What a group IS — the operative definition

### 2.1 The three halves of the operator's sentence

> *"un gruppo di oggetti ragionevolmente diviso dal resto del frame e si muove
> insieme"* … *"Il gruppo deve in ogni caso considerare tracce in movimento, le
> tracce stazionarie vanno chiaramente scartate"*
> [a group of objects reasonably separated from the rest of the frame and moving together … The group must in any case consider moving tracks; stationary tracks are clearly discarded]

- **"stationary tracks are clearly discarded"** — an *eligibility* condition on
  each track, decided **before** any pair is considered. §2.2.
- **"reasonably separated from the rest of the frame"** — a *spatial* condition
  on the set: its members are mutually close relative to their own size, and
  their union occupies a bounded part of the frame. This is what makes a group
  photographable. §2.6.
- **"moves together"** — a *temporal-coherence* condition: it is not two
  strangers who happen to cross. §2.5 measures why this one must be a veto and
  not a requirement.

Three separate tests. Collapsing the first two into one distance threshold is
the mistake this section exists to prevent.

### 2.2 Eligibility — "stationary" means the registry's stationary, and nothing else

**The word is technical in this repo and the design uses it technically.** A
*stationary* object is one the **stationary registry** promoted: a subject that
existed for `promotionWindowMs` (30 s) and whose centroid then barely moved —
`netDisplacementFrac < STATIC_DISPLACEMENT_FRAC` (0.02) **and**
`pathSpanFrac < STATIC_SPAN_FRAC` (0.04), `evaluateStationaryPromotion`
(`pipeline/stationary/stationary-match.ts:241-274`). A parked car, a bin, a
piece of scenery. It is emphatically **not** "a person who stood still for a
moment" — those 30 seconds exist, in D204's own words, *"so that somebody
standing still at a door is not declared scenery"*.

**The gate, stated once:**

> A track is eligible for group membership iff
> `closedReason !== 'stationary-promotion'`.

That is the whole rule, and it introduces **no new authority** (D62). The same
predicate already has three names in this repo and they are the same predicate:

| layer | how it is spelled | file |
| --- | --- | --- |
| the row | `PersistedTrack.closedReason === 'stationary-promotion'` — written once, by the one production call site of `closeActive` | `store/track-store.ts:63, 1238`; `index.ts:9389` |
| the store query | `whereNot: { closedReason: 'stationary-promotion' }`, behind `excludeStationaryPromotions` | `store/track-store.ts:1626-1630, 1778-1782` |
| the API | `includeStationary?: boolean`, **defaulting to exclude** | `analytics-query-facade.ts:124, 149` |
| the digest | `SummaryCandidate.stationary`, the addon's *only* mapping of the column into a selection input | `index.ts:3552-3557` |

**Read the last row twice.** The digest already excludes exactly these tracks,
by exactly this authority. Making the group do the same is not a new gate — it
is the group inheriting the gate its consumer already applies, one level
earlier, which is what stops the two from ever disagreeing.

**What is explicitly NOT the authority**, and must not be substituted for it:

- **`Track.state === 'idle'`.** It is the *last frame's* instantaneous velocity
  verdict (`state-analyzer.ts:70-88` → `frame-processor.ts:229-245`), rewritten
  by every upsert, and an absent value reads back as `'idle'`. Measured on the
  fleet: of the **884** `idle` rows, **761 are `audio`** — a class with no bbox
  — and only 84 are vehicles. Meanwhile **447 of 603 vehicle tracks move less
  than 60 px and 301 of them persist `state: 'moving'`.** It answers a different
  question, badly.
- **`totalDistance`.** `summary-selection.ts:38-39` already records the verdict
  from live traffic: *"`totalDistance` and `state` were both measured … and both
  hide real passages."*
- **A distance threshold of our own.** It would be a *fifth* definition of
  stationary beside the registry, the importance static gate (which deliberately
  imports the same two constants rather than copying them), the phantom cells
  and the package background registry.

**D204's phantom cells need nothing from this design, and that is the finding.**
A phantom cell raises the confirmation gate's `minConfidence` **at BIRTH**, per
`(device, class, 32 px birth cell)` — *"Nothing else."* It is not track-keyed
and leaves no per-track field. A subject it suppresses therefore never becomes a
track at all, so **the group inherits the whole benefit for free** and must not
re-derive it. Fetching a phantom verdict per member would be a read on the group
path that changes nothing, and D49's rule about gating on a fallible read
applies.

**One honest boundary.** `closedReason` is deliberately absent from the cap
`TrackSchema`, so the generated router strips it and **no tRPC consumer can read
it** — which is why the measurements in §2.3 had to be taken by *differencing*
the two API populations rather than by reading a field. The group clusterer runs
**in-process inside `addon-post-analysis`**, where `PersistedTrack` is the type
in hand, so it reads the column directly and needs no promotion of the field.
If a later consumer needs the marker over the wire, promoting it onto
`TrackSchema` is documented as additive and legal (`track-store.ts:78-80`,
D172) — that is the sanctioned path, not a new field.

### 2.3 The re-measurement, with the gate as specified

`listRecentTracks` defaults to excluding stationary promotions, so the two
populations can be differenced exactly (`_ge_fetch_incl.mjs`, `_ge_group4.mjs`):

| 72 h, 29 cameras | **gate ON** (the spec) | gate OFF |
| --- | --- | --- |
| tracks | **6 723** | 7 350 |
| rows the gate removes | **677 (8.4%)** — person 542, vehicle 90, animal 27, audio 18 | — |
| …their `totalDistance` p25/median/p75 | 67 / **205** / 530 px | — |
| …their `state` | 468 `moving`, 135 `idle`, 74 `entered` | — |
| sessions | 4 764 | 4 931 |
| groups | **5 409 (1 803/day)** | 5 676 (1 892/day) |
| **multi-member groups** | **788 (263/day)** | 938 (313/day) |
| tracks folded into them | 2 102 | 2 612 |
| reduction vs eligible tracks | **19.5%** | 22.8% |
| **multi-member groups containing a stationary-promoted member** | **0** | **229 (24%)** |
| members kept that are momentarily still (`totalDistance < 60 px`) | **616 of 2 102 (29%)** | 744 |

Every one of the 99 stationary promotions the hub logged in the window
(`grep 'track promoted to stationary'` — 80 person, 16 vehicle, 3 animal) is
inside the 677.

**Four things this settles:**

1. **The gate is what the operator asked for and it is not degenerate.** 19.5%
   reduction, 263 multi-member groups a day — nowhere near the 3.9% that the
   *literal* "both must be moving" reading produced (§2.5). No re-ask is needed.
2. **The excluded rows are not motionless.** Median `totalDistance` **205 px**,
   and 468 of 677 persist `state: 'moving'`. They are subjects that moved and
   then *settled* — which is precisely the registry's meaning of stationary, and
   precisely why a distance threshold cannot stand in for it.
3. **Momentarily-still subjects are kept.** 616 members (29% of all group
   members) moved less than 60 px in their whole life and are still inside a
   group: the person standing to talk, the dog waiting. That is the operator's
   distinction, preserved.
4. **The gate is doing real work.** Without it, **229 multi-member groups —
   24% — would contain a parked object**, and every one of those would be a
   group whose picture is partly of scenery.

### 2.4 The pair predicate

For two tracks A, B on one camera whose lifetimes overlap, sampled every 500 ms
over the overlap, matching each track's nearest `positions[]` sample within
±1 s:

```
d(t)      = |centroid(A,t) − centroid(B,t)| / mean(diag(bboxA,t), diag(bboxB,t))
cohesion  = fraction of joint samples with d(t) ≤ D_MAX            D_MAX  = 1.5
rel(X)    = |netDisplacement(X)| / mean bbox diagonal              MOVE_EPS = 0.35
cos       = cosine between the two net displacement vectors        COS_MIN = 0.3
```

Applied **only among eligible tracks** (§2.2). `d` is the same normalised gap the 2026-08-14 analysis used, and it reproduces:
median **0.95** (was 0.94), p25 0.63, p75 1.50, p90 2.11; 75% of overlapping
pairs sit at `d ≤ 1.5`. Of the pairs where both members measurably move, **31%
have `cos < −0.3`** — people walking *past* each other (was 26%). Proximity
alone still merges crossings.

**The predicate: A and B are together iff `cohesion ≥ 0.5` AND NOT (both move
AND `cos < COS_MIN`).**

In words: *stay close for at least half the time you are both visible, and if
you are both moving, do not move in opposite directions.* The motion test is
used **only to veto a crossing**, never to require agreement — because requiring
it destroys the most common real case (§2.5).

A group is a **connected component** of that relation inside one session. Union-
find over the ≤10 concurrent tracks of a camera; the cost is nil.

### 2.5 Why the motion test is a veto and not a requirement

Verdicts over all 2 145 overlapping pairs with joint samples, **within the
eligible population** (`_ge_reasons.mjs`):

| verdict | pairs | dominant composition |
| --- | --- | --- |
| not cohesive (`cohesion < 0.5`) | 509 | person+person 350 |
| **both members static** | **646** | person+person 459, vehicle+vehicle 84 |
| **one member static** | **579** | person+person 474 |
| diverging (both move, `cos < 0.3`) | 130 | person+person 118 |
| both move, agree | 281 | person+person 244 |

A criterion that requires *both* members to move and agree accepts **281 pairs**
and folds 6 723 tracks into 6 458 groups — a **3.9% reduction**, which is not a
feature. The reason is in the two big middle rows: **1 225 cohesive pairs have a
static member**. Two people sitting at a table are a group. A dog standing while
its owner walks up is a group. A person greeting someone stationary is a group.
Requiring co-motion is a literal reading of the operator's words that
contradicts what the operator actually wants to see in one tile.

The sweep, over the whole fleet:

| rule | groups | reduction | multi-member groups |
| --- | --- | --- | --- |
| A — both move, `cos ≥ 0.3` | 6 458 | 3.9% | 207 |
| C — ≥1 moves, agree if both move | 5 940 | 11.6% | 507 |
| D — cohesion only, no motion test | 5 343 | 20.5% | 817 |
| **F — cohesion, veto diverging crossings** | **5 409** | **19.5%** | **788** |

**F is the recommendation.** It keeps 96% of D's folding while refusing the 130
crossings D would merge, and a wrong merge is worse than no merge: it hides a
subject the operator would otherwise have been shown.

### 2.6 Validation on real passages, including the hard ones

**The operator's own case — 2 people + 2 parked cars, parking 19:10.**
Predicate output: `{202d3a4b person, 3dbbcb02 person}` is one group
(cohesion 1.00). The two idle vehicles are `both-static` with `d > 1.5` between
them and are **not** merged, into the group or with each other. Human answer:
one couple + two parked cars. **Correct.**

**Two people leading three horses, parking 16:33** (`53d02c1e`, `65562dba` +
animal tracks). Predicate: one group. Visually confirmed from the
`keyFrameSmall` — a woman and a man walking three horses past the camera.
Today: 3 tiles. **Correct.**

**A living room with a woman and two children, hall 20/08 16:54.** Predicate
under rule F: **one group of 24 tracks.** This looks alarming and is not: the
*hall* produced 1 439 tracks in 72 h and the session is 3 subjects whose
tracks fragment and respawn continuously (member lives of 149 s, 19 s, 14 s,
26 s, 9 s, 44 s, 2 s, 37 s… all inside a 2.5-minute span, all in the same third
of the frame). Folding them into one group is exactly what a digest wants: one
tile of the family instead of 24 near-identical living-room frames. **Correct,
with a caveat** — on indoor cameras the group is doing double duty as a
fragmentation absorber, and the design must not claim `memberCount` means
"number of people". §3.3.

**A crossing that must NOT merge.** 130 pairs are vetoed by the `cos` test, 118
of them person+person. Rule D merges them and rule F does not; that is the
entire difference between the two rows in §2.5, and it is the reason to pay for
the motion vector.

**What rule F still merges wrongly.** Two subjects that are cohesive, one of
them static, and genuinely unrelated — a person standing at a door while another
walks past within 1.5 diagonals. This is the residual false-merge class and the
measurement cannot separate it from the true case without labels. It is bounded
by the cohesion threshold; the honest mitigation is that the group's members
stay individually clickable and countable (§3.5), so a wrong merge costs a tile,
never a record.

### 2.7 What the group is NOT

- **Not the burst.** A burst is one camera + temporal chaining, no geometry
  ([`track-grouping-analysis.md`](./track-grouping-analysis.md) §3 Question A);
  it is what the Phase-1 notification merge already uses and it must stay
  there. A session may hold several groups — the operator said so — which is
  precisely the statement that the group is finer than the burst.
- **Not a track.** No association, no class, no identity, no `positions[]`
  history at frame rate. It has no pixels of its own beyond one delivered
  picture.
- **Not a re-identification.** The 24-track hall group is not a claim that
  those 24 rows are the same person.

---

## 3. The entity

### 3.1 The shape

```
TrackGroup
  id            TEXT   pk         'grp-<uuid>'
  deviceId      INTEGER           the camera — every group is single-camera
  timestamp     INTEGER           the CHOSEN INSTANT (see §4.1); doubles as the
                                  orphan-audit clock column
  openedAt      INTEGER           min(member.firstSeen)
  closedAt      INTEGER           max(member.lastSeen)
  memberCount   INTEGER
  anchorTrackId TEXT   nullable   the member whose pixels the media came from —
                                  NULLED if that member is deleted alone (§4.5)
  ux, uy, uw, uh REAL             the group's UNION bbox at `timestamp`,
                                  NORMALISED to the frame (0..1)
  frameWidth    INTEGER           the detection raster the union was measured in
  frameHeight   INTEGER
  mediaKey      TEXT   nullable   the group crop; null while unwritten
  nativeKey     TEXT   nullable   POINTER to the anchor's `keyFrame` row, never
                                  a copy; nulled with the anchor (§4.5)
  sealed        BOOLEAN           membership is final

TrackGroupMember          -- the membership table; one row per member
  id            TEXT   pk         '<groupId>:<trackId>'
  groupId       TEXT
  trackId       TEXT              ← the EXACT column name the cascade derives on
  deviceId      INTEGER
  timestamp     INTEGER           the member's firstSeen, for the orphan audit
```

### 3.2 Why each field exists — and what was left out

Every field is written once at birth **except `anchorTrackId` and `nativeKey`**,
which are nulled if the anchor member is deleted alone (§4.5). That asymmetry is
the pointer's whole cost and it belongs in the store's own header, or someone
will make the row immutable and reintroduce the dead link.

| field | the consumer that reads it | why it cannot be derived |
| --- | --- | --- |
| `deviceId` | the digest's per-camera quota; every log line (CLAUDE.md) | — |
| `timestamp` | the digest's chronological tile order; the orphan audit's grace window | the members' timestamps do not name the *chosen* instant |
| `openedAt` / `closedAt` | the window overlap test (`lastSeen ≥ since && firstSeen ≤ until`) that replaces the per-track one | a `min`/`max` over members costs a join on every list query |
| `memberCount` | the tile caption *"2 persone"*; the "is this a singleton" branch | as above |
| `anchorTrackId` | the tap-through target; the media's provenance | — |
| `ux,uy,uw,uh` + frame dims | **the only "where is the group on the frame" fact** — the crop derivation (§4.2) and any future overlay | recomputing it needs every member's `positions[]` at one instant, which is the expensive read the digest exists to avoid |
| `mediaKey` / `nativeKey` | the tile; the "no media" drop counter | — |
| `sealed` | the digest's barrier: a group still open is not ready to render | — |

**Deliberately absent, each for a reason:**

- **No `className`, `label`, `subLabel`, `importance`, `zonesVisited`,
  `classes`.** All of it is on the members. The operator's own instruction:
  *"tutto il resto è leggibile dalle tracce sottostanti con link."* [everything else can be read from the underlying tracks via links] A
  `classes[]` on the group would be the second source of truth D62 names; the
  digest caption composes it from the members at render time, the same way
  `ncDetectionSummary` already does.
- **No trajectory.** A `positions[]`-style history was considered and rejected:
  the first consumer needs exactly ONE instant, and a field no consumer reads
  must not exist. The union bbox at `timestamp` is the whole of "where is the
  group". If a later consumer (a timeline scrub, an overlay) needs motion, add a
  **sampled** envelope track then, sized against that consumer — at 1 Hz over
  the measured median span of 24 s that is ~24 samples, ~1 KB, and it is cheap
  whenever it is actually wanted.
- **No `groupId` column on the track row.** The 2026-08-14 analysis recommended
  denormalising it for list queries. That was written when the consumer was the
  events feed paging over `tracks`. The consumer here reads groups directly, and
  a denormalised id is a second membership authority that can disagree with the
  membership table. Add it only when a query is measured to need it.

### 3.3 What `memberCount` means, honestly

It is **the number of member TRACKS**, not the number of subjects. On outdoor
cameras they nearly coincide (median group size 2, mean 2.67). On indoor
cameras they do not (§2.6). Any UI string built from it must be a track-set
description, and the digest caption should compose classes from the members
(*"2 persone"*) rather than print the count.

### 3.4 Tracks that cannot be members

- **Audio tracks** (79 sessions contain one) have no bbox and no positions.
  They are **not** members, and they are not singleton groups either — a digest
  tile cannot be drawn from them. They keep whatever handling they have today.
- **Tracks with fewer than 2 positions** (766 of 6 723, 11%) cannot be tested
  for cohesion. They become **singleton** groups, never merged.

### 3.5 The relationship to the track line

The two lines are parallel and neither replaces the other:

| | |
| --- | --- |
| occupancy (`zoneAnalytics.recordFrame`) | **counts tracks. Unchanged.** Three people are three. Guard it with a test. |
| retrain / CLIP / face + plate galleries | **read tracks. Unchanged.** A group owns no training pixels. |
| notifications | **read tracks + the Phase-1 burst.** Unchanged in Phase 1 of this design. |
| the events feed and timeline | **read tracks.** Unchanged; a group card is a later phase. |
| **the digest** | **reads groups.** This is the whole change. |

---

## 4. The media

### 4.1 The chosen instant — "the best possible moment of the passage"

The scale is D203/D204/D212/D213's, applied to the group's union bbox. It is not
a second ranking; it is the same one with a different subject.

**The rule, in tier order — the first tier that separates two candidate instants
decides:**

1. **Completeness.** The instant at which the greatest number of members have a
   position within ±1 s. This is the group's analogue of "the subject is in the
   frame", and it is the tier that has no per-track equivalent. Measured
   value: the median group reaches **all** its members
   (peak-co-presence ÷ members = 1.00 median; max observed 7 simultaneous).
2. **Square containment (D212).** `centralSquareContainmentFraction(union)` —
   an instant whose union fits the delivered square outranks one that does not.
3. **Semantic (D213).** An instant that coincides with a member's confirmed
   recognition outranks one that proved nothing. Free: the member's own
   `semantic` promotion already marks it.
4. **Edge-clear.** The union touches no frame border.
5. **Effective score.** `mean(member confidence) × containment × sizeFactor`,
   with the union bbox standing in for the subject bbox — `bboxContainment`,
   `bboxSizeScore` and `effectiveScore` take any box.

**Online or retrospective?** Retrospective, at group close, over stored
`positions[]`. This is the opposite of the per-track choice and it is right for
three reasons: (a) the group is not known until its members are, (b) `positions[]`
is already persisted and the whole pass is arithmetic over rows already in hand,
(c) `BestDetectionTracker` is keyed by a bare `trackId` and holds no pixels —
there is no cross-track ranking primitive to extend, and inventing an in-RAM
one would be a second authority over the same tiers.

The consequence is that the group's pixels must come from **a frame that was
already captured**, which §4.4–§4.6 address.

### 4.2 The crop — ONE derivation, and it already exists

The operator's *"croppato allo stesso modo per permettere show quadrato e
rettangolare"* [cropped the same way to allow both square and rectangular display] is, exactly and without generalisation, the existing
**wide-central-square** layout: a 16:9 canvas whose middle square contains the
subject, so a wide consumer uses the whole image and a square consumer
blind-centre-crops it and is guaranteed not to cut the subject.

**The group's only change is the input box: the member union instead of one
member's bbox.** `deliveredWideCentralSquareLayout(bbox, frame)` takes any
`PixelBbox`. No second geometry, no new file, D52 intact.

The arithmetic says this works. Over all 788 multi-member groups, at each
group's peak instant:

| | |
| --- | --- |
| union bbox area ÷ frame | p25 **0.066** · median **0.110** · p75 0.189 · p90 0.297 |
| central-square containment of the union | **≥ 0.5 for 788 / 788 (100%)**, p10 = 1.00 |
| group span | median **24 s**, p90 91 s |

Rendered from the real 19:10 family group (`_ge_proof3.mjs`, from
`track:202d3a4b…:keyFrameSmall`, union bbox `{x:485.6, y:152.6, w:142, h:170.9}`
in the 640×360 detection raster, 10.5% of the frame): the 16:9 slab shows both
people and the pram; the centre-cut square shows the group.

### 4.3 The correction D212 needs for a group

The default layout on that same group scores **containment 0.53**. That is
*above* `CENTRAL_SQUARE_CONTAINMENT_MIN` (0.5), so `deliveredWideCentralSquareLayout`
keeps it — and the delivered square **cuts the man in half**. The
`{ containSubject: true }` variant scores **1.00** on the identical input and
delivers both people.

The cause is in the layout itself and is not a bug for its designed case: with
the subject near a frame edge the central square clamps to the border, the 16:9
canvas then slides fully inside the frame (`boundInert`), and the central square
travels away from the subject. D212 accepted that at 0.5 because half of one
person is still that person.

**Half of a group is a different group.** So:

> **A group crop always requests `{ containSubject: true }`.** It never consults
> the 0.5 threshold, because for a group the acceptable containment is 1.0.

This is one call-site rule, inside the group's own media path. It adds no
geometry and changes nothing for tracks — the group path is a fourth caller of
the same `wideCentralSquareLayout`, with its own bound, not a second geometry
(D52).

**Recorded where it belongs: as an amendment on
[D212](../decisions/adr-0212-a-best-shot-square-must-deliver-the-subject.md)
itself**, with the measured geometry and the rule stated generally — *the
acceptable containment is a property of what the box MEANS; for one subject it
is 0.5, for a set it is 1.0.* Writing it only here would leave the record that
governs the three existing callers silent about the case that breaks it.

### 4.4 The two blobs, and where the pixels come from

The operator asked for **one media** plus **the same media native and
unmodified**. Mapped onto what exists:

| the operator's words | the artefact | the existing analogue |
| --- | --- | --- |
| "un media… croppato allo stesso modo per permettere show quadrato e rettangolare" [one media… cropped the same way to allow both square and rectangular display] | the group crop — 16:9, wide-central-square over the union bbox | `thumbnail` |
| "lo stesso media nativo senza modifica" [the same native media without modification] | the group's native full frame at the chosen instant | `keyFrame` |

**Both must be CLEAN — no burnt-in boxes.** The mosaic renderer and
`retrain-frame-selection.ts` both say a drawn rectangle is a permanent lie in a
digest tile, and the digest is this media's first consumer.

**Where the pixels come from — one source, in preference order, no new capture
path:** the member `keyFrame` (clean, native, full frame) nearest the chosen
instant, then `keyFrameSmall`, then `snapshot` — but `snapshot`, `firstFrame`
and `lastFrame` all carry a burnt-in box, so the ladder for a group is
`keyFrame → keyFrameSmall` and **nothing else**. If no member owns a clean full
frame within a tolerance (2 s is the natural value; the measured 19:10 case was
0.5 s away), the group **has no media and says so** — `mediaKey` stays null and
the drop is counted. Fabricating a frame is worse than an honest gap, and
`recorded-still.ts` is forbidden on the delivery path by
`scripts/check-recorded-still-off-delivery-path.ts`.

### 4.5 The native frame is a POINTER — and the anchor is chosen to survive

**DECIDED: `nativeKey` references the anchor member's `keyFrame` row. Zero new
bytes.** The alternative — a copy — costs a median `keyFrame` of **667 KB**
(p90 2.07 MB, measured over 40 tracks), which at 263 multi-member groups a day
is **~176 MB/day, ~1.2 GB at the 7-day `trackRetentionDays` default**, for
pixels that are byte-identical to a blob the hub already holds. The reference is
not a second copy of a fact; it is the same fact.

A pointer is only honest if it is chosen to survive, and if its death is
designed. Both, below.

**Choosing the anchor — the longest-lived member, measured, not assumed.** The
anchor must (a) own a clean full frame, and (b) be the member least likely to be
pruned or deleted alone. Sampled over 60 real multi-member groups / 149 members
(`_ge_anchor.mjs`):

| | |
| --- | --- |
| members owning a clean full frame (`keyFrame` \| `keyFrameSmall`) | 132 / 149 (**89%**) |
| groups where **at least one** member owns one | 56 / 60 (**93%**) |
| groups where **every** member owns one | 47 / 60 (78%) |
| **anchor = longest-lived member → owns a clean frame** | **56 / 56 (100%)** |
| anchor = most `observations` → owns a clean frame | 55 / 56 (98%) |
| anchor = highest `importance` → owns a clean frame | 55 / 56 (98%) |

So: **`anchorTrackId` = the member with the longest `lastSeen − firstSeen`,
among those that own a clean full frame; ties broken on `trackId` so the choice
is reproducible.** It wins on both counts at once — it is the member most likely
to have media, and (because media capture is a function of a track's life) the
member a retention or dedup pass is least likely to take first. The two other
rankings were measured rather than argued away, and they lose by one group.

**When the anchor dies anyway — the honest degradation, never a dead link.**
Three deaths, three answers, and none of them is a broken image:

| what happened | what the group does |
| --- | --- |
| the whole group ages out | the cascade deletes the group with its last member (§6.3). Nothing to degrade. |
| the operator deletes the anchor track alone | the cascade's per-member step **nulls `anchorTrackId` and `nativeKey`** on the surviving group row, in the same transaction that removes the membership row. The group keeps `mediaKey` — **the crop is the group's own blob and is unaffected** — so the tile still renders and only the "open the native frame" affordance disappears. |
| the anchor's media is gone but the row is not (a media-store gap) | the read resolves `nativeKey` and gets nothing. **The reader must treat a missing blob as "no native frame", never as an error**, exactly as `pickSummaryMedia` already treats an unreadable blob (`summary-producer.ts:705`, *"summary tile dropped: the media blob could not be read"*). |

**Re-anchoring is deliberately NOT done.** Picking a new anchor after a deletion
would change what the group's native frame IS, retroactively, for a picture the
operator may already have seen. A group that has lost its anchor has lost its
native frame; it says so by carrying `null`, and the crop it already owns is the
record.

**The consequence for §3.1:** `anchorTrackId` and `nativeKey` are **nullable and
mutable after birth** — the only two fields on the row that are. Everything else
is written once. That asymmetry is the pointer's whole cost and it should be
stated in the store's own header, or someone will make the row immutable and
reintroduce the dead link.

### 4.6 The crop, and what a singleton owns

**The crop is new bytes and there is no way around it.** Median `thumbnail` is
**190 KB** (p90 545 KB). At 263 groups/day: **~50 MB/day, ~350 MB at 7 days**,
fleet-wide. A `thumbnailSmall`-sized 480 px variant is 14 KB median and would be
~4 MB/day if the digest is the only consumer — worth writing **as well**, since
the mosaic downscales anyway (`MOSAIC_MAX_WIDTH` 1920 over up to 24 tiles).

**Singleton groups carry no media of their own.** A group of one has, by
construction, exactly the best shot its single member already owns; a copy would
be the same pixels under a second key. `mediaKey`/`nativeKey` stay null and the
resolver falls through to the member. This is not an exception to "summaries do
not use single tracks" — the digest still reads a *group*; the group resolves
its picture through its one member. It is also what keeps the volume bounded:
**all** groups is 1 803/day (1.5 GB/day at median sizes), multi-member groups is
263/day.

### 4.7 When the media is written

At **group close**, off the delivery path, in the addon that owns the tracks.
The digest's own barrier (`barrierSeconds`, 120 s on the live rule) already
waits for a window's tracks to close before it renders, and the group close is
strictly earlier than that barrier's expiry, so the digest needs no second wait.

**D220 does not cover this writer** — `ClosedRowMediaGate` lives inside
`buildSnapshotTargets`, and a group-close write is a close-path write like the
last-frame promotion. It therefore owes its own destination-validity argument,
and the argument is: **the group writes to its OWN owner id**, never to a track
row. The b50e09f7 incident (a closed person row receiving photographs of a dog)
cannot recur through an owner id that is minted per group.

### 4.8 Ownership

`MediaStore`'s `OwnerKind` is `event | track | face | identity | plate |
vehicle | scene`. A group media needs **`group`**, and it must not be written as
a track-owned kind: the orphan audit resolves `MEDIA_COLLECTION` through
`resolveMediaOwner`, and a group blob filed under `ownerKind: 'track'` would be
audited against the wrong owner. This is the `scene` mistake documented at
`media-store.ts:52-62`.

`resolveMediaOwner` must learn `'group'` → the group row, and `MediaStore` must
gain a `deleteByGroups` alongside `deleteByTracks`.

---

## 5. Lifecycle

### 5.1 The window a group is computed over

**One session, one camera.** The session is the existing temporal chain: tracks
whose lives overlap with 3 s slack. A session is bounded by construction, holds
1–25 tracks (§1.4), and — the operator's own constraint — **may contain several
groups**. Grouping runs once per session, at session close.

**Session close = the last member track closes + a small idle cutoff.** The
Phase-1 burst already implements exactly this rule (`groupIdleSec`, default 30 s,
the reference detector's own value), and it is the same clock. Reuse it; do not add a second.

Interaction with **D217** (`MIN_SESSION_OPEN_MS`, 10 s): the *detection* session
is an orchestrator concept about attaching a camera to a node, and it is not
this session. They are unrelated clocks over the same word, and the design must
not conflate them — a group is computed over TRACK lifetimes, which survive a
detection-session teardown.

Interaction with **stationary promotion**: a stationary-promoted track is
**never a member** (§2.2) — it is filtered out of the session before the pair
predicate runs, so it can neither form a group nor join one. It remains a track,
it remains in the events feed and the timeline, and a rule that asks for parked
objects still sees it. What it cannot do is contribute pixels to a group's
picture.

A session may therefore hold **zero eligible tracks** — an arrival that is
entirely parked cars. That session produces no groups at all, which is the right
answer and is not an error: it is logged with `tags: { deviceId }` and a count,
because a branch that drops work silently reads as "it never happened".

### 5.2 Birth, death, and the three awkward cases

- **A group is BORN at session close**, when all its members are final. It is
  never live. This is the single biggest simplification available and it is
  bought by the consumer: a digest is retrospective by the operator's own
  framing (*"il summary non è atteso di essere realtime"* [the summary is not expected to be realtime]), and its barrier
  already waits.
- **A member born late / dead early** is not a special case, because grouping is
  retrospective: every member's whole life is known when the predicate runs. The
  pair predicate is defined on the overlap, so a member that shares 4 s with the
  group and then leaves is tested on those 4 s.
- **Membership is SEALED at birth** and never revised. There is nothing to
  revise: the group is computed once, after everything happened.
- **Merge and split are FORBIDDEN in Phase 1**, and there is nothing to forbid:
  a single connected-components pass over a closed session produces a partition,
  and a partition has no merges and no splits. Say it out loud in the code
  anyway, because the first person who wants a live group will reach for them.

### 5.3 What happens if the process dies mid-session

Nothing durable is lost that matters: the session's tracks are already
persisted, so the grouping pass is **replayable from stored rows**. A
back-fill that runs at boot over sessions younger than the digest lookback
recovers every group the crash cost. This is the property that makes the whole
design safe to validate offline before it renders anything (§8).

---

## 6. Persistence and prune

### 6.1 The name collision — the Phase-1 table is KEPT, with a corrected contract

**Is the Phase-1 table actually used?** Asked properly, because the repo rule is
that an orphan is removed with its table. The answer, verified:

| question | answer |
| --- | --- |
| is it written? | yes — `notification-center/index.ts:3754` and `:4155`, on group open and on each growth |
| is it read? | yes — `NotificationCenter.listTrackGroups` (`index.ts:4130`) → `pipeline-analytics/index.ts:2172` → the `nc.listTrackGroups` custom action (`nc-actions.ts:177, 827`). A wired, auth-checked, reachable read surface |
| does any CLIENT read it? | **no.** Zero hits for `listTrackGroups` in the viewer (`camstack/src`, `camstack/embed`), in `ui-library`, and in `server/` |
| how many rows on the live hub? | **zero** (`nc.listTrackGroups` returns `{ groups: [] }`) |
| why zero? | `groupIdleSec` is `.optional()` with **no default** — absent means grouping OFF (`notification-rules.cap.ts:1171`, and the docblock says the absence is deliberate: *"a Zod default does not run on the addon cap path"*). **No rule on this hub sets it**, so the Phase-1 merge has never fired |

**So it is not an orphan — it is a shipped feature nobody has switched on.**
Deleting it would remove working code because the operator has not yet enabled
it, which is the opposite of the orphan rule's intent. **DECIDED: keep it.**

Two edits follow, and they are the whole of the obligation:

1. **Delete the false promise.** The header sentence *"When Phase 2 lands, this
   table is replaced by the entity and its rows cascade from their members — at
   which point the ring goes away"* is now wrong and must go. A leftover that
   describes the right design reads as verification of it; this repo has paid
   for that three times.
2. **Write the real contract in its place**, naming both tables so the next
   reader cannot confuse them:

> `notification-center:track-groups` records a **BURST**: the set of subjects a
> notification rule merged into one message on one camera, keyed by
> `(ruleId, deviceId)`, decided by temporal chaining alone with no geometry, and
> existing so a delivered notification has a record. It is rule-scoped, it owns
> no pixels, and it is ring-bounded by count.
>
> `pipeline-analytics:track-groups` records a **CO-MOVING GROUP**: a spatial
> partition of one session's eligible tracks, decided by proximity and motion,
> not rule-scoped, owning a picture of its own, and cascading from its members.
>
> **They are different questions about the same tracks and they coexist.** One
> burst may contain several groups; one group may span two bursts of two
> different rules, or none at all. Neither is derivable from the other, and
> neither replaces the other.

The new entity therefore takes `pipeline-analytics:track-groups` and
`pipeline-analytics:track-group-members`. The addon prefix is what keeps the two
names apart, and it is already how every other collection here is namespaced.

### 6.2 The census obligations, and the one that bites

Both tables need an `@durable` docblock (`class=ledger owner=pipeline-analytics`,
with `write=` and `retention=` prose) immediately above a single-quoted
`export const X_COLLECTION = '…'`, or `check-durable-state-declared.ts` fails the
commit — the `BACKLOG` escape hatch has been empty and shrink-only since
2026-08-14.

Both must appear in `ANALYTICS_COLLECTIONS` in
`pipeline-analytics/retention/collection-classification.ts`, or
`check-age-keyed-retention.ts` check 3 fails — it matches the **constant name**
as a raw substring of that file.

**The classification is where the design has to be right, not merely compliant.**
`classifyByDeclaredColumns` derives track ownership from a column named exactly
`trackId`. A group row has N members and no such column; a membership row has
exactly one.

| table | classification | consequence |
| --- | --- | --- |
| `track-group-members` | **`track-owned`**, `derived(MEMBER_COLUMNS)` | cascades per member for free; enrolled in the orphan audit, which is why it must also declare `timestamp` and `deviceId` (`buildOrphanScopes` hardcodes those names) |
| `track-groups` | **`owner-indirection`** — owned by its members | see the trap below |
| the group's media rows | already `owner-indirection` via `MEDIA_COLLECTION`; `resolveMediaOwner` must learn `'group'` | |

**The trap:** `buildOrphanScopes` (`retention/orphan-audit.ts:171-204`) refuses
every `owner-indirection` collection that is not `MEDIA_COLLECTION` — *"a second
indirection would need its own resolver; refusing here is better than scanning
it with the wrong one."* So a group row classified that way is **silently
unaudited**. Two honest answers:

- **(a)** Extend `buildOrphanScopes` with a second resolver for `'group'`
  (groupId → does any member row survive). More code, and it is the shape the
  audit was built for.
- **(b)** Classify `track-groups` as `never-orphaned` with a `why` that names
  the cascade in §6.3 and a **count bound** as belt-and-braces, following the
  `NcGroupStore` / `LTS` / `phantom-cells` precedent.

**Recommendation: (a).** The whole point of the operator's *"deve essere parte
del prune quando tutte le sue tracce vengono eliminate"* [it must be part of the prune when all its tracks are deleted] is that the group is
audited to be gone. (b) makes the guarantee unverifiable by the tool built to
verify it.

### 6.3 The cascade — "a group with ONE live track does not die"

The cascade choke point is `cascadeDeleteTracks`
(`pipeline/delete-track-cascade.ts:139`), driven by a registry of
`TrackScopedStore`s built in `buildAnalyticsCascadeRegistry` (:184). Adding a
family is one `registry.push` line plus a `TrackOwnedFamilyId` entry.

`TrackGroupStore.deleteByTracks(trackIds)` does exactly two things, in order:

1. delete the **membership rows** whose `trackId` is in the batch;
2. for each `groupId` those rows named, count the **surviving** membership rows;
   **if zero**, delete the group's media (`MediaStore.deleteByGroups`) and then
   the group row;
3. **if non-zero and the batch contained the group's `anchorTrackId`**, null
   `anchorTrackId` and `nativeKey` on the surviving row — in the same
   transaction, so a group is never readable with a pointer to a track that is
   already gone (§4.5). `mediaKey` is untouched: the crop is the group's own
   blob.

Steps 2 and 3 are the operator's requirement expressed as code: **a group whose
last member is gone dies; a group with one member still alive does not, and it
degrades honestly rather than keeping a dead link.** Neither is an age rule —
the group has no clock (D61), and `check-age-keyed-retention.ts` check 1 fails
any method under `store/` that carries both a cutoff parameter and a delete.

Three consequences to build for:

- `TrackCascadeFamily` is a **closed union of five**
  (`delete-track-cascade.ts:22`), mirrored in `TrackCascadeTally`,
  `addLeafCounts`, `mergeCascadeTallies` and `TrackCascadeCounts` in
  `@camstack/types`. A `'groups'` family widens all of them.
- `retention/__tests__/cascade-completeness.spec.ts` cross-checks the seeder
  table against `TRACK_OWNED_FAMILIES` **in both directions**. A declared family
  with no seeder fails immediately — which is the guard that makes the "last
  member" rule provable rather than plausible. Seed a two-member group, delete
  one track, assert the group SURVIVES; delete the second, assert it is gone
  **and** its media with it. Remove the survivor branch and confirm the test
  fails; a green suite is not proof.
- Step 3 is the one mutation a group row ever receives after birth, and it is
  the pointer's whole cost (§4.5). Seed a group whose anchor is deleted while a
  second member lives, and assert: row survives, `nativeKey` null, `mediaKey`
  intact, the digest tile still renders. **Re-anchoring is deliberately not
  done** — it would change what a group's native frame IS, retroactively, for a
  picture the operator may already have seen.

### 6.4 Sizing on the real fleet

| | 72 h | per day |
| --- | --- | --- |
| tracks | 6 723 | 2 241 |
| sessions | 4 764 | 1 588 |
| groups (all, incl. singletons) | 5 409 | 1 803 |
| **multi-member groups** | **788** | **263** |
| tracks folded into them | 2 102 | 701 |
| median / mean group size | 2 / 2.67 | |

Per camera, multi-member groups per day: hall 76, sala da pranzo 45.7,
kitchen 30, parking 27.3, hallway piano terra 19, front door 10.3. The two
cameras of the live digest rule contribute **38/day** between them.

Rows: 1 803 group rows + ~2 500 membership rows per day, at ~200 B each →
**~0.9 MB/day**, ~6 MB at 7 days. Negligible.

Blobs, multi-member groups only, using measured medians and the **decided**
pointer for the native frame: crop 190 KB × 263 = **50 MB/day, ~350 MB at the
7-day `trackRetentionDays` default**, fleet-wide. Adding a 480 px small crop
costs **+4 MB/day**. The copy variant that was rejected would have added
**176 MB/day (~1.2 GB)** for byte-identical pixels.

---

## 7. What changes in the summaries

### 7.1 The delta, and how small it is

`summary-selection.ts` is pure and its three functions are unit-shaped. The
change is to make the unit a group:

| today | after |
| --- | --- |
| `SummaryCandidate { trackId, className, importance, zones, classes, stationary, confirmed, … }` | `SummaryCandidate { groupId, memberTrackIds, … }` with the class/zone/importance/stationary/confirmed facts **aggregated from the members** in the PORT, not in the pure function |
| `filterSummaryCandidates` drops per track | unchanged code; a group matches a class filter if **any** member does, a zone filter if **any** member visited it, `minImportance` against **max** member importance, `stationary` if **every** member is parked |
| `selectSummaryTiles` quota + rank per track | unchanged code; `rank: 'importance'` reads the max member importance, `'recency'` the group `closedAt`, `'dwell'` `closedAt − openedAt` |
| `pickSummaryMedia` walks `SUMMARY_MEDIA_LADDER` over a track's media rows | walks the group's `mediaKey` / `nativeKey`, and for a **singleton** group falls through to the member's clean full frame (`keyFrame`), never plate / face / member `thumbnail` |

The aggregation belongs in the port (`listTracks` becomes `listGroups`), which
is where `minHits` already lives and where the boundary comment already says
*"nothing here reads a `Track`"*.

`SUMMARY_MEDIA_LADDER`'s comment must be amended: it explains why
`fullFrameBoxed` and `firstFrame` are absent (*"a drawn rectangle is a permanent
lie in a digest tile"*). The group crop is clean by §4.4, so it goes on top of
the ladder, and the reason must be written next to it.

### 7.2 A subject in no group

**It is a group of one.** Every track in a session belongs to exactly one group,
because connected components over a session is a partition. That is what lets
the digest read groups and only groups — the operator's *"non devono utilizzare
tracce singole"* — with no fallback branch and no second code path.

A singleton group carries no media of its own and resolves through its member
(§4.6). The alternative — the digest reading groups for multi-track sessions and
tracks for the rest — reintroduces exactly the branch this design removes, and it
would leave the tile order and the quota operating on two different units.

### 7.3 The expected before/after, on the measured digests

**The tile count barely moves, and that is the honest answer.** With `maxTiles: 9`
and 21 matching candidates, the budget binds either way: before, 9 tiles show 6
groups; after, 9 tiles show 9 groups. Over the 12 real digests the total goes
**65 → 60 tiles (8% fewer)**, and it only falls at all in the windows that had
fewer than 9 candidates.

**What changes is what the mosaic shows.** Before: 8 of 65 tiles (12%) repeat a
group already on the same mosaic, and on the 19:37 digest 4 of 9 tiles are two
pixel-identical pairs. After: **zero, by construction** — no two tiles can come
from the same group — and the reclaimed budget goes to passages that were pushed
out.

The 19:37 digest, concretely:

```
BEFORE  9 tiles:  1 person · 2 parked cars (same frame twice) ·
                  [2 parked cars + woman-with-pram + man] (4 tiles, 2 pairs identical) ·
                  1 person · 1 car
AFTER   9 tiles:  [woman+pram, man] as ONE tile cropped on THEM ·
                  each parked car once · the two other passages ·
                  + 3 passages that did not fit before
```

The couple's tile stops being a wide shot of a car park with two small figures
at the right edge and becomes the §4.2 crop.

### 7.4 The 45% this design does not fix — task #15

29 of the 65 measured tiles are subjects that barely moved and 40 are `vehicle`.
Those rows were closed **normally**, not by stationary promotion, so both the
group's eligibility gate (§2.2) and the digest's own `includeStationary` filter
are structurally blind to them: over the 12 measured digests the filter dropped
**9 rows in total** while 447 of 603 vehicle tracks fleet-wide moved less than
60 px.

**Recorded as task #15, separate and immediately after this one. Groups must not
try to compensate for it.** Merging two parked cars into a "group" to save a
tile would be a group that does not move together and would make `memberCount`
meaningless — and a second stationarity threshold living in the clusterer would
be the fifth definition of "stationary" in this addon (§2.2). The two changes
are independent, they compose, and #15 is worth more tiles than this entire
design.

### 7.5 `maxTiles` — DECIDED: 12 (4×3)

The rule ships `maxTiles: 9` (`NC_SUMMARY_DEFAULT_TILES`, a 3×3 grid, *"the most
a phone lock-screen thumbnail can carry and still be read"*). With grouping the
unit changes, so the number has to be re-derived rather than inherited.

Distinct groups per digest over the 12 real windows: **median 5, p75 8, p90 14,
max 16**.

| `maxTiles` | digests that overflow | groups actually shown |
| --- | --- | --- |
| 6 | 4 / 12 | 50 / 72 (69%) |
| **9** (today) | 2 / 12 | 60 / 72 (83%) |
| **12** | 2 / 12 | **66 / 72 (92%)** |
| 16 | 0 / 12 | 72 / 72 (100%) |
| 24 (the cap) | 0 / 12 | 72 / 72 (100%) |

**Decided: 12** — a 4×3 grid.

The number was derived from the table rather than inherited, and the one input
the measurement could not supply — *where the digest is read* — the operator
supplied: **"lo leggo aprendo"**. The 3×3 default was therefore never a
lock-screen legibility constraint, and the reason to stay at 9 does not exist.

The derivation, and why not the other two rows:

- **9 loses 17% of the groups**, and it loses them at exactly the wrong moment:
  the two overflowing windows are the busiest ones, where a digest is most
  worth reading.
- **16 shows everything but breaks the tile.** At `MOSAIC_MAX_WIDTH` 1920 a 4×4
  grid gives 480 px per tile; a 4×3 gives 640 px wide by 360 tall — which is the
  detection raster itself, so the tile is no longer being asked to carry more
  detail than the pipeline ever had.
- **12 is where the marginal group gets cheap.** Going 9 → 12 buys 9 percentage
  points of coverage for one extra row; going 12 → 16 buys 8 more for a row that
  costs a third of every tile's linear size.

There is a second, larger reason to move up that the table cannot show: **a
group tile is a crop on its subjects, not a wide shot of a scene** (§4.2 — the
union bbox is 11% of the frame at the median). A 640 px tile of the couple is
more legible than a 960 px tile of the car park they walked through. The tile
budget can rise precisely because each tile now carries less scene.

**`maxTiles` is a RULE FIELD, not a property of the entity.** It lives on
`NcSummaryRule` (`summary-rule.ts:241`), is bounded by `NC_SUMMARY_MAX_TILES`
(24), and nothing in `TrackGroup`, the clusterer, the media path or the cascade
reads it or changes with it. Moving it is a one-line rule edit that can be
revisited any day without touching a line of this design — which is exactly why
it was safe to settle it by derivation.

---

## 8. The plan

### Phase 1 — the entity, its media, and the digest (the whole of this document)

Every decision it needs is made. The list is the build order.

1. **Eligibility + the clusterer**, pure, over closed sessions: drop
   `closedReason === 'stationary-promotion'` (§2.2) → `sessionsOf` → pair
   predicate (§2.4) → union-find → partition. ~150 lines with tests. It reads
   `PersistedTrack` in-process, so the stripped cap field needs no promotion.
2. **The two tables** — `pipeline-analytics:track-groups` +
   `:track-group-members` (§6.1) — with `@durable`, `ANALYTICS_COLLECTIONS`,
   the `TrackScopedStore` leaf, `TRACK_OWNED_FAMILIES`, the cascade seeder and
   the second orphan resolver (§6.2, §6.3).
3. **The instant chooser and the crop** (§4.1, §4.2), with the
   `containSubject: true` rule of §4.3 and a comment pointing at the
   [D212 amendment](../decisions/adr-0212-a-best-shot-square-must-deliver-the-subject.md).
4. **The crop blob** under `ownerKind: 'group'`, `resolveMediaOwner` extended,
   `MediaStore.deleteByGroups`; **`nativeKey` as a pointer** with the
   longest-lived-member anchor and the three degradations of §4.5.
5. **The digest reads groups** (§7.1), and `maxTiles` moves to **12** (§7.5).
6. **The Phase-1 header edit** — delete the replacement promise, write the
   two-table contract (§6.1). Half an hour, and it stops the next session
   deleting a working feature.

**Verification, in this order, and none of it optional:**

| step | how it is proved |
| --- | --- |
| eligibility | over the same 72 h: **0 multi-member groups may contain a stationary-promoted member** (measured 0 with the gate, 229 without). Force the gate open and confirm the assertion fails. |
| the clusterer | run it **offline over the last 30 days of stored tracks** and read the merges. It needs nothing live. Against the 12 measured digests: redundancy must go to 0 and the group count must land near 57. |
| the crop | re-render the four named passages of §2.6 and look at them. Containment must be 1.00 on every one — including the 19:10 family group, which scores 0.53 under the default layout. |
| the anchor | over a sample of real groups, the chosen anchor owns a clean full frame (measured 56/56). Then delete the anchor track and assert the group survives with `nativeKey` null, `mediaKey` intact, and the tile still rendering. |
| the cascade | `cascade-completeness.spec.ts`: two-member group, delete one → survives; delete the second → gone, media gone. **Remove the survivor branch and confirm the test fails.** |
| occupancy | a test asserting `recordFrame` counts members, not groups. |
| the digest | the same 12 windows, before and after, tile by tile, at `maxTiles: 12`. |

### Phase 2 and later — listed, not designed

- **A group card in the events feed / timeline** — one card that expands to its
  members, never one that replaces them.
- **A sampled union-bbox trajectory**, when a consumer needs motion (§3.2).
- **Live groups**, if a notification ever wants one. This is where merge and
  split stop being forbidden, and it is a real design, not an increment.
- **Cross-camera groups** — the same arrival seen by *front door* and
  *parking*. Out of scope and probably a different entity.
- **Composition** (the D34 rider fold as a first-class relation) — unchanged
  from `track-grouping-analysis.md` §8 Phase 3, still last.

### Risks, and what NOT to do

- **Do not put grouping in the tracker.** Every mechanism in `SortTracker`
  exists to keep two subjects from becoming one.
- **Do not add a `secondaryClass` or any fourth class axis to a track.** A group
  is a relation; `packages/addon-pipeline/src/__tests__/guards/label-tier-declared.guard.ts` and D89 exist to stop
  this and they are right.
- **Do not let a group own an age clock.** D61, and
  `check-age-keyed-retention.ts` will fail the commit.
- **Do not write group pixels under `ownerKind: 'track'`.**
- **Do not draw boxes on the group media.** It is a digest tile and, for the AI
  pass, text burnt into pixels is an injection channel.
- **Do not change occupancy.**
- **The biggest risk is silent over-merge on indoor cameras.** The 24-track
  hall group is correct for a digest and would be wrong for a notification.
  Phase 1 ships to the digest only, and the offline validation over 30 days is
  what catches the cases the 72 h window did not contain.

---

## 9. The mandate — Phase 1, decided

Nothing here is open. This section is the implementation brief; everything above
it is the evidence for a line of it.

**The entity.** Two tables in `pipeline-analytics`. `track-groups`:
`id, deviceId, timestamp` (the chosen instant), `openedAt, closedAt,
memberCount, anchorTrackId, ux/uy/uw/uh` (the union bbox at `timestamp`,
normalised) `+ frameWidth/frameHeight, mediaKey, nativeKey, sealed`.
`track-group-members`: `id, groupId, trackId, deviceId, timestamp` — one row per
member, and the column must be named exactly `trackId`. **No class, label,
identity, importance, zone or trajectory on the group**: all of it is read
through the members. `anchorTrackId` and `nativeKey` are the only fields mutable
after birth. §3.

**The predicate.** Per camera, per session (tracks chained by temporal overlap,
3 s slack). **Eligibility first: drop `closedReason === 'stationary-promotion'`**
— the stationary registry's own verdict, the same authority the digest already
applies (`index.ts:3552`). Never `Track.state`, never `totalDistance`, never a
threshold of our own (D62). D204's phantom cells act pre-birth and are inherited
for free. Then, among eligible tracks: sample the overlap every 500 ms, and
**A ~ B iff `cohesion ≥ 0.5` AND NOT (both move AND `cos < 0.3`)** — proximity
is the rule, direction only vetoes a crossing. A group is a connected component;
the result is a **partition**, so a lone subject is a group of one. §2.

**The media.** ONE crop plus a pointer. The instant is chosen at group close over
stored `positions[]`, by tier: completeness → square containment (D212) →
recognition (D213) → edge-clear → effective score. The crop is
`wideCentralSquareLayout` over the **union bbox** — one derivation, no new
geometry (D52) — and **a caller whose box is a union requests
`{ containSubject: true }` unconditionally, never the 0.5 threshold: half a
subject is acceptable, half a group is the wrong group** (the
[D212 amendment](../decisions/adr-0212-a-best-shot-square-must-deliver-the-subject.md)).
Pixels come only from a member's `keyFrame → keyFrameSmall` within 2 s; no clean
frame means **no media, said out loud**, never a fabricated one. `nativeKey` is a
**pointer** to the anchor's `keyFrame`, the anchor is the **longest-lived member
that owns a clean frame**, and a singleton group owns no blob at all. §4.

**The lifecycle.** A group is **born at session close**, when every member is
final. Membership is **sealed**; merge and split cannot occur because a
partition has neither. It is never live. A crash loses nothing: the pass is
replayable from stored rows. §5.

**Persistence and prune.** `@durable` on both collections; both listed in
`ANALYTICS_COLLECTIONS`. `track-group-members` is **`track-owned`**
(`derived`, on the `trackId` column) and rides the existing cascade;
`track-groups` is **`owner-indirection`** and needs a **second resolver in
`buildOrphanScopes`** — do not classify it `never-orphaned`, that makes the
guarantee unverifiable by the tool built to verify it. The cascade step, in
`cascadeDeleteTracks`: delete the membership rows; **if a group has zero
survivors, delete its media then the row; if it has survivors but lost its
anchor, null `anchorTrackId` and `nativeKey` in the same transaction.** A group
with one live member does not die, and it never keeps a dead link. No age clock,
ever (D61). §6.

**The summaries.** `SummaryCandidate` becomes group-shaped; the aggregation from
members happens in the PORT, not in the pure functions, which keep their code.
The group crop goes on top of `SUMMARY_MEDIA_LADDER` with the reason written
beside it. Singletons resolve their picture through their one member's clean
full frame (never a plate/face/member thumbnail), so there is **no fallback
branch and no second unit**. `maxTiles` moves to **12** — a rule
field, not a property of the entity. §7.

**Do NOT, in Phase 1:** put grouping in the tracker · add a class axis to a
track · give a group an age clock · write group pixels under `ownerKind:
'track'` · draw boxes on the group media · change occupancy · re-anchor a group
that lost its anchor · make the clusterer compensate for parked cars (**task
#15**, separate and immediately after) · ship groups to notifications, the
timeline or the events feed.

**Prove it before claiming it** (§8): 0 groups containing a stationary-promoted
member, with the gate forced open to see the assertion fail · the clusterer run
offline over 30 days and the merges read by a human · containment 1.00 on the
four named passages · anchor deleted and the tile still rendering · the cascade
survivor branch removed and the test confirmed RED · the same 12 digests, tile by
tile.

**Phase 2 and later stay listed and undesigned** (§8): a group card in the
timeline, a sampled union trajectory, live groups, cross-camera groups,
composition.
