---
id: D261
title: A detection session lasts as long as the SUBJECT, not as long as the motion — and the stationary promotion is what ends it
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/dispatch-reconcile.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts
  - scripts/check-stationary-promotion-reachable.ts
---

## Context

`StationaryObjectRegistry` promotes a track that has stayed put across
`promotionWindowMs` (30 000 ms). On an `on-motion` camera that track only
exists while the orchestrator holds a detection session open. **It never
did.**

Measured on device 102, 24 h, 503 sessions paired from the orchestrator logs
(no truncation):

| p10 | median | p90 | ≥30 s |
| --- | --- | --- | --- |
| 10 002 ms | **10 221 ms** | 18 150 ms | **4/503 (0.8%)** |

The distribution is glued to `MIN_SESSION_OPEN_MS` — 53% of sessions die
within 500 ms of that floor. It is not a duration, it is a floor.

**Why.** `motion_cleared` (the camera's explicit low edge) closed **502 of
503** sessions; the cooldown closed 1; `maxSessionHoldMs` closed 0; and the
`held open — active non-stationary track` branch fired **0 times**. The
cooldown re-arm, the cap and the track-freshness read all lived inside
`armSessionTeardownTimer`'s **timer body**. A falling edge went straight to
`closeOrDeferLocked`, which consulted **only** the floor. On a camera that
emits an explicit low edge — which is every camera — that entire tolerance
machinery was unreachable code.

**The cost.** Of 312 tracks in those sessions, **0 died with the session
already closed** and **223 (71.5%) died in the exact instant of the
teardown**. Of the 222 the teardown killed, the median had been motionless for
**6.27 s** and 95% for at least 1 s — precisely the population promotion
exists to catch. Zero single-session tracks reached 30 s. And on the 213
tracks inside deferred sessions, where the low edge and the real close are two
separate instants, **155 had `lastSeen` within 1 s of the CLOSE and 2 within
1 s of the low edge**; 86% were still being observed **after** the low edge,
median +2.78 s. The subject was demonstrably still there.

Ruled out by measurement, not opinion: tracker identity-swap rebirths are
**4/309 (1.3%)** and move median track life by **24 ms**. The tracker is not
the cause.

**What was tried first and does not work.** "Hold the session while a track is
alive." That is a worse fault than the defect: a car parked in frame would hold
the session open forever, and detection would run 24/7 on every camera that
sees one — from a measured 7.9% uptime to 100%.

**Also ruled out:** lowering `promotionWindowMs`. Those 30 s exist so a person
standing at a door is not declared scenery. Lowering them fixes cars and breaks
people.

## Decision

**Every session close path asks one question, and the answer may be "hold".**
The hub's `motion_cleared` falling edge, the `cooldown_expired` fallback timer
and the re-ask of a close deferred to `MIN_SESSION_OPEN_MS` all funnel through
`resolveSessionLifecycleLocked` → the pure `decideSessionLifecycle`. No close
path may reach `closeActiveSessionLocked` on its own.

**The liveness criterion means a subject is PRESENT, not that a subject is
MOVING.** The tap is fed by `PipelineAnalyticsFrameTracked.hasLiveTrack` —
`result.tracked.length > 0` — replacing `hasMovingTrack`, which by construction
could not hold a session for a subject that had stopped, i.e. exactly the
subject promotion is about.

**The promotion is what ends the wait.** `result.tracked` is the
POST-suppression set: `promoteToStationary` calls `processor.dropTrack`, and
from the next frame the registry suppresses the detections matching its entry.
A promoted object therefore stops being present on its own, the hold lapses and
the session closes — while later sightings of it are suppressed, so they
re-open nothing. Nothing in the orchestrator knows what a promotion is.

**`maxSessionHoldMs` is unconditional.** Once `openForMs >= maxHoldMs` no
verdict can be `hold`, whatever the subject is doing. That is the bound for a
subject the registry will never promote (master toggle off, or a class it does
not own), and the last recheck of a hold lands exactly on the cap rather than
one tick past it.

## Consequences

**Detection uptime rises, and the rise is bounded by construction.** Estimated
on 102: 7.9% → **14–18%**. The hard ceiling, if every session ran to the cap,
would be 70% — the cap is the only thing between those two numbers, which is
why it is pinned by a test and by a build guard rather than by a comment. The
measurement and the arithmetic are in
[load-ledger.md](../architecture/load-ledger.md).

**A new staleness window exists and is deliberately small.**
`SUBJECT_PRESENT_STALE_MS` is 4 s, with the recheck cadence derived from it
(2 s), so the tail after a subject leaves is 4–6 s. It is explicitly NOT
`motionCooldownMs`: the cooldown answers a question about MOTION on a signal
that ticks per motion event, and reusing it for a per-FRAME signal would keep
every session alive a further 30–60 s after the scene emptied.

**A close that kills a live track now says so.** `closeActiveSessionLocked`
killed 0.44 live tracks per close across 503 closes and wrote nothing about a
single one. Its close line now carries `openForMs`, `sinceSubjectSeenMs` and
`subjectPresent`, always with `tags: { deviceId }`, and the case where the cap
forces a close over a still-present subject is a **warn** naming the tracks
that end there.

**An operator who raises `promotionWindowMs` on a camera must raise that
camera's `maxSessionHoldMs` too.** There is no global→device cascade to read,
and the pair is satisfiable inside both schemas' bounds — but it is not
statically checkable, so it is stated here and in the guard's success line.

**A structural cost that is reported, not fixed:** median **5.3 s** elapses
between a session opening and the first observation of a track on it (decode +
model warm-up + the tracker's confirmation gate). Of a 10.2 s session, under
half ever produced a track. The promotion window therefore starts ~5 s after
the session does, which is why the build guard requires
`PROMOTION_WINDOW_MS + 6 000 ms <= DEFAULT_MAX_SESSION_HOLD_MS`.

## Enforcement

`scripts/check-stationary-promotion-reachable.ts`, wired into
`.github/workflows/ci.yml`. It fails when:

1. `PROMOTION_WINDOW_MS + 6 000 ms` of measured warm-up exceeds
   `DEFAULT_MAX_SESSION_HOLD_MS`, or that constant stops mirroring
   `maxSessionHoldMsField.default`, or `SUBJECT_PRESENT_STALE_MS` grows into a
   second promotion clock;
2. the falling-edge branch stops routing through
   `resolveSessionLifecycleLocked`, or `closeActiveSessionLocked` grows a
   second caller — either collapses the reachable ceiling back to
   `MIN_SESSION_OPEN_MS` (10 s) with **every constant still correct**, which is
   how this defect existed;
3. the tap goes back to a `hasMovingTrack` read;
4. `hasLiveTrack` stops being derived from `result.tracked`, or
   `promoteToStationary` stops dropping the promoted track — the two mechanisms
   that make a parked car release the session instead of pinning it.

Each of those five arms was verified to fail by disarming it.

Tests:
`packages/addon-pipeline-orchestrator/src/__tests__/session-holds-until-stationary-promotion.spec.ts`
(the three guarantees, the falling edge, the deferred re-ask, the drop-work log)
and
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/frame-tracked-presence.spec.ts`
(presence follows the tracked set; drop + suppression both empty it).

A guard alone would not have caught it and a test alone would not have caught
it: every component was correct in isolation, and the defect lived in the
arithmetic between two packages that never mention each other plus one routing
decision that made the arithmetic moot.
