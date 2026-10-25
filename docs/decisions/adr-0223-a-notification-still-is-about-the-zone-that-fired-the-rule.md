---
id: D223
title: A notification's still is about the zone that FIRED the rule — the ladder is narrowed to the frames that show the subject there, never re-ranked
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/trigger-zone-still.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
---

## Context

Operator report, 21/08/2026: *"vedi l'ultima persona su uscio, lo snapshot è ben
lontano dalla zona di rilevamento, assicuriamoci che l'ultimo lavoro sul
prebuffer non abbia ritardato le notifiche"* [look at the last person at the doorway, the snapshot is far from the detection zone, let's make sure the latest prebuffer work did not delay the notifications].

The suspicion — a delay introduced by that day's work — was measured and
**rejected**. Rule `db95e222` (device 101, 'Persona su Uscio'), 60 outbox rows,
18–21/08:

| | 18/08 | 19/08 | 20/08 | 21/08 | the reported fire |
| --- | --- | --- | --- | --- | --- |
| median trigger→enqueue | 16 ms | 17 ms | 39 ms | 20 ms | **14 ms** |
| median enqueue→sent | 7552 ms | 7474 ms | 10867 ms | 7777 ms | **7739 ms** |

Nothing was late. D192/D193 (the broker pre-roll ring) is the source of the
gif/clip only — the still comes from `getMediaForOwner` on the track/event and
never touches the ring; D217 (minimum session open time) moves a session CLOSE,
and this notification shipped at trigger+7.7 s while the track was still open
(closed at +25 s).

What the operator was actually looking at was measured too. Every delivered
still is retained on the artefact shelf for 14 days, so the DELIVERED BYTES were
read back for all 54 fires that still had a track, and each one's instant was
read off the camera's own burnt-in clock — differenced against the same track's
`firstFrame` OSD, so camera-vs-hub drift cancels exactly. Then the subject's box
at that instant was tested against the real Uscio polygon:

- **9 of 54 (17%)** delivered a picture whose subject box had **zero** overlap
  with Uscio — the zone whose condition fired the rule. Per day: 5/28, 1/11,
  0/8, 3/7. It is not new (18/08 predates every change suspected here) and the
  small daily counts do not separate the days.
- The reported fire is the extreme: the trigger frame had the subject on the
  doorstep at **40.6%** Uscio overlap; the delivered frame was **+4.9 s**, the
  subject **144 px** (22% of a 640-wide detection frame) outside the zone, the
  doorstep visibly empty, and a dog and a second person in shot.

The mechanism: for `frame:'full'` the ladder's first rung on a track owner is
`keyFrame` — the TRACK's best shot. That is a whole-track quantity ranked for
the gallery (D212 square containment, D213 semantic promotion) and it is
routinely a later frame; on this track the native key-frame capture missed twice
(`keyFrame native miss — RAM tier rejected`, then `no upscale, will retry`) and
the retry landed on whatever was on screen 5 s later. The ladder has no opinion
about WHERE the subject was, so a rule that fired on one polygon attached a
picture chosen without reference to it.

## Decision

> **Amended the same day by [D225](./adr-0225-an-immediate-notifications-still-is-about-the-trigger-instant.md).**
> The operator named a better primary cause: for `delivery: 'immediate'` the
> still was being re-resolved AFTER the 7–8 s footage render, so the ladder was
> reading a track that had walked away. D225 gates on the frame's own INSTANT
> and removes that re-read. This filter is the SECOND gate — moment, then place,
> then kind — and remains the only one for `track-end` rules and for D225's
> degrade path. The two bounds are derived from one constant on purpose.

A row whose rule carried a zone condition freezes those ids as
`NcOutboxPayload.triggerZoneIds` at enqueue — separately from `mediaZoneIds`,
which means "cut the picture down to this zone" and only exists when `zoneCrop`
was asked for. At dispatch the still ladder is **narrowed** to the candidates
whose subject box, at that candidate's own instant, overlaps one of those zones.
It is a FILTER and never a re-rank: the existing preference keeps deciding which
KIND of picture a rule gets, among the frames that are about the right thing.
The subject's position comes from the track's own trail, delivered NORMALIZED so
the dispatcher never learns a frame's dimensions, and a candidate whose instant
sits more than `TRAIL_MATCH_MAX_MS` (2 s) from every trail point is unanswerable
— never qualifying, never disqualifying the others. Every unanswerable case
returns the list untouched: no frozen zones, no track, no dep, no polygon, an
empty trail, a throw, unknown frame dims — and when nothing qualifies, all
candidates come back, because a real picture beats no picture (D212's rule for
the best shot, kept here). A narrowing is REPORTED with `tags: { deviceId }`,
naming what would have shipped and what ships instead, with both offsets from
the trigger.

**The track's own best shot is NOT touched.** It answers "which frame of this
track is the best likeness" and D212/D213 tuned it for that; the notification
asks the narrower "which frame is about the thing I am telling you" and is
allowed a different answer. The event detail and the notification may therefore
show different frames of the same track, on purpose.

## Consequences

- The notification's still and the track's best shot can now disagree. That is
  the point, and the log line is what makes the disagreement explicable.
- The ladder is flattened before filtering (every file whose kind the preference
  names, in preference order, store order within a kind). With no trigger zones
  the head of that list is exactly what `files.find` on the first rung picked,
  so those rows resolve byte-for-byte as before.
- A rule can now ship a lower ladder rung — a `frame:'full'` request can degrade
  from the clean `keyFrame` to the boxed `snapshot` when only the latter shows
  the subject in the zone. That degrade already existed as the ladder's tail; it
  can now be reached for a reason other than absence.
- An unknown-dims device gets no narrowing at all, silently by design: dims we
  do not have would make the overlap a guess, and a guess here drops the RIGHT
  frame.
- `bboxPolygonOverlap` is used verbatim as the one overlap derivation — the
  normalized box and the normalized polygon share a space, so the sampler needs
  no dimensions.

## Enforcement

`trigger-zone-still.spec.ts` pins the filter on the real d0f63887… geometry (the
40.6% doorstep frame against the 0% driveway frame), order preservation, the
trail-gap bound, and all four stand-down branches.
`dispatcher-trigger-zone-still.spec.ts` replays the live outbox row end to end:
the substitution, its log line with both offsets, and that a row without
`triggerZoneIds`, without polygons, without a trail, or whose trail read throws
resolves exactly as before. Gate-removal was run RED on 2026-08-21 — forcing
`selectTriggerZoneCandidates` to return every candidate fails 4 tests.
