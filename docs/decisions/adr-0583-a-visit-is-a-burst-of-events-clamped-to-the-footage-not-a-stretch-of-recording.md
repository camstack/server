---
id: D583
title: A visit is a burst of EVENTS clamped to the footage, not a stretch of recording
status: accepted
date: 2026-09-21
applies-to:
  - packages/addon-pipeline/src/recorder/addon/videoclip-visits.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - packages/addon-pipeline/src/recorder/addon/__tests__/clip-event-visits.spec.ts
last-verified: 2026-10-02
---

## Context

The operator, on the `analytics` source: *"Vedo solamente 2 eventi in una
intera giornata."*

Measured on 592, 24 h, 2026-09-21. Seven rows covering the **entire day**:

| window | length | events inside |
| --- | --- | --- |
| 00:00→07:58 | 7 h 58 m | 1 438 |
| 08:40→16:24 | 7 h 43 m | 1 199 |
| 16:26→18:59 | 2 h 33 m | 557 |
| 19:01→21:36 | 2 h 35 m | 423 |

About 3 800 events in seven rows. Not two events — seven blocks, each standing
for hundreds or thousands.

`listClips` computed the per-event clips (`eventsToClips`, pad −5 s/+10 s) and
then **threw them away** whenever availability was readable, replacing them with
`clusterFootageVisits(ranges, VISIT_MERGE_GAP_MS)` — a clustering of RECORDING
COVERAGE.

`VISIT_MERGE_GAP_MS`'s own docblock states the assumption that makes that
sound:

> *"A videoclip is the events-mode keep-window (writer session), whose idle
> bound is `postBufferSec`. Using that default (30 s) glues those intra-visit
> holes without joining visits hours apart."*

True of an **events-mode** camera, where the writer opens and closes around
activity and availability is genuinely fragmented. 592 records **continuously**:
availability has no gaps at all, so the visit became the recording session, and
"without joining visits hours apart" was false by eight hours.

## Decision

**The visit is a burst of EVENTS. The footage clamps it; it does not define
it.**

`clusterEventVisits(events, ranges, gapMs, pad)`: cluster event timestamps at
`gapMs`, pad the burst by `EVENT_PAD_MS`, intersect with the availability
ranges, keep only the pieces actually covered.

### No new constant, and no duration cap

Measured on the same camera and the same day, clustering the EVENTS at the
existing 30 s:

- overnight 00:00→07:58, today one row → **46 visits** (120 object events,
  median spacing 15 s);
- daytime 08:40→16:24, today one row → **36 visits** (173 events), visit length
  **median 17 s**, p90 80 s, longest 99 s.

So the constant was right and its rationale is now true; only its input was
wrong. A maximum visit duration was considered and rejected: it splits by the
clock rather than by what happened.

**Corrected 2026-09-21, after deploying.** Those two figures were measured on
OBJECT events alone, and the clustering uses all three buckets. The live result
on the same camera and day is **693 rows** — 404 audio, 215 motion, 74 object —
median 15 s, p90 102 s. Two things the object-only sample hid:

- **349 of the 693 carry a single event**, most of them audio. That is close to
  the "one clip per motion heartbeat" the visit concept exists to avoid, on the
  audio channel rather than the motion one.
- **Eight rows still exceed ten minutes**, the longest 66 min holding 492
  events. Those are genuine unbroken bursts under the 30 s rule, so "nothing
  needs splitting that way" was an overclaim: a dense hour is one visit by the
  rule and is not a clip by any useful reading.

The fix stands — seven day-long blocks were unusable and these are not — but
the sentence above claimed more than the measurement supported.

## The grain is the PADDING, not a constant

> *"30 secondi e' troppo, possiamo completamente eliminarlo, il merge avviene
> quando post-event coincide con il pre del successivo"* [30 seconds is too much, we can eliminate it completely, the merge happens when post-event coincides with the pre of the next one] — the operator.

Two clips merge exactly when they would otherwise **overlap**: one's `postMs`
reaching the next one's `preMs`. So the threshold is `preMs + postMs` and there
is no separate constant on this path at all. It is derived, so a caller with a
wider pad gets a wider grain by construction and nothing can disagree with
anything.

`VISIT_MERGE_GAP_MS` (30 s) was arbitrary here and sat on a **cliff**. 592's
worst hour holds 492 events — 150 object, 98 motion, **244 audio** — whose
LARGEST gap is 25 s, so nothing ever reached 30 and the hour was one row. The
audio is what closed every gap: 150 object + 98 motion alone average one event
every 16 s, and the audio doubles the density.

Measured on that hour:

| rule | clips | median | longest |
| --- | --- | --- | --- |
| 30 s | **1** | 66 min | **66 min** |
| `preMs + postMs` (15 s) | **105** | 19 s | **3.5 min** |

`leftOverhangMs` is derived the same way (`preMs + postMs + preMs`): the
furthest event that can still join an in-window visit sits one grain before the
first in-window event, and its own padded window opens `preMs` before that.
Left on the constant it would have been a number nothing else consults — a
meaning that had quietly expired.

Two fixtures changed value, both toward the truth: a visit now ends where the
EVENT's window ends, where before it took all the footage it happened to span
because the 30 s constant had merged it with an event nine seconds away.

## A cooldown on the kinds that never stop

With the derived grain the day came back as **1 819 rows** on 592 — 1 090
audio, 551 motion, 178 object — and **1 180 of them carried a single event**.
Two thirds of the list was one audio blip at a time.

> *"teniamo gli audio come eventi, con un cooldown di 5 minuti tra uno e
> l'altro per evitare affollamento, gli audio sono costanti, esattamente come
> motion isolato (ma a 2 minuti)"* [we keep the audio as events, with a 5-minute cooldown between one and the next to avoid crowding, the audio is constant, exactly like isolated motion (but at 2 minutes)] — the operator.

`applyQuietKinds`: **audio 5 min, isolated motion 2 min, object never**. They
are KEPT rather than dropped — a camera that only ever hears something must not
go silent in the list — but a run of them yields one row per cooldown.

Three things that are the decision rather than the code:

- **Object needs no special case.** `dominantKind` already ranks object >
  motion > audio, so an audio blip coinciding with a detection is part of THAT
  visit and never a row of its own. The cooldown only ever sees the isolated
  ones.
- **Measured from the last EMITTED row**, not the last seen. From the last seen
  a constant stream emits once and never again — silence dressed as a filter.
- **Applied before the window filter and before the limit.** After paging,
  `limit` counts rows that then vanish: the page comes back short AND with the
  wrong rows, because this list is newest-first. Nothing pinned that ordering
  until the revert proof came back green and a test was written for it.

The constants live in the recorder addon, not `@camstack/types`: nothing else
reads them, and putting them in the framework would make a list-density tweak a
publish and three node updates.

### The footage still matters, in two ways

- **A visit keeps only the pieces it covers.** `stillInstantMs` takes the
  midpoint of the longest piece; handed the whole session's range it put the
  still 44 s from what the clip is about, measured in T11.
- **A burst with no footage behind it is dropped.** An event the recorder never
  kept is not a clip, and listing it is a row that opens onto nothing.

## Consequences

- **Footage with no events no longer produces a row.** A continuously-recorded
  camera with nothing happening shows an empty `analytics` list rather than
  hours-long blocks — the footage is reached through the timeline, which is
  what the timeline is. T8 was rewritten for this: its subject (a visit built
  from coverage alone) no longer exists, so it was given an event and still
  proves its actual claim, the left overhang.
- **The event-log-unreachable fallback is unchanged** and still clusters
  coverage. There, events are unknown rather than absent, and a visit from the
  footage is the only honest answer available.
- Three gates red on revert: the clamp to availability, dropping a burst with
  no footage, and the pad around the burst.
