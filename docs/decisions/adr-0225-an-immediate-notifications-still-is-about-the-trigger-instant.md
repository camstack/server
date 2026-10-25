---
id: D225
title: An `immediate` notification's still is about the TRIGGER INSTANT — the footage render never gets to choose it
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
---

## Context

The operator, on the same report that produced [D223](./adr-0223-a-notification-still-is-about-the-zone-that-fired-the-rule.md),
named the cause better than that record did: *"se una scena è settata su
immediate, dovrebbe inviare immediatamente la notifica al primo frame utile …
In caso un frame diverso sia selezionato, certamente si aspetta il primo frame
di quel tipo disponibile"* [if a scene is set to immediate, it should send the notification immediately at the first usable frame … if a different frame is selected, it of course waits for the first available frame of that kind].

He is right, and the defect is a SEQUENCING one. `resolveAttachments` resolved
the still once at the trigger and — when that found nothing, which is the normal
case, because track media lands 1.5–5.5 s later — re-read it only AFTER
`renderFootage`. That render blocks 7–8 s (a 6 s post-roll plus the cut). By
then the ladder is reading a track that has walked away, and its first rung is
the track's best shot, ranked for the gallery over the whole track
([D212](./adr-0212-a-best-shot-square-must-deliver-the-subject.md),
[D213](./adr-0213-a-best-shot-prefers-the-frame-that-proved-something.md)). The
slower attachment was choosing the faster one's content.

Measured (device 101, 'Persona su Uscio', 54 fires 18–21/08, delivered bytes read
back off the artefact shelf, each frame's instant read off the camera's burnt-in
clock):

| | value |
| --- | --- |
| age of the delivered frame vs the trigger | median **0.31 s**, p90 **2.32 s**, max **4.9 s** |
| delivered frames older than 2 s | **8 / 54** |
| delivered frames with ZERO overlap on the triggering zone | **9 / 54** |
| the reported fire (track d0f63887…) | **+4.87 s**, 0% in zone, doorstep empty |

And, decisively, what is actually AVAILABLE at the trigger:

| band around the trigger | any full-scene frame | of which the ladder's TOP rung |
| --- | --- | --- |
| ±1 s | 52/54 (96%) | 15/54 (28%) |
| ±2 s | **53/54 (98%)** | 25/54 (46%) |
| ±3 s | 53/54 (98%) | 36/54 (67%) |

So the trigger-instant frame is nearly always there — just usually **not** the
kind the ladder ranks first. Within ±2 s the best available rung was
`firstFrame` 23×, `keyFrame*` 25×, `lastFrame` 2×, `snapshot` 3×, nothing 1×.
The top rung is the NATIVE keyFrame, whose capture misses and retries (36 misses
over 105 track starts on 101 in 6 h; the reported track missed at +0 s and +3 s
and landed at +5 s). **Reading "wait for the first frame of the kind the rule
asked for" literally would wait for exactly the late frame.** The gate has to be
the frame's own instant; the ladder then runs among the frames that are about it.

## Decision

Two rules, for `delivery: 'immediate'` only — a `track-end` rule is legitimately
about the whole track, and a system event has no instant of its own to be near.

1. **The age gate.** A candidate still must satisfy
   `|file.timestamp − subject.timestamp| ≤ NC_TRIGGER_STILL_MAX_AGE_MS`. That
   constant is **derived from `TRAIL_MATCH_MAX_MS` (2 s), not repeated**: D223's
   zone filter runs on the same candidate list immediately after, and if the two
   disagreed a frame could be judged in-zone for a moment the age gate had ruled
   a different one. The bound is measured (98% coverage at ±2 s; widening to 5 s
   re-admits the frame that caused the report).
2. **The sequencing.** `renderFootage` is STARTED and awaited at the end, while
   the still resolves on its own bound and **freezes at the first frame that is
   about the trigger**. There is no post-render re-read. The poll asks each
   attempt for a trigger-instant frame and nothing else, so a poll that has not
   found one keeps waiting instead of settling for a later frame that happens to
   rank higher. Two media, two clocks; the slower never chooses for the faster.

When the bound expires with only later frames available, the give-up pass ships
the best of them — a real picture beats no picture — and REPORTS it:
`no still from the trigger instant — shipping a later frame`, with the frame's
offset, the bound and the wait, under `tags: { deviceId }`.

**The hierarchy, and D223's place in it:** MOMENT → PLACE → KIND. The age gate
runs first (is this frame about the thing I am telling you), then D223's zone
filter (is it about the right place), then the existing ladder (is it the kind
the rule asked for). D223 is not superseded: it is the second gate, and it is
the only gate for `track-end` rules and for the degrade path, where an
out-of-band frame ships and "which of these later frames" is still a real
question.

## Consequences

- Simulated over the same 54 fires (age gate → zone filter → ladder, using the
  final stored media set, which is conservative because the live poll freezes at
  the FIRST landing): delivered-frame age median **0.31 → 0.19 s**, p90
  **2.32 → 1.91 s**; frames older than 2 s **8 → 1**; zero-overlap frames
  **9 → 1**; notifications losing their picture **0**. The reported fire goes
  from **+4.87 s / 0% in zone** to **+0.13 s / 40.6% in zone**.
- The single remaining out-of-band case is a track whose stored media genuinely
  contains no frame from the trigger instant. It ships, and says so.
- `MediaFile.timestamp` is now LOAD-BEARING on this path. Every production
  writer already stamps a real instant (`stillShelfMedia(data, atMs)` uses the
  moment the trigger asked for, `deriveSyntheticMedia(…, now)` the injection
  instant), which is what makes the gate safe for audio, occupancy and injected
  rows. `dispatcher.spec.ts`'s fixture used `timestamp: 1` and had to be made
  honest — a field nothing read had drifted.
- The bounded wait now runs for EVERY rule, not only footage-free ones. It is
  concurrent with the render, so it adds no latency to a rule that wanted
  footage; a footage-free rule is unchanged.
- The `footage.attempted` branch is gone. D58's rule survives in the form that
  mattered — the poll gates on whether the media LANDED, never on how long we
  happened to take.
- **The poll waits for ABSENCE, not for improvement.** The first look asks for
  whatever exists (`any`, which already prefers an in-band frame and degrades
  only when there is none); the bound is spent only while NOTHING has landed.
  Asking `trigger-only` there cost a live alarm 3 s for nothing: device 107,
  22:26:34, a second scream inside `NC_STILL_SHELF_REUSE_MS` names a new owner
  id pointing at the FIRST scream's photograph ([D178](./adr-0178-an-absent-subject-is-photographed-once-by-one-shelf.md)),
  so its instant is 6.1 s before this trigger and no second capture was ever
  going to happen — the wait was pure latency on a notification about a crying
  child. Found by the live monitor, not by a test. Tracks are unaffected: at
  first look their media has not landed at all, which is the premise of the
  bounded wait.
- A still-shelf photograph can therefore ship as a REPORTED degrade with a
  negative offset. That is correct and not a fault: the shelf's stamp is the
  instant the shelf was asked to photograph, and D178 makes one photograph serve
  a burst.
- An AGED row (older than `NC_STILL_WAIT_MAX_AGE_MS` — a retry, a restart, an
  unreachable target) does not poll, but it must still RESOLVE. The moment the
  first look started asking for the trigger instant only, the old
  `return null` there became a regression: a retried row whose only frame is
  from later would have shipped text-only where it used to ship that frame.
  Found by re-reading the diff, not by a test — and then pinned by one.

## Enforcement

`dispatcher-trigger-instant-still.spec.ts`: the age gate on the live shape with
NO zone condition (which is why it, not D223, is the primary cure), the bound's
derivation, first-landing freeze against a 7 s render, the still giving up on
its own bound, the reported degrade, a `track-end` row left untouched, and the
moment-before-place ordering. Its clock is a virtual scheduler, not a counter —
a counter cannot express two concurrent sleepers, which is the whole subject.
Gate-removal run RED on 2026-08-21, twice: neutering `narrowToTriggerInstant`
fails 2 tests, restoring the post-render re-read fails 2 others.
