---
id: D217
title: A detection session has a MINIMUM open time — an early close is deferred to the floor, never a fourth authority over the cooldown
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/dispatch-reconcile.ts
---

## Context

An operator reported the cluster placement column "blinking every 2-3 seconds on
the same camera, with the same node". The first hypothesis — the balancer
oscillating between nodes — was measured and rejected as the cause of THIS
report: the node was stable across the blinks.

The real number, from 25.6 minutes of live orchestrator logs (817 sessions,
2026-08-21):

| | |
| --- | --- |
| median session duration | **4.0 s** |
| sessions under 5 s | **57.6%** |
| sessions under 10 s | 85.4% |
| closes by `motion_cleared` | **820** |
| closes by `cooldown_expired` | **2** |
| camera 104 (hall) | **249 sessions in 25 min**, median 2.4 s |
| cluster dispatch rate | 31.9 sessions/min |

`decideSessionAction` returns `'teardown'` on a hub `detected:false`, and
`handleSessionMotion` closed the session that instant — cancelling the fallback
timer and skipping the track hold, by design ("an explicit hub `false` never
consults this hold"). With a VMD that flaps on a busy scene, that design meant
`motionCooldownMs` (30 s default), the non-stationary-track session-hold and
`maxSessionHoldMs` between them decided **2 of 822 closes**. Three
operator-visible knobs that, on the cameras that matter, governed nothing.

Every close drops the camera's assignment record and every reopen re-runs the
node election and a full `detachOn`/`attachOn` round trip. So the cost was not
only the flicker: it was ~32 detach+attach pairs per minute across the cluster
for scenes that had not changed, plus the model-pool churn and the media of one
camera scattered across nodes.

The obvious alternative — make the falling edge respect `motionCooldownMs` —
was rejected: that turns every 2-second twitch into a 30-second session and
silently redefines a knob the operator already uses for something else.

## Decision

A detection session stays open at least `MIN_SESSION_OPEN_MS` (10 s), whatever
closes it. Both lifecycle close paths — the explicit `motion_cleared` falling
edge and the `cooldown_expired` fallback timer — funnel through one
`closeOrDeferLocked`, which consults the pure `decideSessionClose`; a close that
arrives early is **DEFERRED to the deadline, never discarded**. The deferral is
armed as the session's own teardown timer, so a motion tick arriving during the
window replaces it through the existing "already active" branch: the session
simply lives on, with no re-election and no second dispatch.

This is a FLOOR, deliberately not a fourth authority (D62). `motionCooldownMs`
keeps deciding how long after the last motion tick a session stays open; the
floor only forbids a session SHORTER than 10 s. Where they disagree — an
operator setting a 2-second cooldown — the floor wins and that is the honest
reading of the rule: you cannot ask for a session shorter than the floor.

`stopDetection` (`stopForDevice`) and the pin-reassign close
(`closeSessionForReassign`) deliberately do NOT go through it. Those are the
operator removing the work, and a floor must never delay a stop.

## Consequences

- Steady-state concurrency rises: a session that used to last 4 s now lasts ≥10 s,
  so more cameras are attached at once. Bounded and modest — and it is repaid,
  because the sessions that used to be re-opened five times a minute now merge
  into one.
- 10 s is well under `motionCooldownMs`'s 30 s default and far under
  `DEFAULT_MAX_SESSION_HOLD_MS` (120 s), so on a camera with a well-behaved VMD
  the floor never fires and nothing changes.
- The deferred close does not consult the track hold. An explicit `detected:false`
  still means "the scene is clear"; the floor delays that answer, it does not
  turn it into a hold.
- The deferral logs at DEBUG and replaces an INFO close line, so log volume on a
  flapping camera goes down, not up.
- Two existing tests encoded the old contract ("closes immediately when the hub
  emits detected:false" asserted at t≈0). They now advance past the floor first —
  they were rewritten, not deleted, because the falling edge beating the fallback
  timer is still the rule.

## Enforcement

`packages/addon-pipeline-orchestrator/src/__tests__/session-minimum-open.spec.ts`
— unit tests over `decideSessionClose` plus fake-timer controller tests that pin
each branch: the 2.4 s falling edge does not detach; a motion tick during the
deferral produces neither a detach nor a re-dispatch (the harness has no
`loadService`, so a re-dispatch would throw); the falling edge still closes at
once past the floor; the deferred close ignores the track hold; the floor also
bounds a short `motionCooldownMs`; and `stopForDevice` is never delayed.
`session-hold-on-active-track.spec.ts` continues to own the cooldown/hold rules.
No guard script — review only.
