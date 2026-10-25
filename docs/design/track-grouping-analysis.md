---
title: Track grouping — one event for a group of subjects
last-verified: 2026-09-10
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/**
  - packages/addon-post-analysis/src/notification-center/**
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

<!-- covers-demotion 2026-09-09 -->
> **2026-09-09** — this page's `applies-to` entries were 38 whole subtrees. `applies-to` means *I checked this code on the stated day* (D145) and nobody ever checked 38 subtrees: the page stayed suspect at every pipeline change, i.e. always, and an always-red ratchet is a ratchet one learns to ignore. They become `covers:`, which is what they always were — a coverage claim, not a verification.

<!-- covers-demotion 2026-09-15 -->
> **2026-09-15 — this page is a DATED ANALYSIS, not a description of today's
> code.** Its measurements were taken on the live hub on **2026-08-14**; the
> status block below layers the corrections that later implementations forced
> on it. The two remaining `applies-to` caps
> (`pipeline-analytics.cap.ts`, `notification-rules.cap.ts`) follow the 38
> subtrees into `covers:` for the same D145 reason: this document does not
> describe the current shape of either cap — the one cap API it cites by line,
> `listGroups` / `getGroup`, was DELETED (D330) and the line reference is
> preserved as history. Nobody re-checks a cap against a document anchored to
> an August measurement, so it must not arm the staleness ratchet.
>
> One thing a reader must not conclude from the status block: **there is a
> group entity today.** The block's "§4 Option A … was BUILT and then REMOVED"
> is still true of `pipeline-analytics/group/` — that directory, its two
> tables and `listGroups` / `getGroup` are gone, and the Phase-1 NC burst
> merge (`NcGroupBuffer`, D143) is still the live delivery path. But a
> SUCCESSOR shipped after this document stopped being updated: the **Summary**
> (`pipeline-analytics/summary/`,
> [D359](../decisions/adr-0359.md)) — a per-camera session envelope that
> references tracks as members, with roles, join-time classes, a group shot
> (`groupShotMediaId`) and its own `listSummaries` / `listRecentSummaries` /
> `getSummary` cap surface. It is born and sealed differently from anything
> §4–§5 proposes. Read D359 and the summary sources for what a group IS now;
> read this page only for why the problem was framed the way it was.

# Track grouping — one event for a group of subjects

> **2026-09-29 — the SUCCESSOR is deleted too
> ([D680](../decisions/adr-0680-nearby-track-grouping-is-deleted-with-its-tables-and-its-cap-surface.md)).**
> The session summary named in the block above (`pipeline-analytics/summary/`, <!-- drift-ok: naming the deleted directory IS the record -->
> `listSummaries` / `listRecentSummaries` / `getSummary`, the group shot) was
> removed with its tables. There is no group entity today. The NC burst merge
> (`NcGroupBuffer`, D143) is still live and is a different mechanism.

> **Status: PHASE 0 + PHASE 1 SHIPPED (2026-08-14).** Every number below was
> measured on the live hub on 2026-08-14 and still stands — the measurement
> commands are in §1. What has changed is that §8's Phase 0 and Phase 1 are
> implemented; the decision is recorded as [D143](../decisions/adr-0143.md) and
> the D34 record gap is closed in [D34](../decisions/adr-0034.md)'s own
> amendment. **Phase 2 (the group ENTITY) and Phase 3 (composition) are still
> analysis** — §4 Option A, §5's peak-of-co-presence frame recipe and the
> geometric cohort test of §3 Question B are NOT built. Read §8 for the split.
>
> Corrections the implementation forced on the analysis:
>
> - §2.5 says "text is frozen at enqueue". The FACTS are (the payload subject);
>   the sentence is composed at SEND from them, which is what lets a group
>   revision re-word itself without a second vocabulary.
> - §2.5's account of `mediaFrame: 'boxed'` was right that it decided nothing,
>   and wrong about why there was no alternative: `firstFrame` / `snapshot` /
>   `lastFrame` are written by `boxedTimelineFrame` and DO carry a burnt-in box.
>   `'boxed'` now prefers them. The `'full'` ladder's claim that every one of its
>   rungs is "a clean, unannotated whole scene" was false for three of five.
> - §5 step 1 (argmax over 500 ms buckets) was not built. Phase 1 uses the reference detector's
>   monotonic rule instead — the newest growth IS the greatest co-presence seen
>   so far — which needs no retrospective pass and no stored positions at
>   delivery. The argmax belongs to Phase 2, where the group owns a row to put
>   the chosen instant in.
>
> Re-verified 2026-08-21 after the track-fixes batch. Two of those fixes change
> the POPULATION the measurements counted, not this design: the importance
> scorer's identity exemption now reads tier-2 only
> ([D203](../decisions/adr-0203-a-sub-class-is-not-an-identity.md) — importance
> is not part of any grouping predicate here, but rule conditions using
> `minImportance` now see honestly-demoted parked objects), and phantom cells
> ([D204](../decisions/adr-0204-a-phantom-cell-outlives-the-tracks-that-made-it.md))
> refuse part of the recurring short-motionless births, so per-camera track
> volume — the raw input to burst sizes — drops on the cameras that had them.
> Neither alters a conclusion in §3–§9.
>
> Re-verified 2026-08-26. **The line above saying Phase 2 (the group ENTITY)
> "is still analysis" / "NOT built" no longer holds — it was designed AND
> built between 2026-08-21 and 2026-08-24, then killed the same day it
> shipped.** Two follow-on design docs record it in full:
> [`2026-08-21-group-entity-and-group-media.md`](./2026-08-21-group-entity-and-group-media.md)
> specifies the entity (`pipeline-analytics:track-groups` /
> `track-group-members`, a pair predicate of cohesion ≥ 0.5 with a
> crossing veto — close to but not identical to this document's `d ≤ 1.5` /
> `cos > 0.6` — the union-bbox crop forced to `{ containSubject: true }`, the
> `nativeKey` anchor pointer, and the cascade), and
> [`2026-08-24-live-group-tracking.md`](./2026-08-24-live-group-tracking.md)
> supersedes this document's and the 08-21 doc's birth mechanism: groups are
> assigned **live in RAM** on every track upsert (1.5 s-to-join /
> 3 s-to-leave hysteresis, a peeler becomes a new singleton id) and persisted
> sealed only once idle 30 s — not born by a session-close census, and not
> "sealed-at-open" as §9 Q6 here recommended. `listGroups` / `getGroup`
> shipped on `pipeline-analytics.cap.ts`
> (`packages/types/src/capabilities/pipeline-analytics.cap.ts:1040`) and
> a Groups tab shipped in the viewer. **It is GONE as of 2026-09-01:**
> duplicate sealed rows made the tab unusable (same camera + same minute
> repeated a dozen times, found 2026-08-24), the whole path was gated behind
> `GROUPS_PROCESS_ENABLED = false` —
>
>  — and on 2026-09-01 the operator decided to DELETE it rather
> than re-open it
> ([D330](../decisions/adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)):
> `pipeline-analytics/group/`, the two tables, `listGroups` / `getGroup` and
> the two digest ladder rungs are all removed. The Phase-1 notification-center
> burst merge ([D143](../decisions/adr-0143.md)) is a different path and stays
> live. So: §4 Option A and §3 Question B's
> geometric cohort test were BUILT and then REMOVED; §5's peak-of-co-presence
> recipe is superseded by the newer docs' tier order (completeness, then
> D212 containment, then D213 semantic, then edge-clear, then score).
> Everything else this document claims stands: Phase 0's `frameId` column is
> still in `OBJECT_COLUMNS` and was explicitly kept in the 2026-08-25 SQL
> slim-projection pass (`event-store.ts:119,185`); the
> Phase 1 NC burst merge (`NcGroupBuffer`, D143) is untouched and still on by
> default; the D34 rider-pairing record gap (§2.3) is still open — no commit
> touched `pipeline/rider-pairing.ts` in this window.

The operator's request, restated: today a group of subjects moving together
produces one track per subject, so one arrival becomes several events and
several notifications. Individual tracks should STAY individual — that was the
original requirement and it is still right. What is missing is a **group**: a
first-class relation over concurrent tracks, with ONE representative frame that
shows all of them, so a group produces ONE event and ONE notification.

Three cases were named: (a) several people walking in together; (b) a bicycle
or motorbike, which arrives as a separate vehicle and person; (c) similar
compositions, e.g. a person walking a dog.

The operator also asked: *"a track has a single type — can we extend it with an
extra attribute?"* §6 answers that directly, and the short answer is **no, not
as an attribute** — this repo already carries three class-ish axes on a track and
a fourth would be the second-source-of-truth failure it has shipped twice. A
group is a **relation between entities**, and the vocabulary for it already
exists.

---

## 0. The four findings that decide the design

Read these before the rest; each one changes what the cheapest correct answer is.

1. **Case (b) is already solved and has been since 2026-07-31.** A person on a
   two-wheeler is folded into ONE vehicle subject BEFORE the tracker
   ([D34](../decisions/adr-0034.md), `pipeline/rider-pairing.ts`). No bicycle
   design is needed — what is needed is a check that it is actually firing on
   this fleet, and one honest correction to what it records (§2.3).
2. **The scene key already exists, is already stamped, and is silently
   discarded at persist.** `ObjectEvent.frameId` is documented verbatim as *"the
   'scene/parent' key… lets a consumer group co-occurring detections (e.g. 2
   people + 1 dog) under one full frame"*, and `frame-processor.ts:886` stamps
   it on every event of a frame. There is **no `frameId` column** in
   `OBJECT_COLUMNS`, and the sqlite backend drops undeclared keys without error
   (`sqlite-settings-backend.ts:408`, `if (decl.columns.has(k))`). Verified on
   live rows: not one persisted object event carries a `frameId`. This is a
   leftover that describes the right design and therefore reads as verification
   of it — the exact failure CLAUDE.md warns about.
3. **The multi-box renderer already exists and is already tested.**
   `drawBoxedFrame(frameData, w, h, boxes: readonly FrameBox[], opts)`
   (`shared/frame/box-drawer.ts:66`) takes N boxes with per-box colour and
   caption. All three production call sites pass `[]` or `[box]`. So does the
   multi-subject SENTENCE: `ncDetectionSummary` (`text-compose.ts:122`) already
   renders *"1 persona, 2 veicoli e 3 animali"* with real CLDR plurals, and the
   plural forms already ship in `texts/en.json` / `it.json`. Neither is reachable
   from a detection notification.
4. **The current answer to the repetition is a blind cooldown, and it is
   lossy.** Measured on device 101 / rule *Persona su Uscio* over 6 days: **116
   qualifying tracks → 74 notifications; 44 tracks (37.9%) suppressed
   outright**. Of the 44, **23 temporally overlap a track that DID fire** — they
   are group members whose existence never reached the operator — and **7
   carried a confirmed identity** (Person A, Person C, Person B) that was silently
   discarded. The cooldown collapses volume by DISCARDING. A group collapses the
   same volume by MERGING. On both axes — fewer notifications AND more
   information — grouping strictly dominates what is shipped today.

---

## 1. What was measured

All figures below come from the live hub (<hub-ip>), 2026-08-14, via
`scratchpad/hub.mjs`. The probes are kept in `scratchpad/_group-probe.mjs`,
`_group-notif.mjs`, `_group-frame.mjs`, `_group-suppressed.mjs`,
`_group-cohesion.mjs` (gitignored).

### 1.1 Concurrency is the normal case, not the exception

48 h, whole fleet, tracks clustered per camera by temporal overlap (3 s slack):

| | |
| --- | --- |
| tracks in window | 120 |
| clusters of ≥2 overlapping tracks | 17 |
| tracks that belong to a cluster | **43 / 120 (36%)** |
| cluster size histogram | 2×13, 3×2, 4×1, **7×1** |

The 7-track cluster is the operator's case (a), verbatim — device 104,
09:13:46 → 09:15:35, seven `person` tracks, three of them identified (Person C,
Person A, Person B).

### 1.2 A "group" is NOT one instant — the max co-presence is much smaller

For that 7-track cluster, sampling every 500 ms and asking how many tracks have
a position within ±1 s:

```
MAX CO-PRESENCE: 3 tracks at 09:15:03.5   (of 7 in the cluster)
```

This is the single most important structural fact in this document. **The thing
the operator perceives as "one group arriving" and the thing that is
"simultaneously visible in one frame" are different sets**, and a design that
conflates them will disappoint. Seven people over 110 s never share a frame; at
best three do. Section 2 names the two questions and keeps them apart.

### 1.3 What "walking together" looks like numerically

562 temporally-overlapping pairs, 5 cameras, 3 days. For each pair, sampled at
500 ms: `d` = centroid gap ÷ mean bbox diagonal; `cos` = cosine between the two
net displacement vectors.

| statistic | value |
| --- | --- |
| median `d` | **0.94** |
| p10 / p25 / p75 / p90 | 0.43 / 0.58 / 1.54 / 2.12 |
| pairs with `d ≤ 1.0` | 304 / 562 (54%) |
| pairs with `d ≤ 2.0` | 495 / 562 (88%) |
| pairs with measurable motion on both | 318 |
| of those, `cos > 0.7` (same direction) | **163 (51%)** |
| of those, `cos < −0.3` (opposite) | **82 (26%)** |

**Proximity alone is not enough.** A quarter of the tight pairs are people
walking PAST each other in opposite directions — a crossing, not a group. The
direction test is what separates them, and it is cheap (two subtractions and a
dot product over stored positions). Any proposal that clusters on IoU/distance
without a motion agreement term will merge crossings, and a wrong merge is worse
than no merge: it hides a subject the operator was told about before.

### 1.4 The person+animal case is real and abundant

Cross-class overlapping pairs in that window are **almost all `person`+`animal`**
— 18 of them, `d` as low as 0.23, many with `cos ≈ 1.0` (identical direction).
That is the dog-on-a-leash case, and it is the only cross-class cohort that
actually occurs on this fleet. **Zero `person`+`vehicle` cohort pairs appeared** —
which is exactly what D34 predicts, because the bicycle case is folded before the
tracker ever sees it and a car does not co-move with a pedestrian.

Note the interaction: the tracker's `classGroupAssoc` already puts `person` and
`animal` in ONE association group (`sort-tracker.ts:361`), so those two can
cross-associate. A person+dog cohort is therefore also the place where a track
can flip class mid-life. Grouping them must not paper over that.

### 1.5 What the notification path did with those groups

The whole enabled rule set was read (`notificationRules.listRules`); every
detection rule on this hub carries `throttle: { cooldownSec: 60, scope:
'rule-device' }` and `media: { attach: 'best', frame: 'full', gif: true }`.

Delivery history, device 101, rule *Persona su Uscio*, 6 days:

| | |
| --- | --- |
| object events on the camera | 2 266 |
| events matching the rule's conditions (person, ≥0.7, zone Uscio) | 532 |
| distinct tracks that qualified | **116** |
| notifications delivered | **74** (74 distinct tracks) |
| qualifying tracks suppressed by the cooldown | **44 (37.9%)** |
| …of which temporally overlap a delivered track | **23** |
| …of which carried a confirmed identity | **7** (Person A, Person C, Person B) |

Two real bursts, showing the shape:

```
2026-08-08 17:31–17:34   11 person tracks (5 identified)  →  3 notifications
2026-08-09 08:33–08:36   13 person tracks (1 identified)  →  2 notifications
```

In the 08-08 burst, *Person D* was recognised at 17:32:38 and never notified,
because *Person A*'s track had fired 10 s earlier and spent the 60 s window.
That is the cost of a suppressor that has no idea what it is suppressing.

Also worth stating plainly, because it contradicts a natural reading of the
code: the cooldown does **not** reduce a group to one notification in practice.
It reduces it to one notification *per 60 s*, and a real group spans 1–4
minutes, so the operator still gets 2–3. They get the volume of a group AND the
information of a single subject.

### 1.6 The group frame is constructible from stored data, today

For the 7-track cluster, at the 09:15:03.5 co-presence peak:

```
2b88bce3  person/-          bbox={x:429.7,y:27.4,w:59.1,h:117}    dt=+521ms
01d40bd4  person/Person B   bbox={x:201.3,y:145.0,w:59.1,h:75.5}  dt=−197ms
140e3577  person/Person A    bbox={x:117.2,y:67.1,w:103.1,h:191.3} dt=−197ms
```

…and `2b88bce3` owns a **`keyFrame` captured at 09:15:04** — 500 ms from the
peak — plus a `keyFrameSmall`. Person A owns a `snapshot` at 09:15:02 and
Person B one at 09:15:04.

So the representative frame needs **no new capture path at all**: an existing
clean full frame, plus each concurrent member's stored `positions[]` sample
nearest that frame's timestamp, plus a renderer that already takes N boxes.
`TrackPositionSchema` is `{x, y, timestamp, bbox}` — the geometry is all there,
and it is there *retroactively*, which means a group can also be computed over
history.

---

## 2. How things stand today

### 2.1 Where tracks come from

Tracking runs in `pipeline-analytics`, not in the detection process — one
`FrameProcessor` per `${deviceId}:${source}` (see
[post-analysis.md](../architecture/post-analysis.md)).

`SortTracker` (`pipeline/tracker/sort-tracker.ts`) is IoU-based greedy SORT with
constant-velocity extrapolation — **no Kalman filter**. Association runs in five
ordered passes: ByteTrack high-score, a rescue pass (IoU 0.1 **or** centroid
≤ 0.75 × diagonal), ByteTrack low-score re-acquisition, resurrection from the
graveyard within `resurrectionWindowMs` (8 s), then spawn.

**Association is class-gated.** `associable()` (`sort-tracker.ts:372`) compares
association GROUPS, and `assocGroup()` collapses only `{person, animal}` into
one. A `person` detection can therefore never join a `vehicle` track, and a
group of any kind can never become one track by accident. Defaults that matter
here: `iouThreshold` 0.3, `maxMissedMs` 4000, `minHits` 3, `dedupSpawnIou` /
`dedupMergeIou` 0.6.

The relevant point for this design: **the tracker is not where a group belongs.**
It is a per-subject associator with a class gate, and every mechanism in it
(dedup, occlusion, duplicate-spawn suppression) exists to keep two subjects from
becoming one. Pushing grouping into it would fight its purpose.

### 2.2 What a track and an event carry

`TrackSchema` (`pipeline-analytics.cap.ts:432`) — and the three class-ish axes
that already exist:

| axis | field | semantics |
| --- | --- | --- |
| macro class | `className` | set at FIRST sighting and never reassigned in `upsert` |
| observed set | `classes[]` | every detector class seen over the track's life |
| tier 1 | `label` / `labelScore` / `labelMeta` | the SUB-class (`dog`, `van`) |
| tier 2 | `subLabel` / `subLabelScore` / `subLabelMeta` | the INSTANCE (`Alice`, `DWRO309`) |

The tier rules are [D89](../decisions/adr-0089.md): the tier is DECLARED on the
step, a macro token is refused at every tier, and one function
(`resolveTieredLabelWrite`) writes all four writers. **There is no `groupId`, no
`parentId`, no `relatedTrackIds` and no secondary class on a Track.**

At the level BELOW the track, two relations already exist:

- `ObjectDetection.parentId` (`types/detection.ts:277`) — links a face/plate
  detail to its first-level person/vehicle box within one frame.
- `ObjectEvent.frameId` — the scene key of finding 2, stamped and dropped.

### 2.3 Case (b) is already implemented — with one honest gap

`pairRiders` (`pipeline/rider-pairing.ts`) runs in `FrameProcessor.process`
step 2, **before the stationary gate and before the tracker**. A pair qualifies
when: the vehicle's ORIGINAL fine class is in `{bicycle, motorcycle, motorbike}`;
≥25% of the person's box lies over the vehicle's (`RIDER_MIN_PERSON_OVERLAP`);
and the person's box centre sits ABOVE the vehicle's. A person is paired at most
once, with the two-wheeler they overlap most. The rider detection is then
**deleted from the frame** (`frame-processor.ts:563`) so only the vehicle is
tracked.

D34 and the code comment both say *"the person is not lost — it is reported so
both entities stay on the record."* **That is not what happens.** The pair is
written to `this.lastRiderPairs`, a per-processor in-RAM field read by one
accessor, and it carries `{overlap, personScore, vehicleScore, vehicleClass}` —
scores, not entities. Nothing about the person reaches the track row, the event
row, the notification or the timeline. The record says `vehicle`, full stop.

That gap is small and worth closing on its own merits, and it is also the
cleanest proof of the §6 answer: what the rider case wants is not a new class
attribute, it is a way to say *"this vehicle subject CONTAINS a person"* — a
composition, which is a relation.

Also unverified on this fleet: no rider fold has been observed in the measured
windows (zero person+vehicle cohort pairs, §1.4 — consistent with the fold
working, but also with no cyclist having passed). Before designing anything for
bicycles, grep for the fold's log line rather than assuming either way.

### 2.4 Where the repetition actually lands

Four surfaces, and they fail differently:

| surface | today | with a group |
| --- | --- | --- |
| **notifications** | one evaluation per ObjectEvent; the 60 s `rule-device` cooldown drops the rest (37.9% of qualifying tracks, §1.5) | one notification naming N subjects |
| **viewer events feed** | `KeyEvent` = one row per track. Seven cards for one arrival | one card, expandable |
| **timeline** | one entry per track | as above |
| **occupancy** | `zoneAnalytics.recordFrame` counts per tracked detection — 3 people = 3 | **must not change.** 3 people are 3 people |
| **retrain / galleries / CLIP** | per track, per key frame | **must not change.** A group has no pixels of its own |

### 2.5 The notification path, precisely

One entry point, per record, serialized:

```
frame-processor emits N ObjectEvents (all sharing frameId)
  → pipeline-analytics/index.ts:5300  onObjectEventPersisted(e)      ← once PER EVENT
  → notification-center/index.ts:2377 consumeEvent(incomingFromObjectEvent(e))
  → scheduleEvaluation → this.evalChain (a serialized promise chain)
  → evaluateAndEnqueue:
       per-camera mute
       rulesForTrigger(delivery)
       evaluateRule(rule, subject, …)
       runRuleActions                      ← actuation, BEFORE the cooldown
       cooldownKey(rule, subject)          ← r:<ruleId>:d:<deviceId>[:c:<class>]
       isCoolingDown → suppressed, continue
       buildEntries  → one outbox row per (rule, target)
       outbox.enqueue → lastFiredAt.set(key, now)
  → drain every 2 s → NcDispatcher
```

Facts that shape the options:

- `NcRuleSubject` carries `classNames[]`, `trackId?`, `bbox?` — and **no
  `frameId`**. `grep -rn frameId notification-center/` returns zero hits. The
  scene key dies at the intake boundary even before it dies at persist.
- The cooldown key contains **no trackId**, by design: it is a volume budget.
  `granularity: 'per-class'` splits it per class, which means 2 people + 1 dog
  give 2 notifications, not 1 and not 3.
- The outbox dedup id is `${ruleId}:${dedupRef}:${targetId}` with `dedupRef =
  trackId` — that is the durable "at most one notification per track per rule
  per target" guarantee. It does not help across tracks, because the trackIds
  differ.
- Text is **frozen at enqueue**; media is re-resolved at send.
- With `frame: 'full'` (which every rule on this hub sets), `resolveAttachment`
  reverses to the TRACK owner and picks `keyFrame → keyFrameSmall → firstFrame →
  lastFrame → snapshot`. **The notification already carries a clean full frame of
  the scene.** It simply has no boxes and names one subject.
- `mediaFrame: 'boxed'` is authorable and does nothing: it prefers
  `fullFrameBoxed`, a kind **retired for new tracks since 2026-07-21**, so it
  degrades to the same clean `keyFrame` as `'full'`. A second leftover.

### 2.6 There IS a working aggregation precedent in the NC

`notification-center/summary/` already does window-collect → barrier →
select-with-quota → render → ONE outbox row, entirely inside the ordinary
outbox/dispatcher path:

- `summary-collector.ts` — observes motion and **track CLOSE** as the barrier, so
  a digest never renders before its subjects' best shots are written;
- `summary-selection.ts` — per-camera quota so one busy camera cannot take every
  tile;
- `mosaic-renderer.ts` — sharp-composited tiles, `MOSAIC_MAX_WIDTH` 1920;
- `summary-delivery.ts` — `recordId = summary:<ruleId>:<windowEndMs>`, text
  rendered and frozen at enqueue.

Whatever a group notification becomes, it should be built out of these pieces
rather than beside them. The mosaic renderer also states a constraint that
applies directly to §4: **it is deliberately CLEAN, never boxed** — *"a burnt-in
box is permanent"*. `retrain-frame-selection.ts` says the same harder:
`fullFrameBoxed` is *"worse than useless"* as training material.

---

## 3. What "a group" means — two questions, not one

The measurements force this distinction, and every option below is clearer once
it is made.

### Question A — the BURST (a session on one camera)

*"These 7 tracks are all one arrival."* Criterion: temporal chaining on one
camera — track B starts before track A ends (plus slack). No geometry.

- Matches what the operator experiences as "one event".
- Catches all 7 of the measured cluster.
- Cheap: one comparison per track birth against the open burst.
- Risk: over-merges. Two unrelated people arriving 2 s apart from opposite ends
  become one "group of 2". On a doorway camera this is usually fine; on a street
  camera it is not.

### Question B — the COHORT (subjects moving together)

*"These 3 people are walking together."* Criterion: temporal overlap **plus**
proximity **plus** motion agreement (§1.3: `d ≤ ~1.5` and `cos > ~0.6`).

- Matches "a group of people walking together" and "a person with a dog"
  literally.
- Catches at most 3 of the measured 7 — a cohort is by definition simultaneous.
- Costs one O(n²) pass over the ≤10 concurrent tracks of one camera, on stored
  positions. Negligible.
- Risk: under-merges. The 4 people who arrived 20 s later are a separate cohort
  and the operator still gets 2 notifications.

**They are both wanted, and they nest.** A burst contains one or more cohorts.
The honest model is a two-level one, but the honest *first shipment* is to pick
the one that fixes the complaint — which is the burst, because the complaint is
"too many notifications", and the cohort, because the complaint is "they were
walking together". Section 8 recommends the order.

### Question C — prior art says: ship the burst, and skip the geometry

**The reference detector has shipped exactly this feature since 0.14.0 (2024-08-08), and its
grouping rule has no spatial reasoning at all.** It is called a **review item**
(`reference-detector/models.py` `ReviewSegment`, `reference-detector/review/maintainer.py`), and it is
the strongest evidence available for what is worth building.

| | The reference detector's answer |
| --- | --- |
| grouping key | **camera + temporal overlap.** One open segment per camera; segments cannot overlap |
| membership | any active tracked object (not stationary, has moved, not a false positive, label in the alert/detection list, inside required zones) |
| close rule | an **idle cutoff after the last qualifying activity** — 40 s for `alert`, 30 s for `detection`. Not a fixed window |
| severity | `alert` \| `detection`, and a `detection` segment is **promoted in place** when a `person` shows up |
| stored shape | `{severity, start, end, thumb_path, data: {detections: [objectIds], objects: [deduped labels], sub_labels, zones, audio, thumb_time}}` |
| thumbnail | **union bbox of all currently-active objects**, expanded to 16:9, re-taken whenever the simultaneous-object count sets a **new high**. No boxes drawn |
| notification | ONE push per review item, titled from the joined label set — *"Person, Car detected in Driveway"*. **Re-fired only when the set GROWS** |
| cooldown | `notifications.cooldown`, default **0 s** |
| 0.17 addition | one LLM call per review item over 3–20 frames, producing a `shortSummary` explicitly *"suitable for notifications"* + a `potential_threat_level` |

Four things to take from it, and one not to:

1. **The temporal rule alone is enough to ship.** The reference detector does not cluster by
   proximity or motion. Our §1.3 measurement says a geometric cohort test is
   *available and cheap* — but it is an upgrade, not a prerequisite.
2. **Close on an IDLE CUTOFF, not a fixed window.** A fixed window cuts a group
   in half when it takes longer than the window; an idle cutoff extends for as
   long as the arrival is still happening. The measured 7-track cluster spans
   110 s with gaps well under 30 s — an idle cutoff would hold it as one group;
   a 12 s fixed window would split it into three.
3. **Notify at OPEN and update as the set grows.** This is the finding that
   removes the whole latency objection to Option B (§4). The reference detector does not wait
   for the group to be complete — it pushes as soon as the segment opens and
   re-pushes when the object set grows, suppressing the re-push when it has not
   (`len(before.objects) == len(after.objects)`). Our dispatcher already sets
   `tag: entry.ruleId` on the push for exactly this client-side coalescing.
4. **The thumbnail heuristic is cheaper than ours and monotonic**: keep the
   frame with the most simultaneous subjects seen SO FAR, rather than searching
   for the peak at the end. Same answer, no retrospective pass.

The one not to take: the reference detector's review thumbnail is an **unannotated union
crop**. Ours can be strictly better, because `drawBoxedFrame` is already N-box
and our tracks carry identities — a frame that captions *Person A* and
*Person B* by name is something the reference detector cannot produce.

**The reference detector does NOT fuse person+bicycle.** Its attribute system
(`DEFAULT_ATTRIBUTE_LABEL_MAP`) is a real parent/child relation — used for
`face`, `license_plate` and delivery logos, assigned by **containment** (not
IoU), to the **smallest** matching parent, and **abstaining entirely when two
same-label parents both match** — but `bicycle` is deliberately not in it, and
The reference detector+ instructs annotators to label person and bicycle separately. There is
no popular open-source implementation of cyclist fusion at all; the technique
lives in AV papers (post-hoc IoU merge at ~0.6, with a documented failure at
frontal views where bicycle detection rate drops ~0.65 absolute). **D34 is ahead
of the field here**, which is a reason to keep it and close its record gap
(§2.3), not to generalise it.

**the reference NVR has nothing comparable.** Its open `objectdetector` emits a
per-FRAME `ObjectsDetected { detections[] }` — three people are already one
payload with three entries — but there is no cross-frame aggregation, no event
unit, no group thumbnail. `@reference-nvr/nvr` is closed source. Grouping is left to
third-party notifiers, which implement a debounce (rate limit), not an
aggregate.

**The academic name is co-movement pattern mining**, and the taxonomy is worth
knowing because it names our §3 choice precisely:

| pattern | definition |
| --- | --- |
| **flock** | same object set inside a disc of radius *r* for *k* consecutive steps |
| **convoy** | ≥ m objects density-connected (DBSCAN, eps) for *k* **consecutive** steps |
| **swarm** | the same, but the *k* steps need not be contiguous — tolerates occlusion and dropout |
| **moving cluster** | per-step clusters linked by membership overlap ratio θ |

Our cohort (§3, Question B) is a **convoy**; the occlusion tolerance a real
camera needs makes it a **swarm** in practice. The cheapest meaningful
implementation is **DBSCAN over (position, velocity) per frame plus temporal
membership linking** — 4-D so that two people standing close but walking
opposite ways separate, which is exactly the 26% of pairs §1.3 measured. With
n ≈ 1–10 concurrent tracks the cost is nil. Trajectory-distance clustering
(Hausdorff / Fréchet / DTW) is O(n²·L) and needs finished tracks — fine as an
offline pass at group close, overkill online. GNN/LSTM approaches are not worth
it on this hardware, and the papers proposing them use DBSCAN as their own first
stage.

---

## 4. The options

### Option A — a post-hoc `groupId` in post-analysis

Cluster concurrent tracks (burst and/or cohort per §3) and stamp a `groupId`.
Tracks stay individual; the group is an attribute of the relation, not of the
subject. The tracker is untouched.

**Where it lives.** Two sub-choices, and they are not equivalent:

| | `groupId` column on `tracks` | a `pipeline-analytics:track-groups` table |
| --- | --- | --- |
| write cost | one column, one index | a table + membership rows |
| "who is in group G" | index scan on the tracks table | direct |
| group-level facts (representative frame, member count, the chosen anchor) | nowhere — must be recomputed on every read | a row |
| a member leaving the group | rewrite the track row | rewrite one membership row |
| retention | rides the track's cascade for free ([D61](../decisions/adr-0061.md)) | needs a rule; a group whose last track was pruned must go |

The table is the right shape as soon as the group has any fact of its own — and
it does, immediately: the representative frame and the anchor track. A bare
`groupId` column forces every consumer to re-derive "which member's key frame is
the group's picture", which is precisely the kind of re-derivation that put two
incomparable feature spaces in one CLIP index ([D52](../decisions/adr-0052.md)).
**Recommendation: the table, with `groupId` denormalised onto the track row for
the list queries that already page over `tracks`.**

**When it is decided.** Three candidate moments:

1. *At the second track's birth* — earliest, but a group formed on 2 frames of
   overlap is a guess, and half of those pairs turn out to be crossings (§1.3).
2. *On a short debounce after the first track's birth* — the useful one. The
   in-flight `waitForEnhance` work measured face confirmation at **p50 11.4 s**
   after first sighting; a 10–15 s group window lands in the same place, so a
   group notification can carry names.
3. *At group close* — most accurate, latest. Correct for the timeline and the
   events feed; too late for a security notification.

They are not exclusive: the group can be OPENED on a debounce (which is what a
notification fires on) and SEALED at close (which is what the timeline reads).
That mirrors how a track already works — it exists live and is finalised at
close.

**Updating a membership.** A person peeling off the group is the case that
makes a naive implementation wrong. Two honest policies:

- **Sealed-at-open (recommended).** Membership is decided once, at the debounce,
  and never revised. A subject that leaves was in the group at the moment the
  group was announced, and the announcement is a historical fact. Simple, and it
  can never retroactively contradict a notification that already went out.
- **Live.** Membership is re-evaluated per frame; a leaver is removed. This
  requires the group to have a "was announced as N, ended as M" record or the
  notification becomes a lie. Not worth it for v1.

**Cost.** Moderate. New table + cap methods + a clusterer + a group-close hook.
Roughly: clusterer ~150 lines with tests, store ~200, cap surface ~80, wiring
into `FrameProcessor`'s close path ~50.

**Pro:** the group becomes a real entity, so the events feed, the timeline, the
notification and a future "show me the group" all read the same thing. It is
computable retroactively over stored tracks, so it can be validated against
history before it ever fires a notification.
**Contro:** it is the largest of the three. It also introduces the first entity
in the system whose retention is not a track's, which needs a deliberate answer
(a group is deleted when its last member is).

### Option B — merge at the notification layer only

No schema change. The NC collects concurrent qualifying subjects on a camera in
a short window and enqueues ONE row naming all of them.

This is the cheapest thing that fixes the stated complaint, and — critically —
**it is the only option that also fixes the information loss in §1.5**, because
the merge replaces the discard.

Mechanically it is a small delta on machinery that already exists:

- The evaluation chain is already serialized (`evalChain`), so a per-(rule,
  device) pending buffer needs no locking.
- The barrier pattern is already implemented in `summary-collector.ts`.
- The multi-subject sentence already exists (`ncDetectionSummary`) with shipped
  plurals; what is missing is one line — `ncSubjectText` pins `count = 1`
  (`text-compose.ts:75`) — and adding `detectionTemplateVars` to
  `buildTemplateVars` (`dispatcher.ts:1591`), which the timelapse path already
  passes.
- The frame is already a clean full frame under `frame: 'full'` (§2.5); boxes
  come from `drawBoxedFrame`, which is already N-box.

Two variants, and the second is materially better:

**B1 — debounce.** Hold the first matching subject for a window, collect, then
enqueue once. Simple, but it delays the first alert by the window. On a security
rule that is a real cost, and it forces the feature to be an opt-in nobody turns
on for the rules that matter most.

**B2 — fire at open, update as the set grows** (the reference detector's shipped behaviour,
§3 Question C). Enqueue immediately on the first matching subject, exactly as
today — **zero added latency**. While the group stays open, re-enqueue an
UPDATED row when the subject set GROWS (and only then), replacing the previous
one. Close on an idle cutoff.

B2 is the recommended variant, for four reasons:
- **No latency regression**, so it can be the default rather than an opt-in
  nobody enables on the intrusion rules.
- The re-push already has a delivery mechanism: `dispatcher.ts:995` sets
  `tag: entry.ruleId`, which is the client-side coalescing key — an updated push
  with the same tag REPLACES the previous one on the phone rather than stacking.
- The suppression rule is trivial and already proven: re-fire only when the set
  grew. A group of 1 that stays 1 fires exactly once, which is today's behaviour
  byte for byte.
- The outbox is durable and idempotent on `${ruleId}:${dedupRef}:${targetId}`;
  an update needs a `dedupRef` that carries the revision (`<groupKey>:v2`), for
  which the `<trackId>:enhanced` escape is an existing precedent.

The cooldown then applies to GROUPS, not subjects, which is what it was always
meant to be: *"do not tell me about this camera more than once a minute"*.

**Pro:** small, reversible, no new entity, no migration, and under B2 no latency
cost. Delivers the operator's "one notification, one frame with all the boxes"
almost entirely, and converts the measured 37.9% silent discard into a merge.
**Contro:** the group does not exist. The events feed and the timeline still
show 7 cards. A group that is only a message cannot be clicked, searched or
counted. Under B2 the operator's phone shows a notification whose text CHANGES —
which is right, but is a behaviour they should be told about rather than
discover.

**Cost.** Small: a `NcGroupBuffer` (~150 lines with the update rule), the text
wiring (~20), the multi-box media resolution (~80), the rule field + editor
(~60).

### Option C — composite classes at the tracker

Fuse cross-class pairs with high IoU and coherent motion into one composite
subject with something like `composedOf: ['vehicle', 'person']`.

**This is already the shipped design for the only case that needs it** — D34's
rider fold — and the measurements say no second case exists on this fleet
(§1.4: zero person+vehicle cohort pairs; the abundant cross-class case is
person+animal, which must NOT be fused because a dog and its owner are two
subjects the operator wants counted as two).

Extending it further is where it gets dangerous. The named risk — a person
dismounting — is real and the current design handles it by construction: the
fold is per-FRAME, so the frame the rider steps off, the person detection stops
overlapping and simply becomes its own track. A composite TRACK would have to
split, and splitting a track is the one operation this codebase has no
vocabulary for.

**Pro:** for the rider case, it is already done and it is the right shape.
**Contro:** as a general mechanism it is the worst of the three — it destroys
subjects before the tracker, which makes the loss unrecoverable and invisible to
occupancy, the timeline and retrain alike. **Recommendation: do not generalise
it.** Close the D34 record gap instead (§2.3): keep the fold, and record the
folded person as a composition on the surviving subject so `vehicle + person` is
readable rather than merely logged.

### Option D — A for the entity, B for the delivery

The combination, which is what §7 recommends: B ships first and standalone
(it needs nothing from A), A follows and the group notification is then keyed on
a real `groupId` rather than a private buffer, and C stays as it is with its
record gap closed.

The important property of this ordering is that **B is not throwaway work**. The
buffer B needs (collect concurrent qualifying subjects per rule+device, seal on
a barrier) is the same clustering A needs, one level up. When A lands, B's buffer
is replaced by a `groupId` lookup and everything downstream — the text, the
frame, the outbox row — is unchanged.

---

## 5. The representative frame

The operator asked for "one frame that represents them all, with multiple
bounding boxes or a crop that covers them". Both are producible from stored data
with no new capture path (§1.6). The recipe:

1. **Choose the instant.** The peak of co-presence over the group's span —
   argmax over 500 ms buckets of the number of members with a position within
   ±1 s. Measured on the real cluster: 3 of 7 at 09:15:03.5.
2. **Choose the base pixels.** The member `keyFrame` (clean, native, full frame)
   whose timestamp is nearest that instant. In the measured case: 500 ms away.
   Fall back to `keyFrameSmall`, then `snapshot`, then `firstFrame` — all of
   which are full frames. If no member has any full frame within a tolerance
   (say 2 s), **do not fabricate one**: degrade to the anchor's own picture and
   say so in the group record. `recorded-still.ts` could re-decode the exact
   frame from the recording, but it is forbidden on the delivery path by
   `scripts/check-recorded-still-off-delivery-path.ts` — it belongs to a later,
   off-path enrichment, not to v1.
3. **Resolve each member's box at that instant** from `positions[]`
   (`{x, y, timestamp, bbox}`), nearest sample within the tolerance. A member
   with no sample in range is **not drawn and not counted in the picture** —
   though it stays in the group. Silence about a subject is better than a box in
   the wrong place; the overlay builder already takes exactly this position
   (`OVERLAY_DETAIL_FRESHNESS_MS`: a stale detail is dropped, never re-projected).
4. **Scale and draw.** `scaleBox` maps ≤640 detection-frame pixels onto the
   native surface (`event-media-dispatcher.ts:244`); `drawBoxedFrame` takes the
   array. Per-box `label` gives each member its own caption — `Person A`,
   `Person B`, `persona` — which is a strictly better picture than any single
   crop.
5. **The union crop is a variant, not an alternative.** The bbox union of the
   members plus padding, cut from the same base frame. Useful when the group
   occupies a small part of a wide scene; useless when they are spread out
   (it degenerates to the full frame). Offer it as the same `mediaFrame` axis
   that already exists (`cropped | full | boxed`), and it is the natural
   occasion to make `'boxed'` mean something again (§2.5).

Three constraints, each from an existing record:

- **A boxed frame is never training material and never a re-embedding source.**
  `retrain-frame-selection.ts` and the mosaic renderer both say so. The group
  frame is a DELIVERY artifact. It must be produced at delivery, published to the
  artifact plane (`artifact-store.ts`, bounded scratch), and must never be
  written into the media store as a track-owned kind.
- **It must not sit on the delivery critical path.** Its inputs are already
  stored, so it is a sharp composite over bytes already in hand — but the
  `waitForStill` behaviour (`dispatcher.ts:437`: track media lands 1.5–5.5 s
  after the trigger) already exists and the group frame should ride it, not
  invent a second wait.
- **Rendering is at SEND, not enqueue.** Text is frozen at enqueue by design;
  media is re-resolved at send by design. The group frame is media.

---

## 6. The operator's question: "a track has one type — can we add an attribute?"

Directly: **not as a fourth class attribute.** A track already carries three
class-ish axes (§2.2) plus the two declared label tiers, and [D89](../decisions/adr-0089.md)
plus `packages/addon-pipeline/src/__tests__/guards/label-tier-declared.guard.ts` exist specifically to stop a fifth
appearing. A `secondaryClass` would be a second source of truth about "what is
this", and CLAUDE.md's own list of things this repo has already shipped twice
includes exactly that shape.

The reason it is the wrong shape is not pedantry. **A group and a composition
are relations between entities, not properties of one.** "These three people are
together" is not a fact about any one of them; "this vehicle contains a person"
is not a class. Attributes cannot express either without lying about
cardinality — three group members would need three attributes agreeing with each
other, which is the disagreement failure D62 names.

The vocabulary the repo already has for relations:

| relation | existing mechanism | state |
| --- | --- | --- |
| detail → subject (face on a person) | `ObjectDetection.parentId` | live |
| co-occurring subjects in one frame | `ObjectEvent.frameId` | stamped, **never persisted** (finding 2) |
| rider → machine | `pairRiders` + `lastRiderPairs` | live, but the person is not on the record (§2.3) |
| track → group | — | **the gap** |

So the answer to give the operator is: yes, a group can be added — as a
`groupId` and a group entity (Option A), which is a relation; and the composition
case (bicycle) is best expressed the same way, as *"this subject contains a
folded person"*, rather than as a class that is two classes at once.

There is one small place where an attribute IS right, and it is the D34 gap:
recording on the surviving vehicle subject that a person was folded into it.
That is a property of one entity (it says something about this subject's
composition), it has cardinality 1, and it makes the record honest. It should be
named for what it is — a composition note with the scores that produced it — and
it must never be offered as a label (tier 1 or 2 would both refuse a macro token
anyway, correctly).

---

## 7. Impacts

| area | impact | rule |
| --- | --- | --- |
| **notification text** | `ncDetectionSummary` already renders *"3 persone e 1 animale"* [3 people and 1 animal]. With identities: *"Person A, Person B e 1 altra persona"* [Person A, Person B and 1 other person] needs a new composer, and a naming policy (how many names before "and N others"). | The class plurals already ship. Do not add a second sentence builder beside `ncDetectionSummary`. |
| **notification count** | Drops. On the measured 101 rule: 74 → an estimated ~50, while covering 116 tracks instead of 74. Both numbers move the right way. | Measure it against the same 6-day window before and after. |
| **security latency** | **None** under the recommended B2 (fire at open, update as the set grows). A debounce variant (B1) would add 10–15 s and would then have to be an opt-in that stays off for the intrusion rules. | `runRuleActions` fires **before** the cooldown today precisely because actuation must not be throttled; it must not be grouped or debounced either. `alarm-triggered` never groups. |
| **viewer / timeline** | Unchanged under B; under A the events feed can collapse a group to one card. `KeyEvent` would need a `groupId` + member count. | One row per track stays the underlying truth. A group card EXPANDS to its members; it never replaces them. |
| **occupancy** | **No change.** `recordFrame` counts per tracked detection; 3 people are 3. | A group must never be counted as one subject. Guard it with a test. |
| **retrain / galleries / CLIP** | **No change.** A group owns no pixels; every vector still comes from a member's own clean `keyFrame`. | The group frame is boxed and is therefore permanently disqualified as model input. |
| **`waitForEnhance` / identities (in flight)** | Strong interaction. That work makes a rule fire at track CLOSE to carry a confirmed name, measured p50 11.4 s. A group window of the same order is free to reuse the same barrier. A group where one member is recognised should say the name AND the count. | Do not build a second barrier. Reuse `summary-collector`'s track-close barrier and the deferral the NC already has (`ruleDefersToTrackEnd`). |
| **retention** | Under A, a group must not outlive its members. | [D61](../decisions/adr-0061.md): the track is the only entity whose AGE may select it for deletion. A group row is deleted when its last member is — via the cascade, never a fifth age sweep (`scripts/check-age-keyed-retention.ts` will fail the build if one appears). |
| **HA / Alexa / HomeKit exports** | A group event is a new event shape. | Out of scope for v1; export the anchor as today. |

---

## 8. Recommendation

**The 80% is Phase 0 + Phase 1. Everything after is a real entity, worth doing,
not urgent.**

### Phase 0 — fix the leftovers first (half a day, no design risk)

These are not preparation for grouping; they are bugs found while looking at it,
and each one currently reads as verification of a feature that is not there.

1. **Persist `frameId`.** Add the column to `OBJECT_COLUMNS`. The value is
   already stamped and already read back on the slim projection; only the column
   is missing. This alone makes "which detections shared a frame" answerable from
   SQL, retroactively for every row written after the deploy. Note the
   `ensureTable` fingerprint sequencing in
   [post-analysis.md](../architecture/post-analysis.md#the-4g-migration-and-the-order-it-must-run-in)
   — a new column arrives only when the fingerprint changes.
2. **Close the D34 record gap** (§2.3): put the folded person on the surviving
   subject's record, or amend D34 to say the person is logged and not recorded.
   A record that describes the right design and does not do it is the failure
   mode CLAUDE.md names first.
3. **Decide `mediaFrame: 'boxed'`** — either make it produce a boxed frame again
   or remove it from the schema. An authorable option that degrades silently to
   another option is a knob that decides nothing.

### Phase 1 — Option B2: fire at open, update as it grows (2–3 days)

An `NcGroupBuffer` on the serialized evaluation chain, per `(ruleId, deviceId)`:

- the first matching subject **enqueues immediately, exactly as today** — no
  added latency, so this can be the default rather than an opt-in;
- the group stays open while matching subjects keep arriving, and closes on an
  **idle cutoff** (`groupIdleSec`, default 30 — the reference detector's detection cutoff;
  `0` = off = today's behaviour byte for byte);
- a subject joining an open group re-enqueues an UPDATED row naming all members
  — and **only when the member set grew**, so a lone subject fires once;
- the cooldown moves to the group: it is a volume budget over groups, which is
  what it always meant;
- `runRuleActions` is untouched — it already fires on the first matching subject
  before the cooldown, and it must keep doing so;
- `dedupRef` becomes `<groupKey>:v<n>`, following the existing
  `<trackId>:enhanced` escape;
- text: unpin `ncSubjectText`'s `count = 1` and wire `detectionTemplateVars`
  into `buildTemplateVars`, so `{{detectionSummary}}` and `{{count}}` work on a
  detection body;
- media: extend `boxedTimelineFrame` from `bbox: PixelBox` to
  `boxes: readonly PixelBox[]` (its only structural change) and resolve the
  member boxes per §5. The base frame follows the reference detector's monotonic rule — keep
  the member frame with the most simultaneous subjects seen so far.

**This is what to ship first**, because it is the whole of the operator's stated
pain, it is reversible, it needs no migration, it costs no latency, and it
converts a 37.9% silent discard into a merge.

### Phase 2 — Option A, the group entity (1–2 weeks)

`pipeline-analytics:track-groups` + a `groupId` on the track row; a clusterer
implementing BOTH criteria of §3 with the thresholds calibrated from §1.3
(`d ≤ 1.5`, `cos > 0.6`, burst slack 5 s) rather than guessed; sealed-at-open
membership; the group frame recipe of §5; group rows on `KeyEvent` so the
viewer can collapse. Phase 1's buffer is then keyed on `groupId` and deleted.

**Validate it offline before it fires anything.** The clusterer reads only
stored tracks, so it can be run over the last 30 days and its output compared
against the notification history by hand. This repo has twice had a test pass
because the fake supplied what production forgot to fetch; a clusterer whose
merges have never been looked at by a human is exactly that risk.

### Phase 3 — composition, if still wanted

The rider case extended to a general "this subject contains that one", covering
person+dog if the operator wants a dog and its owner as one entry rather than
two. Deliberately last: §1.4 says the person+animal cohort is common, and the
correct default for it is probably a COHORT (two subjects, one notification),
not a COMPOSITION (one subject).

---

## 9. Questions for the operator

Batched, with a recommendation for each. Answers to 1–4 are needed before
Phase 1 starts; 5–8 before Phase 2.

**1. Group scope — burst or cohort?** (§3)
A burst catches the whole arrival (7 of 7 measured) but can merge two unrelated
people who arrive seconds apart. A cohort catches only who is genuinely together
(3 of 7) and leaves the rest as separate notifications.
→ **Recommended: the BURST for notifications** — it is also what the reference detector ships,
with no spatial test at all — and the COHORT as the group ENTITY in Phase 2. If
a camera exists where unrelated people constantly arrive together, name it and
it gets `groupIdleSec: 0`.

**2. Is a notification whose text CHANGES acceptable?** (§4, Option B2)
The recommended design fires immediately with the first subject (no delay,
exactly as today), then REPLACES that notification on your phone as more people
join — *"Persona su Front door"* [Person at Entrance] becomes *"Person A, Person B e 1 altra persona su
Front door"* [Person A, Person B and 1 other person at Entrance]. The alternative is to wait ~12 s and send once, which delays every
intrusion alert by 12 s.
→ **Recommended: fire immediately and update.** It costs no latency, so it can
be on by default including for the intrusion rules, and it is what the reference detector does.
If you would rather never see a notification change under you, say so and we
ship the debounce variant as an opt-in instead — but then it should stay OFF for
`Intrusione — Notte` and `Intrusione — Fuori casa`.

**2b. How long should a group stay open?** (§3 Question C)
Closed by an idle cutoff, not a fixed window: the group ends N seconds after the
last person qualified. The reference detector uses 30 s for detections and 40 s for alerts. The
measured 7-person arrival spans 110 s with all internal gaps under 30 s, so 30 s
holds it as one group.
→ **Recommended: 30 s.**

**3. What should the message say?** (§7)
Options: *"3 persone su Front door"* [3 people at Entrance] · *"Person A, Person B e 1 altra persona"* [Person A, Person B and 1 other person] ·
*"Person A + 2"*. And with mixed classes: *"2 persone e 1 animale"* [2 people and 1 animal].
→ **Recommended: names when known, count for the rest** — *"Person A, Person B e
1 altra persona su Front door"* [Person A, Person B and 1 other person at Entrance] — capped at 2 names before "and N others". This is
the only variant that recovers the 7 identities the cooldown discarded.

**4. Boxes or a union crop for the group picture?** (§5)
Boxes on the full frame show where everyone is and can caption each person by
name. A union crop is tighter when the group is small in a wide scene.
→ **Recommended: boxes on the full frame, with per-box name captions.** The
notification already carries a clean full frame; this adds boxes to it. The union
crop can come later as a `mediaFrame` variant.

**5. Does a group get its own timeline card?** (§7)
One card that expands to its members, or 7 cards as today with a group badge.
→ **Recommended: one card, expandable.** Never a card that replaces its members —
the per-subject tracks are the record and stay clickable.

**6. Is membership sealed at announce, or live?** (§4, Option A)
If someone leaves, does the group shrink?
→ **Recommended: sealed.** "3 people arrived together" stays true even if one
walks off, and a sealed group can never contradict a notification already sent.

**7. Occupancy — confirm it must not change.** (§7)
Three people in a group are three people in the zone; the *Person E is back*
occupancy rules must keep counting subjects, not groups.
→ **Recommended: confirm yes, and it gets a test.**

**8. Bicycle — is D34's current behaviour what you want?** (§2.3)
A cyclist is tracked once, as a VEHICLE, and today the person half exists only
in a log line. Options: leave it (and fix the record so it says "vehicle with a
rider"); or make it a group of two so a person-scoped rule can also see the
rider.
→ **Recommended: leave the fold, fix the record.** The fold is right — a rule
meant for "someone at the door" should not fire for someone cycling past — and
the record should stop claiming an entity it does not keep. If you want a
person-scoped rule to see cyclists, that is a rule condition
(`includesRider`), not a second track.

**9. Person + dog — one entry or two?** (§1.4, Phase 3)
The measured data says this is the most common cross-class pairing on the fleet.
→ **Recommended: one COHORT (one notification, two subjects, occupancy counts
both), not one composite subject.** A dog is not part of a person.
