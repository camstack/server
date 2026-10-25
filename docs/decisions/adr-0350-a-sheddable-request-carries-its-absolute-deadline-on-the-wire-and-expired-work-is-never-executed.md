---
id: D350
title: A sheddable request carries its ABSOLUTE deadline on the wire, and expired work is never executed
status: accepted
date: 2026-09-05
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts
  - packages/addon-pipeline/python/inference_pool.py
---

## Context

On a pool timeout (`POOL_LIVE_INFER_TIMEOUT_MS`, 3 s) the TS side logged,
dropped the frame and returned null — **but the Python worker still executed
the abandoned request**, and its late reply was discarded as `Response for
unknown request id`. Under sustained overload that is self-sustaining: the
accelerator runs at 100% on results nobody reads, the queue stays full, every
new request is born late, and goodput sits at ~0 until a restart empties it.

Measured on the hub, 2026-09-04: the storm ran **4 h 15 m** (18:18 → 22:33,
ended only at the next restart), **16 146 timeouts**, 12 019 of them with
`inFlight` pinned at 7 of the cap of 8, plus 5 207 `worker saturated` sheds.
Idle p99 for the loaded model (yolov9m-320-int8) was 25–47 ms against the
3000 ms deadline — 64–120× headroom. So the tempting fixes are both wrong:
raising the deadline feeds MORE dead work to the pool, and adding workers adds
capacity that was already ≥6× arrival. The only fix is to stop doing work whose
caller has already walked away.

What was tried first and did not suffice: the TS in-flight cap (bounds the
backlog) and the Python per-model bound (sheds the *oldest queued* frame).
Both shed at ADMISSION. Neither can see that a request already written to the
pipe, or already promoted out of the pending queue, has meanwhile expired —
the worker had no notion of "too late" at all.

## Decision

Every **sheddable** request (`MSG_INFER_JPEG`, `MSG_INFER_RAW`,
`MSG_INFER_BATCH`, `MSG_INFER_CACHED` — exactly `SHEDDABLE_MSG_TYPES`, kept
mirrored on both sides) is stamped with its **absolute deadline** — an 8-byte
epoch-ms uint64 LE prefixed to the payload — computed at dispatch as
`Date.now() + POOL_LIVE_INFER_TIMEOUT_MS`, the same instant the local watchdog
arms. The Python worker checks the deadline **immediately before predict**
(on admission AND when the backpressure queue promotes a waiting frame, which
is where a request goes stale) and answers
`{dropped: true, shedReason: "deadline-expired"}` instead of running.
Commands, model loads and `cacheFrame` never gain a deadline: a shed command
desynchronizes the worker's model slots.

The wire change is **versioned, negotiated per worker**: the TS startup config
declares `protocolVersion`, the worker's ready reply reports its own
`PROTOCOL_VERSION`, and BOTH sides independently take
`min(mine, theirs)` as the effective layout. A worker and a host at different
versions is the NORMAL state during a deploy on this cluster (framework code
ships in the `@camstack/server` closure, addons ship separately), so:

- a v2 worker under an old host (no declaration) parses the v1 layout,
  byte-identical;
- a new host over a v1 worker (no report) sends the v1 layout, byte-identical;
- only when both ends are v2 does the deadline travel.

On the TS side, a live request whose local deadline fires **resolves as the
same shed** (`dropped: true, shedReason: 'deadline-expired'`) instead of
rejecting — a shed is flow control the executor already handles
(`poolResultToEngineOutput` → skip), not a fault worth 16 146 ERROR lines.
The reject path survives for commands and model loads, where a loss IS a
fault. And the drop is visible: the worker logs the shed at WARN (first + every
500th, with `tags.deviceId` when the frame had a camera), the Python side logs
the same sampled line to stderr, `PoolCounters.shedDeadlineExpired` rides
`mem_stats`, and `SharedInferencePool.getDeadlineExpiredShedCount()` surfaces
through `getPoolBacklog().deadlineExpired` on the memory watchdog's periodic
`pool memory` line.

## Consequences

- Under overload the pool now spends microseconds per expired request instead
  of 25–47 ms of predict — the queue drains at answer-rate, so the collapse
  mode (backlog outrunning the deadline forever) cannot self-sustain.
- A rising `deadlineExpired` counter is the fix WORKING, not a fault; the
  fault signal moves to the WARN line and to goodput.
- Both sides carry the layout knowledge: `SHEDDABLE_MSG_TYPES` and the prefix
  length must stay mirrored between `shared-inference-pool.ts` and
  `inference_pool.py`. Adding an opcode to one set and not the other
  desynchronizes framing at v2 — the deadline tests pin the membership.
- The stamp is wall-clock (`Date.now()` / `time.time()`), consistent because
  worker and host share a machine; a clock STEP between stamp and check can
  mis-shed at most the 3 s window. Monotonic clocks were rejected: they are
  not comparable across processes.
- Deploy order for the rollout does not matter (that is the point), but the
  benefit only arrives when BOTH the addon (`addon-pipeline` ships both
  files) is deployed AND the runner restarted so new pools spawn the new
  worker script.
- The live-timeout ERROR (`inference request timed out`) no longer exists for
  sheddable requests. Dashboards grepping it now watch the command path only;
  the live signal is `live inference deadline expired in flight` (WARN,
  sampled) plus the counters.

## Enforcement

- `python/test_inference_pool_deadline.py` — the gate (expired ⇒ dropped, NO
  predict; fresh ⇒ runs), both layouts by negotiated version, opcode
  membership, negotiation min/garbage/absent. The no-predict test was proven
  to fail with the gate removed (mutation-tested on 2026-09-05).
- `src/detection-pipeline/engine/__tests__/pool-deadline-on-the-wire.spec.ts`
  — the TS half: dropped-not-timed-out, the handshake declaration, old worker
  ⇒ old layout, new worker ⇒ stamped layout (single and multi-part writes),
  commands never stamped, the pool-level counter.
- `pool-failure-lines-name-the-camera.spec.ts` and
  `timeout-line-reports-the-deadline-that-fired.spec.ts` pin the WARN line's
  tagging and its `timeoutMs`; `timeout-error-names-the-pool-device.spec.ts`
  pins the surviving command rejection.
