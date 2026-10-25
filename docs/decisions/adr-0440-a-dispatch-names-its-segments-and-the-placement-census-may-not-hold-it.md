---
id: D440
title: A dispatch names its segments, and the placement census may not hold it
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-pipeline-orchestrator/src/dispatch-timing.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/reconcile-controller.ts
last-verified: 2026-10-01
---

## Context

Camera 101, 2026-09-10 16:45:32 UTC. `session motion → attach latency`:
`busLagMs 2220, lockWaitMs 0, dispatchMs 5032, sinceMotionMs 7252`. The
operator experienced 7.25 s between the dog moving and the first frame anyone
looked at; the pre-roll the attach replayed spanned 4.47 s; the first ~2.8 s
of the passage were never seen by anything. The runner's own ramp — fork to
frame, first decode, dial — was measured at ~840 ms. Where were the other four
seconds?

**Not in `attachOn`.** The log's own timestamps: `inference device selection`
16:45:38.455 → `detection session: dispatched on motion` 16:45:38.468. The
balance, the pipeline-config reads and the attach RPC together took **13 ms**.
The lock was acquired at 16:45:33.436; the five seconds were spent between the
lock and choosing a node. What runs there is one thing that is neither
memoised nor bounded: `reconcilePlacementFromRunners()`, awaited at the head
of every session dispatch, which asks EVERY runner node for its attached
cameras — in sequence, with no per-node bound — and then detaches the orphans
it finds, in sequence. Twelve hours of the hub's docker log:

| | |
| --- | --- |
| dispatches | 2 841 |
| `dispatchMs` p50 / p90 / p99 / max | 44 / 1 182 / 6 341 / 18 975 ms |
| over 2 s | 163 |
| … with a reconcile detach/drop line inside their window | 82 |
| … with nothing at all inside their window | 81 |
| `busLagMs` p50 / p90 / max | 1 / 381 / 22 145 ms |

The 81 are the point: a census that merely took long said nothing, because
the reconcile logs only what it changes. The sixteen worst dispatches of the
day are all inside 15:52–16:07 and 17:06, in bursts where five to nine cameras
dispatched together and each one paid for the same slow node in turn.

The runner numbers the coordinator started from (`forkToFrameMs 644` and the
rest) are real but are not inside `dispatchMs` at all: `attachCamera` returns
before the dial, and the RTSP client connected 0.8 s after the RPC did. The
end-to-end blind window is therefore bus lag + dispatch + runner ramp, and on
this dispatch that is ~8.3 s against a 5 s retained pre-roll.

### The two things that were asked and are not defects

**`requestedMs 15000` against `retainedMs 5000`** is by design, both halves.
The detection dial asks for `PREBUFFER_MAX_MS` (D382: an unstated ask is zero,
so it states the ceiling — "whatever you retain"); the broker retains
`DEFAULT_PREBUFFER_SEC` 5 s per stream, an operator setting up to 15 s whose
default was set on memory (5.1 Mbps on 101 → ~4.8 MiB per 5 s). The dispatch
p99 above says what raising it on a camera buys.

**`busLagMs 2220`** is the hub's event bus under load: the same minute's
`heap-watch` line reads `loopP99 593 ms, fanoutSuppressed 24 106`. p50 is 1 ms.
Events are telemetry and may be late (D8); nothing on the dispatch path can
recover time lost before the dispatch heard about the motion.

## Decision

A session dispatch **names its segments** on the latency line — `reconcileMs`,
`balanceMs`, `deviceSelectMs`, `configMs`, `attachMs`, and whether the census
overran — so `dispatchMs 5032 / attachMs 13` and `dispatchMs 5032 / attachMs
5000` are never again the same line. And the placement census **may not hold
the dispatch past `DISPATCH_RECONCILE_BUDGET_MS`** (500 ms): the dispatch
places on the ledger as it is, the census keeps running, and the dispatch
guard (`markDispatching`) is held until that census settles, because the pure
reconcile skips a guarded device for both its detach and its stale-assignment
drop — a census that snapshots the runners after this attach landed, from a
fan-out that ran before it, must not deregister the session it never saw. The
guard is taken AFTER the census when the census settled in time: the census
exists to remove this very camera's orphans, and a guarded device is one it
leaves alone.

The census itself asks every runner **in parallel**, each under
`RECONCILE_NODE_BUDGET_MS` (1.5 s); a node past it is counted as not having
reported (its assignments are never dropped — `reconcilePlacement` already
says so); orphan detaches run in parallel; and a census over
`RECONCILE_SLOW_MS` or with a skipped node reports itself with the per-node
cost — the line the 81 silent dispatches did not have.

## Consequences

- A dispatch's worst case from the census is now 500 ms instead of one slow
  node's event loop, and the census's own worst case is one node budget
  instead of a sum. Every ms of the budget is still a ms of retained pre-roll
  the first inferenced frame will not see.
- When the census overruns, an orphan of THIS camera on another node survives
  the dispatch until the census's detach lands (its detaches are already
  outside the dispatch) — a few hundred ms of duplicate load, not a duplicate
  session, and the reconcile ticker closes it in any case.
- A node skipped by the per-node budget keeps its orphans for one pass.
- Nothing here shortens the runner ramp or the bus lag, and nothing changes
  the 5 s default retention. For a camera whose passages are short the honest
  lever is per-stream `prebuffer` seconds, chosen against this line's p99.

## Enforcement

`dispatch-timing.spec.ts`, `session-dispatch-latency.spec.ts`,
`placement-reconcile-census.spec.ts`; `on-motion-session-cutover.spec.ts`
still pins that an unguarded census removes the camera's own stale attach
before the fresh dispatch. Each guard disarmed and the suite re-run:

| disarmed | red |
| --- | --- |
| the census awaited in full | 2: the attach at the budget; the guard outliving the dispatch |
| the guard released with the dispatch on overrun | 1: the guard outliving the dispatch |
| the census sequential again | 4: every census test (timing and outcome) |
| orphan detaches sequential again | 1: two orphans at 300 ms cost 300 ms |
