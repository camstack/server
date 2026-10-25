---
id: D306
title: A still gate DEFERS while a better frame can still land, and degrades only when it cannot — and the thing that decides is the RECORD
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/trigger-zone-still.ts
---

## Context

The 21/08 operator report — *"vedi l'ultima persona su uscio, lo snapshot è ben
lontano dalla zona di rilevamento"* [look at the last person at the doorway, the snapshot is far from the detection zone] — produced
[D223](./adr-0223-a-notification-still-is-about-the-zone-that-fired-the-rule.md)
(the still is about the PLACE) and
[D225](./adr-0225-an-immediate-notifications-still-is-about-the-trigger-instant.md)
(the still is about the MOMENT). Both shipped that evening. This record is the
nine-day audit of whether they hold, and they do not, on the same rule.

**Nothing is late.** 56 retained outbox rows for `db95e222` (device 101,
'Persona su Uscio'), 23–29/08, against D223's own 18–21/08 baseline:

| | 18/08 | 19/08 | 20/08 | 21/08 | **23–29/08 (post-fix)** |
| --- | --- | --- | --- | --- | --- |
| median trigger→enqueue | 16 ms | 17 ms | 39 ms | 20 ms | **110 ms** |
| median enqueue→sent | 7552 ms | 7474 ms | 10867 ms | 7777 ms | **9794 ms** |

Same order of magnitude on both legs. The pre-buffer suspicion the operator
raised was already refuted by D223 and is refuted again here: D192/D193 feed the
gif from the broker ring, and the still comes from `getMediaForOwner` on the
track, which never touches it.

**The picture is still wrong.** The delivered bytes for the 20 rows that carry a
still artefact were read back off the shelf and **sha256-matched to the track
media row that produced them**, so each delivered frame's instant is read from
the row rather than from the burnt-in clock. Two live failures, both after the
21/08 fixes:

- **Track `98184eb9`, 27/08 11:30:44** — delivered still is the `keyFrame` from
  **−5965 ms**: subject a speck up on the road, 0% inside Uscio, the Willkommen
  mat visibly empty (confirmed against the camera's own OSD — 11:29:34 on the
  delivered frame vs 11:29:40 on the same track's `firstFrame`, so the constant
  64 s hub↔camera drift cancels). `firstFrame` (+203 ms, **37.5%** inside),
  `snapshot` (+1550 ms, 48.4%) and `lastFrame` (+1906 ms, 39.1%) all landed
  inside the bound and all show three people on the doorstep.
- **Track `9f2659e6`, 29/08 12:10:20** — delivered still in band but out of
  PLACE: `keyFrame` at −1158 ms, 0% inside Uscio, while the `snapshot` at
  +670 ms (32.8% inside) landed 544 ms after the first look.

The cause is a two-hour-old regression on D225 itself. changed the
first look from `trigger-only` to `any` to stop an audio alarm spending 3 s
waiting for a still-shelf photograph that [D178](./adr-0178-an-absent-subject-is-photographed-once-by-one-shelf.md)
guarantees will never be retaken — correct for that row, and justified for every
other row by an **assumption rather than a check**: *"tracks are unaffected: at
first look their media has not landed at all"*.

On a doorstep camera that assumption is false, and predictably so. A person
walks up the drive before reaching the door, so by the instant the zone
condition fires the track is seconds old and **already carries its best shot** —
taken while the subject was nowhere near the zone. The first look finds it, both
gates degrade instead of emptying the pool, `firstLook !== null`, and the bound
is never spent. The symptom is the mirror of the original report (that one
shipped +4901 ms; this one ships −5965 ms) and identical to the operator: an
empty doorstep.

## Decision

One rule, applied to both gates: **an unsatisfied gate means "not yet" while a
better frame can still arrive, and "ship it and say so" only when it cannot.**

1. **The gates are strict under `trigger-only`.** `narrowToTriggerInstant`
   already emptied the pool there; `selectTriggerZoneCandidates` now takes
   `strict` and does the same, so a candidate list that is entirely out of PLACE
   defers to the poll instead of degrading on the spot. Under `any` — the
   give-up pass, and every caller that cannot wait — it degrades exactly as
   before: nobody qualifying returns the whole list, because a real picture
   beats no picture. The `ordered.length < 2` stand-down is lifted under
   `strict` only: with one candidate there is nothing to *choose*, but there is
   still something to *decide*.
2. **The first look asks `trigger-only` exactly when the record can still gain
   media**, `canStillGainMedia(entry)` — and the discriminator is the RECORD,
   not the frame and not the presence of a `trackId`. A live visual track
   (`object-event`) keeps writing media for as long as it is open: its first
   frame, its periodic snapshots and its last frame all land after the instant a
   zone condition fired. Everything else is photographed once — an
   `audio-event` / `audio-window` / `device-event` / `package-event` is served
   by the still shelf, and D178 makes one photograph serve a whole burst — and a
   `track-end` row is by definition past the last of them. `trackId` is the
   wrong test: D189 shapes the synthetic audio track like a regular one, so the
   scream row has one too.

The bound, the ladder, the hierarchy (MOMENT → PLACE → KIND) and the track's own
best shot are all untouched. This changes only *when the dispatcher is allowed to
stop looking*.

## Consequences

- Replayed over the 39 retained fires whose media catalogue and trail are both
  intact: deliveries that change **10**, |offset| median **589 → 428 ms**, p90
  **4084 → 3603 ms**, and deliveries showing the subject with ZERO overlap on
  Uscio **14 → 6**. The two hash-verified failures above both become the
  in-zone frame (`keyFrame@−5965`, 0% → `firstFrame@+203`, 37.5%; and
  `keyFrame@−1158`, 0% → `snapshot@+670`, 32.8%).
- A zone-conditioned rule whose in-zone frame never lands now spends up to
  `NC_STILL_WAIT_MS` (3 s) before shipping the out-of-zone one. That is the cost
  D225 already priced for tracks, it is bounded, it is concurrent with the
  footage render, and it applies to no other record kind.
- The deferral is REPORTED — `no still from the zone that fired the rule — still
  waiting`, at debug, with `tags: { deviceId }` and the count it rejected. A poll
  nobody can explain is worse than no poll.
- **A test passed here for the wrong reason and had to be made honest.**
  `dispatcher-trigger-instant-still.spec.ts`'s D178 case described a scream on
  device 107 in its comment while building the file's default `object-event`
  fixture; it went green under the permissive first look and would have gone
  green under any policy keyed on the record. It now builds the `audio-event` it
  claims to be, and it is the thing that pins the discriminator.
- The remaining zero-overlap deliveries (6 of 39 in the replay) are tracks whose
  stored media genuinely contains no in-zone frame at all. They ship and say so;
  narrowing further would need a frame nobody kept.

## Enforcement

`dispatcher-strict-while-waiting.spec.ts` replays both live tracks on their real
normalized trails and the real Uscio polygon: the out-of-band first look
(`98184eb9`), the in-band/out-of-place first look (`9f2659e6`), that the bound
expiring still SHIPS the out-of-zone frame, and that an `audio-event` shelf row
spends nothing — one `getMediaForOwner` read, zero elapsed. Gate-removal run RED
on 2026-08-30, twice: restoring the unconditional `'any'` first look fails 2
tests, and neutering `strict` in `selectTriggerZoneCandidates` fails 1.
