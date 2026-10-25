---
id: D392
title: A device that says it is working is a motion source of its own — and it runs at its own rate
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/device-activity-source.ts
  - packages/addon-pipeline-orchestrator/src/device-detection-settings.ts
---

## Context

The operator's Dreame robot has a camera and its own AI, and the question was
how to make that camera useful to detection. The first answer, built and
rejected the same day, was to take the robot's **obstacle detections** — the
boxes it publishes on `10001.112` at ≈5 Hz while it streams — forward them on
`detection.camera-native`, and let them trigger motion.

It worked and it was wrong, for reasons a capture made concrete. 377 pushes in
70 s carrying ~3 boxes each is ~16 boxes a second from an obstacle-avoidance
model whose dominant class code (`164`, 86% of the traffic) is in no published
table and could not be named. Nothing downstream has a vocabulary for `shoes`
or `trash-can`; the bandwidth is real; and the robot is *itself* the thing
moving, so the boxes are mostly the floor going past. Forwarding them bought a
class nobody could use, at a rate nobody wanted, to say "the robot is moving" —
which the robot already says, plainly, elsewhere.

Because that is the real signal. The camera only exists while the robot works,
and the system already knows when it is working: `recording-signal`, the LEVEL a
provider raises while the device is doing its job, which the recorder already
records against ([D380](adr-0380-a-device-decided-recording-is-a-mode-with-no-schedule-and-a-provider-seeds-it-once.md)).

## Decision

**The device's own activity is a first-class motion SOURCE, not a disguised
onboard tick.** `MotionSourceEnum` gains `device-activity`, and the orchestrator
republishes the `recording-signal` level as `MotionOnMotionChanged` with that
source. It attaches **nothing** — no regions, no class: the only fact it carries
is that the device is active. It is a LEVEL, so unlike `onboard` it has a real
falling edge, and unlike `analyzer` it must never open the frame-diff
side-channel — the runner's gate stays `source === 'onboard'`.

Three properties follow, and each is the decision as much as the enum entry is:

1. **Its default is expressed per device, not per fleet.** A device whose driver
   registered `recording-signal` carries `device-activity` in its resolved
   `motionSources` default (`resolveDetectionSettings`, gated on
   `hasActivitySignal`), ADDED to whatever the rest of the ladder picked. An
   explicit operator list still wins in both directions, including an empty one.
2. **A level is sustained, never polled.** The level is mirrored in the
   orchestrator, refreshed off the event path and never read back from the
   device ([D224](adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)),
   and a sustain tick at half the camera's `motionCooldownMs` re-emits it while
   it is up. A forty-minute cleaning run cannot be expressed as an edge.
3. **The session runs at a rate the run's LENGTH justifies.** A session opened by
   `device-activity` is capped to `activityDetectionFps`
   (`detectionFpsForTrigger`, default **1 fps**); a session any other trigger
   opens keeps the camera's `detectionFps`.

## Consequences

- **The obstacle path is deleted, not disabled.** No subscription, no property
  fan-out, no decode table, and the robot's `videoObstacleSwitch` (28.13) is
  never written — that setting goes back to being the operator's alone.
- **The rate lever is scoped to the TRIGGER, and that was a choice between
  three.** A per-device `detectionFps` would also slow the sessions a real
  motion trigger opens on the same camera, and becomes silently wrong the day
  the device gains a second trigger. A per-SOURCE rate table would have to reach
  the runner and be re-applied whenever the source holding the session changes,
  which an attach-time config cannot express. Scoping it to what OPENED the
  session puts the number where its justification lives — and keeps the runner
  unaware: what reaches it is still a plain `detectionFps`.
- **The 1 fps default is arithmetic, not taste.** A whole-house run is ~2 400 s.
  At the 10 fps camera default that session asks for 24 000 inferences to find a
  cat that walks past once; at 1 fps it asks for 2 400, and a person crossing a
  room (2–4 s in frame) still gets 2–4 chances to be seen — enough for the
  tracker to confirm. Below 1 fps a crossing subject gets one frame or none,
  which the tracker discards, so the saving buys nothing.
- **It is a cap, not a set**: `min(detectionFps, activityDetectionFps)`, so
  lowering the camera rate still wins. And it applies to the session the level
  OPENS — a session already open at the camera rate is not re-attached to slow
  it down, because re-attaching a live session to change one number costs a
  decode restart.
- **`MotionSourceEnum` is a framework type, so this ships on a train.** An
  attach payload can now carry a value an older node's copy of the schema
  rejects — until every node runs a `@camstack/server` containing it, a session
  placed on a stale agent for a camera whose `motionSources` includes
  `device-activity` is refused at validation. The blast radius is bounded by the
  default: the source arrives only where `recording-signal` exists, which today
  is the robot. The rate knob is NOT on the train — `activityDetectionFps` is an
  orchestrator-owned device setting and what reaches a runner is a plain
  `detectionFps`, so an old runner honours the cap without knowing it exists.
- Two hand-copied duplicates of the source union (`PhaseTransitionPayload.source`,
  `DeviceProfileDefaults.motionSources`) now reference the enum. They had
  silently excluded every variant added after them, which is exactly what the
  enum's own "single source of truth" comment promised would not happen.

## Enforcement

`device-activity-source.spec.ts` holds the level/sustain/suppression contract;
`device-detection-settings.spec.ts` holds the default ladder (including that a
camera without the signal is untouched, and that an operator can remove it) and
the rate cap; `device-activity-motion.spec.ts` holds the runner's half —
reaches `reportMotion`, attaches no regions, and does **not** open the analyzer.
That last one was verified by widening the analyzer gate to include this source
and watching it go red. Nothing stops a future source from being added to
`MotionSourceEnum` without threading it through the four consumers the enum's
comment names — that remains review-only.

## Amendment, 2026-09-29 — the sustain interval is capped under the episode close (D672)

Item 2's "a sustain tick at half the camera's `motionCooldownMs`" is now
**capped**: `sustainIntervalMs(cooldown)` = `min(max(1 s, cooldown / 2),
MOTION_CLOSE_AFTER_MS / 2)`, 7.5 s at the default 30 s cooldown. At the default
the uncapped interval (15 s) EQUALLED the D475 episode row's 15 s quiet timer,
so whether a sustained level kept one `(device, source)` row or opened a new one
per tick was a race between the orchestrator's interval and post-analysis's
timer; above a 30 s cooldown it opened a new row per tick. The helper is shared
with the camera-sensors bridge
([D672](adr-0672-an-attached-sensor-is-part-of-the-cameras-onboard-motion-and-the-first-trigger-is-recorded.md)),
so a device-activity run is now ONE episode row. Cost: one extra bus event per
7.5 s per active device; sessions are unaffected, since a tick only re-arms the
cooldown. Enforced by `device-activity-source.spec.ts` (`always lands before a
D475 episode closes on its quiet timer (D672)`), which sweeps every cooldown in
0…60 000 ms.

The same D672 work also fixed item 3 in production: the bootstrap had dropped
the trigger argument of `handleSessionMotion`, so `detectionFpsForTrigger` never
saw `device-activity` and every activity session ran at the camera rate. It now
receives it.
