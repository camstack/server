---
id: D652
title: The runner never destroys a frame it admitted — a teardown drains, a burst completes on inference, pre-roll fits the hold
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/session-decode-coordinator.ts
  - packages/addon-pipeline/src/session-decode/session-decode-pump.ts
  - packages/addon-pipeline/src/session-decode/guarded-session-decode.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - packages/addon-pipeline/src/session-decode/worker-protocol.ts
  - packages/addon-pipeline/src/session-decode/pre-roll-burst.ts
  - packages/addon-pipeline/src/session-decode/pre-roll-hold-ledger.ts
  - packages/addon-pipeline/src/session-decode/bounded-exit.ts
  - packages/addon-pipeline/src/session-decode/decode-loop-policy.ts
  - packages/addon-pipeline/src/session-decode/native-disposer.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-main.ts
  - packages/addon-pipeline/src/session-decode/fork-decode-worker.ts
  - packages/addon-pipeline/src/session-decode/live-worker-admission.ts
  - packages/addon-pipeline/src/session-decode/frame-slot.ts
  - packages/addon-pipeline/src/pipeline-runner/frame-queue.ts
  - packages/addon-pipeline/src/session-decode/native-lease-store.ts
  - packages/addon-pipeline/src/pipeline-runner/occupancy-burst-ledger.ts
  - packages/addon-pipeline/src/pipeline-runner/runner.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/types/src/interfaces/event-bus.ts
---

## Context

A detection frame on the local-frame-ref path is a zero-copy reference into the
session's decode worker (`local-frame-registry.ts`): its pixels exist only while
that worker process does. The runner tore its own worker down in the same turn
it detached:

`detachInternal` → `detectionUnsubscribe()` → pump `iterator.return()` →
coordinator `teardown()` sent `stop` and `kill()` at once → the child's
`handleStop` called `process.exit(0)` → `handleExit` rejected every pending
`toBuffer`, and `requestBuffer` refused new ones.

So every frame still queued or in flight died as `runInference failed … worker
exited before toBuffer reply` / `worker already exited`. Four hours of hub logs
(2026-09-26 19:44–23:44): 123 + 41 such failures, 22 `local frameRef miss:
stale-ref`, and **zero** `session-decode worker exited unexpectedly` — every
exit was one the runner asked for. Two doors:

- **The occupancy recheck (56%).** `runOccupancyDial` enqueued its 4th frame and
  called `cleanup()` in the same synchronous turn — teardown, and the verdict
  (`occupancyBurstFound`) read before any result. 122 of 187 bursts lost at
  least one frame, and the verdict was computed from fewer frames than the
  burst collected, with no log line.
- **Motion-session close (~43%).** `closed on motion clear` → detach while 1–4
  admitted frames were still queued or in inference.

A third, separate loss: 98 `toBuffer miss … released/hold-full` in the same
window, 95 of them on frameId ≤ 12 — PRE-ROLL frames. The burst admitted up to
`preRollInferenceFrames` (12) into a native hold of `holdFrames` (8), and the
lane reads oldest-first, so the burst evicted its own oldest frames before
inference reached them.

## Decision

**A frame the runner admitted is never destroyed by the runner's own
teardown.** Concretely:

1. **A planned teardown drains before it kills.** The coordinator sends `drain`
   (the worker stops decoding and never re-dials, frees its one undelivered
   slot frame and closes the demuxer once the decode loop has left it, but
   keeps its reserved slot, hold, tile stores and the decoder their GPU
   surfaces belong to), waits until every image it yielded has been closed and
   every `toBuffer` and `nativeCrop` it already SENT has been answered, then
   sends `stop` + SIGTERM. A crop asked for after the teardown request is
   refused by name (`NATIVE_CROP_REFUSED_DRAINING`, below) rather than waited
   for: post-analysis's ordinary crop lands 2.2–9.9 s after the frame, past any
   bound worth holding a worker for, and is served from subject tiles that die
   with the worker either way. The wait is bounded
   by `SESSION_DECODE_DRAIN_BOUND_MS` (1 500 ms): measured on the hub, the worst
   enqueue→emit of a 10 s window was ≤1 500 ms in 98.0% of 2 254 windows, and
   5 s buys only 0.9% more — the inference-pool GPU hang, which no wait
   rescues. A frame still held when the bound expires is logged with its count
   and `tags:{deviceId}`. A worker that dies while draining is logged too.
   **`'immediate'` is the named exception**: addon shutdown (the runner has
   stopped dispatching) and a session whose worker reported a fatal error keep
   the kill-now path — and kill-now is **SIGKILL**. The SIGTERM handler this
   record gave the child (`bounded-exit.ts`, `decode-worker-main.ts`) made
   SIGTERM no longer instant death: a worker blocked in a native call (a VAAPI
   hang) never runs it, and the only rescue was a 1 s SIGKILL fallback on an
   `unref`'d timer the exiting parent did not wait for, so on shutdown that
   worker was orphaned holding its GPU pool. The drain path keeps SIGTERM (the
   last lines leave) with the fallback now ref'd — it exists only while the
   parent is alive and not shutting down, because a **second teardown saying
   `'immediate'` during a drain escalates** it to SIGKILL, through every link
   (guarded start → pump → coordinator), instead of being ignored as a repeat.
   Every other caller gets `'drain'` by default.
   **The node's live-worker slot is the WORKER's, not the session's**: it goes
   back from the process's real `exit` (`onWorkerGone`), never from the teardown
   request. A draining worker still holds its decoder, GPU pool and hold, so a
   gate that closes and reopens, a re-attach, or an occupancy dial right after
   a close is counted against the ceiling and refused (then retried on the
   ordinary backoff) rather than doubling the camera's native footprint
   unseen. A returned slot WAKES the longest-parked start the ceiling refused
   on that node — ONE per slot, FIFO by the start's FIRST park
   (`LiveDecodeWorkerAdmission.slotWaiter`: one `SlotWaiter` per start, taken
   on its first refusal and kept until the start is over, so a start woken and
   refused again, or retried by its timer, re-parks at the SAME place); a wake
   does not count as a retry attempt, the backoff timer is only the fallback,
   a torn-down start leaves no listener behind, and a start woken and torn
   down before it could ask PASSES the slot to the next parked start
   (`leave(unusedWake)`) rather than letting everyone wait out a full timer.
   The refusal WARN fires once per camera per entry into the refused state
   (debug after), so a freed slot cannot become a storm of refusals — and a
   start torn down while refused LEAVES that state, so the camera's next
   refusal is a WARN again (D391): cleared only on admit, a camera refused and
   never admitted stayed "already warned" forever. A `startPump` that throws returns the slot and the restream at
   once, and a spawn that fails with `error` and no `exit` is delivered as the
   worker's one exit (`wrapChild`), so neither path can leak a slot. The
   restream refcount still goes back at once — a draining worker reads
   nothing. A crop requested AFTER the teardown is refused with a named miss
   (`NATIVE_CROP_REFUSED_DRAINING`) rather than sent to a worker about to die.
   **The exit path disposes nothing native.** SIGTERM, `stop`, a lost channel
   and an uncaught error all go through `createWorkerExit`: quiesce (timers,
   loop, burst — no native call), queue the final lines, wait at most
   `WORKER_EXIT_FLUSH_BOUND_MS` (250 ms) for them to leave, exit. The exit is
   scheduled even when a step throws (then with code 1): `exiting` is already
   set, so otherwise every later request returned early and, on `disconnect`,
   nothing ended the process. The decode loop may still be inside libav
   during that wait, so freeing under it would be a use-after-free that loses
   the very lines the wait is for; process exit reclaims everything, the GPU
   pool included. EVERY native dispose/close in the worker goes through one
   door, `NativeDisposer`, which refuses (debug line) from the first step of
   the exit — so an indirect path (a GPU-filter degrade, a filter rebuild, a
   re-dial cleanup) cannot free under a live read either — and every request
   arriving after the exit began is answered as a refusal instead of starting
   native work. The worker class (`decode-worker-child.ts`) is free of process
   side effects; the forked entry is `decode-worker-main.ts`. Before D652
   there was no SIGTERM handler and a `kill()` dropped those lines.
2. **An occupancy burst completes on inference, not on enqueue.** Each admitted
   burst frame carries an `onSettled` callback the runner fires exactly once —
   `true` after the result callbacks ran, `false` when it lets the frame go
   (superseded on the latest-only queue, cleared by a detach, failed, timed
   out). `OccupancyBurstLedger` completes the burst when collection has closed
   and every admitted frame has settled, or after
   `OCCUPANCY_BURST_SETTLE_BOUND_MS` (5 000 ms), counting unsettled frames as
   lost. Only then does it report. The dial DRAINS its worker the moment
   collection closes (no more decoding; the admitted frames stay readable).
   The analyzer-tap burst uses the same ledger. A frame a newer frame of the
   same burst replaced on the latest-only queue is `superseded`, not `lost`.
   `occupancy re-check: burst complete {frames, inferred, superseded, lost,
   found}` is INFO whenever `lost > 0`.
   **A burst that inferred nothing produces no verdict** (ruling, D49): it
   observed nothing, so it is not evidence of an empty scene and must not count
   toward disarming the recheck. It logs `burst complete — nothing inferred, no
   verdict` at INFO and the empty-burst streak is left as it was.
3. **Pre-roll fits the hold; the reach is kept.** The burst sends at most
   `holdFrames - 1` frames to inference (the D367 in-flight ceiling), spread
   over the same `preRollInferenceFrames × cadence` of media the operator asked
   for (`planPreRollWithinHold`). The pre-roll report line gains
   `effectiveBudgetFrames` and is still sent at burst end. What happens to the
   delivered frames AFTER it is a second line, `pre-roll frames settled {read,
   released, lostByReason: {evicted, cleared, download-failed, miss},
   unsettled}` — INFO when anything was lost or is still unsettled — sent once
   they have all settled, or on teardown. The cap does NOT make `evicted` zero:
   live frames share the hold and outrank the lane, so a burst whose history
   waits behind `holdFrames` live admissions can still lose its oldest frames.
   The cap removes the burst's SELF-eviction, which was the measured 95 of 98.
   `laneRefused` on the report is `null` when the camera is already detached —
   an unread count, never 0 (D393).
4. **A close says whether the tracker still held a subject.** Post-analysis
   adds `liveTrackCount` (the tracker's own count, still subjects included) to
   `PipelineAnalyticsFrameTracked`; the orchestrator's close line carries
   `liveTracks` (`null` = unknown, never 0), and a close with `liveTracks > 0`
   is a WARN. **Diagnostics only**: the stillness and session-hold policy is the
   operator's and is unchanged.
5. **Every path that now loses a frame says so** (D391): the drain bound, a
   death while draining, the runner's queue discard on detach / session close
   (`detection frames discarded with the session` — INFO when an awaited burst
   frame or admitted history was dropped, debug for the routine latest-only
   frame of a closing live session), a burst's lost frames, and every pre-roll
   loss by reason.

### Why cap the pre-roll rather than raise the hold

D382 is about the history a consumer ASKS for — a span of media. Capping the
frame count while keeping the planner's window at `requestedFrames × cadence`
serves the same span, sampled less densely (12 frames at 100 ms → 7 at
~171 ms), so the ask is honoured. Raising the hold during the burst would pin
up to `requestedFrames - holdFrames + 1` extra native rasters (~24 MB each at
4K, ~120 MB per session open, several sessions per motion event) — the
allocation D9/D18 forbid, and a raised ceiling instead of a removed cause.

## Consequences

- A detached worker lives up to 1.5 s longer, idle: decode stopped, restream
  released at once, its live-worker slot held until it exits. A re-attach
  during that window can be refused by a full node; it is woken the moment the
  slot comes back, and the 2 s retry is only the fallback.
- A drain's SIGKILL fallback timer is ref'd: a runner with nothing else to do
  stays up at most 1 s longer for it.
- A burst holds its occupancy slot until its frames are inferred (typically a
  few hundred ms more; at most 5 s).
- Pre-roll inference density drops from 12 to 7 frames on the default knobs;
  the span of history is the same.
- The `preRollReport` wire reply requires `budgetFrames`, and `preRollSettled`
  is a new reply; parent and child ship in the same addon, so there is no skew.
- `liveTrackCount` is a framework (`@camstack/types`) field: the orchestrator
  reports `liveTracks: null` until a post-analysis that sends it is running.
- The runner's latest-only queue is still cleared on session close and detach
  (one frame at most); that is now logged, not changed.

## Known scope

Two branches reach the kill-now path by construction and are left as they
are, on the record:

- **A pull timeout counts as `'immediate'`.** A worker that stops producing
  frames without exiting fails the session (`pullNext` rejects), and a failed
  session is a crash: nothing it still holds is trusted, so it is not drained.
  Frames admitted just before the hang die with the worker, logged as any
  failed session's are.
- **The decline-path settle happens under a disabled hold.** A pre-roll frame
  the runner declines (`onFrameRef` false) is settled by the burst while the
  worker's hold for it has already been released; the settle line counts it as
  `released`, never as a read, which is the truth of it.

## Enforcement

Tests, each disarmed and seen red: `session-decode-drain.spec.ts` (3 lazy
frames all materialise after teardown; bound logged; `'immediate'` kills now;
a fatal error kills now; a pending read alone, and a pending crop alone, keep
the drain open; a crop after teardown refused by name; death while draining
named; `onWorkerExit` only on the real exit; the pump's worker-gone for a
never-forked session), `guarded-session-decode-retry.spec.ts` (slot held until
exit; the ceiling counts a draining worker; a returned slot wakes a refused
start; a throwing `startPump` returns slot and restream; a teardown inside
`startPump` is replayed), `fork-decode-worker-exit.spec.ts` (a spawn `error`
is the one exit), `runner-frame-settle.spec.ts`,
`occupancy-burst-ledger.spec.ts`, the D652 cases in
`occupancy-burst-tap.spec.ts` (verdict on inference; drain at close; no verdict
on zero inferred), `pre-roll-hold.spec.ts` (hold cap, settle tracker, bounded
exit order and signal wiring, the decode-loop dispose policy, `freeUndelivered`), `pre-roll-frame-carry.spec.ts`,
`session-close-live-tracks.spec.ts`, `frame-tracked-live-count-tap.spec.ts`,
and the `liveTrackCount` case in `frame-tracked-presence.spec.ts`;
`worker-exit-hardening.spec.ts` drives the REAL worker class against a spy on
its disposer (a degrade, a re-dial cleanup and a `toBuffer` after the exit
began reach no native close) and a quiesce that throws on SIGTERM and on
disconnect (the worker still exits, code 1, within the bound). The
`guarded-session-decode-retry.spec.ts` cases add: one wake per freed slot and
no WARN burst (and the fallback retry is asserted to HAPPEN), no listener left
by a torn-down parked start, teardown-inside-`startPump`-then-throw releasing
slot and restream once, a woken start torn down before it asks passing the
slot on, a woken start refused again keeping its FIFO place, a lost wake not
stretching the fallback on a multi-step ladder, and a camera refused → torn
down → refused again WARNED again; `live-worker-admission.spec.ts` pins the
re-arm on teardown and on admit (level-aware) and the queue's first-park order.
`worker-exit-hardening.spec.ts` also proves the bounded exit on a throwing
quiesce with a line still in flight. `session-decode-drain.spec.ts` pins the
kill signals: `'immediate'` and a fatal error SIGKILL, a settled drain
SIGTERMs, and a second `'immediate'` during a drain SIGKILLs and disarms the
bound; the guarded start passes that second `'immediate'` to the pump, and a
teardown during a timer-only backoff still ends the loop (`leave` runs).
`session-close-live-tracks.spec.ts`: the designed stillness-valve close is
INFO with `liveTracks`, live tracks the hold never saw stay WARN. The
worker-child WIRING of those pure pieces (which seam settles which way, that
the loop consults the dispose policy) needs node-av and is covered by review
and the live counts only.
