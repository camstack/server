---
id: D426
title: A refused detection is observed, never alerted on
status: accepted
date: 2026-09-10
supersedes: D419
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/zone-refusal-is-observed-never-notified.spec.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
last-verified: 2026-10-02
---

## Context

On 2026-09-09 an operator reported a dog that walked into the "Aiuola" zone on
camera 101 and produced no notification, while another system announced it. The
detection existed — 0.7729, 100% of its box inside the polygon — but the tracker
refused the spawn (`threshold=3 measured=1`), and an `ObjectEvent` is only built
for a detection that has a `trackId`. The conclusion drawn was that a
zone-scoped immediate rule asks "is there an animal in the flowerbed NOW?", a
question that does not need "is this the same subject as before?" answered
first. So a refused detection inside a watched zone began emitting its own
event, carrying the overlap percentage and the refusal reason.

Ten hours of production said that was wrong, in three independent ways.

**The population is stationary junk.** 1511 such events on camera 101, of which
**1473 were `className=package`** — a single parcel sitting inside "Uscio" at
100% overlap, re-offered on every analysed frame. On 102 the same shape was a
parked car under `stationary-hold`, peaking at **19 events/second**, 404 in one
hour. A refused box is refused on every frame of a passage, so a subject that
never leaves is an unbounded emitter with no cooldown.

**Both alerts it ever raised were false.** Exactly two events reached a rule
("Animale su Aiuola", 22:53:28 and 07:10:24). The operator confirmed there was
no animal in either. The confirmation gate had refused them *because* they were
phantoms — the same guard that correctly rejected eight non-existent `vehicle`
boxes on this camera. This path overrode a correct judgement.

**They could not even be stored.** `object-events.trackId` is `notNull: true`.
Every insert failed — 589 in ten hours — and `insertObject` swallows the failure
with a warn and no rethrow, so `Promise.all` resolved clean and
`onObjectEventPersisted` then fired on a row that did not exist. Both
notifications shipped text-only (`dropped=["still"]`): there was no record and
no media to attach. The one use case the feature existed for arrived blind.

The test that was supposed to protect this asserted `trackId` is `undefined`
(the property that *caused* the failure) and never constructed an `EventStore`.
It was green throughout.

And the miss that motivated the work was never of this kind. The cat of
2026-09-10 05:55:45 was **not** refused: it was confirmed (`native-pass`,
0.8285), tracked, and stamped in "Uscio" at 100%. It went unannounced because
the operator has a rule for animals in *Aiuola* and one for persons on *Uscio*,
and none for an animal on the doorstep — `rejectedBy=["Animale su
Aiuola:zones","Persona su Uscio:classes"]`. No amount of emitting refusals would
have reached it.

## Decision

**The confirmation gate's verdict is final for ALERTING.** A detection the
tracker refused never becomes an `ObjectEvent`, so nothing downstream can raise
an alert on it — not because a rule declines to match, but because there is no
event for a rule to see.

A refusal that falls inside a watched zone is **diagnostic evidence** and goes
to an observer the addon logs (`detection refused inside a watched zone — not
notified`), carrying the class, the zones with their overlap percentages, and
the refusal reason. That is the channel for answering "is there a class of
refusal we are wrong to discard?" with numbers instead of a guess.

Identical refusals are collapsed for `ZONE_REFUSAL_THROTTLE_MS`, keyed on
(class, reason, zones, coarse box): a stationary subject is refused on every
frame, and an unthrottled diagnostic line is the same storm written to a
different file. The counter behind `zoneRefusalEventsEmitted()` counts every
refusal **before** the collapse — a volume measure that describes what happened,
not what survived the throttle.

## Consequences

- The 589 failed inserts, the 19-events/second storm and the phantom
  notifications all end at once: none of these events exist any more.
- A genuinely missed subject is now *visible in the log* and *silent on the
  phone*. Recovering one deliberately is a separate, evidence-led change — it
  will need corroboration (persistence across frames, exclusion of stationary
  subjects, a score floor), not "refused inside a zone ⇒ notify".
- The operator's real gap on 101 is a rule that does not exist ("animal on
  Uscio"), which is configuration, not code.
- `zoneRefusalEventsEmitted()` still has no reader. It is now the honest
  denominator for that future decision, and wiring a reader is the next step if
  the question is asked again.
