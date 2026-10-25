---
id: D907
title: A camera is blind only when it MOVED and the detector produced nothing; constant motion with no subject is its own paired event
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/detection-blind-monitor.ts
  - packages/addon-pipeline-orchestrator/src/detection-session-registry.ts
  - packages/types/src/notification/system-event-classes.ts
---

## Context

D906 made `detection-blind` a state whose recovery is a detection. The condition
that opened it was wall-clock: frames still arriving AND no detection for 60
minutes. Over three days that raised 122 alerts on 18 cameras, none of them
blindness. Every alerting camera is session-dispatched on onboard motion, so
frames exist only while something moved:

- 44 were a QUIET camera (109: 72 minutes idle, then one 16 s session, alert);
- 37 were motion that never stopped (637: 89-102 sessions an hour, 1900-2300 s
  open an hour, zero detections);
- 41 were motion where the detector produced candidates and the confidence
  floor discarded them (in 115 of 122 windows below-floor candidates existed).

The condition counted hours when it should have counted motion, and it ignored
the one proof the detector is alive: a below-floor candidate (`frame.discarded`,
already at the tap).

## Decision

1. **Count MOTION time.** The monitor accumulates session-open milliseconds and
   the session count since the detector's last RAW OUTPUT (a detection or a
   below-floor candidate), fed in-process by the session registry's open/close
   edges. An in-memory mirror, no read on the event path, no second store (D49).
2. **`detection-blind` fires only when** that motion is at least 10 minutes AND
   over at least 3 sessions AND a fresh frame was analysed AND no frame carried
   a detection or a discarded candidate. A below-floor candidate means the
   detector saw something: tuning, not blindness, carried in the payload
   (`belowFloor`). A camera that never opened a session has no known motion
   source: nothing is classified (D393) — a standing camera is therefore not
   judged by this monitor. Recovery stays a detection.
3. **`motion-noisy` / `motion-calm` is a new paired class** (D906 pairing). Over
   a rolling hour with zero detections, motion duty of 25% or more, or 40 or
   more sessions, raises `motion-noisy`; it closes with `motion-calm` when both
   figures fall to 80% of the bar (no flapping on the edge) or a detection
   arrives. The body points at the motion zones and sensitivity. It is never
   emitted as `detection-blind`.

## Consequences

- Quiet cameras stop alerting; a below-floor-only camera stops alerting; a
  constantly moving camera is told once, and told when it calms.
- The instant-rule editor offers one new class (`motion-noise`). The state
  summary has no source for it yet (`snapshotSection: null`): the ledger holds
  `detection-blind` only.
- The viewer's rule editor lists edges until its next OTA; the hub widens a
  one-edge rule on save (D906).
- A hub still running the old orchestrator emits the old payload (no motion
  fields); the intake falls back to the wall minutes it carried.

## Enforcement

`detection-blind-monitor.spec.ts`: the 586 trace (idle then one 16 s session is
silent), the 637 trace (noisy, never blind), blind on 10 minutes over 3 empty
sessions, and not blind once a discard is present. Removing the motion gate
fails the 586 spec.
