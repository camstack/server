---
id: D194
title: A trigger window is rebuilt from durable rows, not only received
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/band-decision.ts
  - packages/addon-pipeline/src/recorder/addon/recording-controller.ts
last-verified: 2026-10-02
---

## Context

[D191](adr-0191-an-event-recording-is-kept-against-every-trigger-window-not-the-last-one.md)
made the `events`-band keep gate read a LIST of trigger windows, and every one
of those windows arrives exactly one way: `onTrigger`, fed by an `EventCapture`
subscription on the event bus.

[D8](adr-0008.md)/[D11](adr-0011.md) say what that means — **an event is
telemetry and may be dropped**, and durable state must not rest on one. What
these events feed is as durable as it gets: a window the gate never learned
about means the episode is not recognised, so the recorder either never attaches
or attaches and unlinks every segment it wrote. The footage is gone; there is no
later pass that can recover it.

This is not hypothetical on this cluster. The instrumentation added on
2026-08-20 measured `receivedLagMs` on the trigger path and found a `busLagMs`
of **142 173 ms** — a trigger that reached the recorder more than two minutes
after the motion, with its whole `postBufferSec` already spent. A lost event and
an event that late are the same fact to the keep gate: no window.

The tempting fix was to persist the recorder's own `EventMarker`s. They already
carry the pads, and the file reads as if it were a store. It is not: `EventMap`
is in-RAM by its own header, fed by the same subscription, and it would not have
survived either failure. Building the reconcile on it would have been a leftover
that describes the right design — verification that verifies nothing.

## Decision

The trigger window is maintained by TWO paths and one merge. `onTrigger` stays
the fast path and is what opens a recording. On every `RECONCILE_TICK_MS` beat,
before the evaluate, the controller **rebuilds** each events-band device's
motion windows from the durable rows —
`pipelineAnalytics.getMotionEvents`, single-timestamp SQLite records of the same
upstream signal — through `foldDurableTriggers`, which folds each row with
`recordTrigger`: the SAME merge as the fast path, never a second policy.

The reconcile is bounded by the question, not by the store: it queries only
`postBufferSec + TRIGGER_HISTORY_MARGIN_MS` back (past that a recovered window
could retain nothing anyway), only for a device whose ACTIVE band is `events`
with a motion trigger, and only when the dependency is wired.

## Consequences

- **A recovery is a signal, and it is logged.** `recovered > 0` means the bus
  did not deliver something the store had. On a healthy cluster it is zero, so a
  nonzero rate is early warning about the event path — available before it costs
  an episode rather than after.
- **"Recovered" is compared on the window SPANS, not on object identity.**
  `recordTrigger` rebuilds its array every call, so an identity test would
  report every row as a recovery and the line would claim the bus was losing
  everything, always. A log that always fires is a log nobody reads.
- **Motion only.** Audio triggers have no durable counterpart at the same
  granularity. Naming that here, rather than reconciling one source and letting
  the feature read as covering both.
- **It costs one RPC per events-band camera per two minutes**, with the
  `slim` projection so the regions array does not travel. A continuous camera
  costs zero: the config read that decides it is local.
- **A failing store changes nothing.** The reconcile absorbs its own errors and
  says so; the fast path is untouched and the next beat retries. The dependency
  is optional on `RecordingControllerDeps`, so an unwired controller is
  byte-identical to the pre-2026-08-20 behaviour.
- It does **not** make a recording start sooner. A window recovered two minutes
  late still retains footage retroactively (that is exactly what D191's list is
  for), but the media before the attach only exists if the broker's ring held it
  — see [D193](adr-0193-one-ring-two-windows-and-a-budget-in-bytes.md).

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision.spec.ts` —
  `foldDurableTriggers — the reconcile that the bus cannot lose`: idempotence,
  widening an episode whose earliest rows were dropped, order-independence,
  bounding, and non-finite rows.
- `packages/addon-pipeline/src/recorder/addon/__tests__/recording-controller-trigger-reconcile.spec.ts`
  — drives the controller with the bus SILENT (`onTrigger` never called) and
  pins that the writer spawns anyway. Verified by removing the call: 3 of 5
  fail. Also pins that a continuous camera queries the store zero times and that
  a failing store degrades to the fast path with a line.

## Amendment, 2026-09-28 — the fold keeps TIME ORDER, and "latest" is the maximum

"The SAME merge as the fast path" was true, and the merge was wrong for exactly
the rows this record added. `recordTrigger` compared a trigger with the NEWEST
window only; a trigger older than that window's `firstMs` by more than the merge
gap was **appended** — stored as the newest window although it was the oldest.
The bus almost never produces that shape. Durable rows produce it routinely: an
analyzer row can precede the bus trigger that opened the live window (camera
3836, an Amcrest, measured ~31 s).

Two consequences, both seen live:

- **The live gate went backwards.** `latestTriggerMs` read the last element, so
  on the reconcile beat that folded such a row the newest trigger became 31 s
  older and `eventsBandDemanded` closed the window: `trigger windows recovered`
  and `profile teardown drained` in the same second, a respawn 2–9 s later on
  the next keepalive, and a 7–10 s hole in `getAvailability` (09:57:58 → 09:58:08).
  A reconcile that exists so footage is never lost was tearing footage down.
- **`recovered` equalled `rows`.** Every later row in the batch was diffed
  against the wrong "newest" and counted as new (`rows=5 recovered=5` where one
  was). The line this record calls "early warning about the event path" blamed a
  bus that had delivered every trigger on time.

**Decision.** A window list is kept SORTED by `firstMs` with no two windows
within the merge gap of each other. A trigger — and a released level span, which
had the same defect — widens the window(s) it lies within the gap of, bridging
two if it sits between them, and is otherwise INSERTED at its place in time
(`foldSpanInOrder`, the standard interval merge, which also heals a list an
older build left out of order). `latestTriggerMs` is the MAXIMUM `lastMs`, not
the last element's: the live gate tearing a writer down is the one outcome that
destroys footage, so it does not rest on the ordering invariant alone. With the
order kept, `recovered` counts only rows that changed a span — genuinely new or
widening — which is what this record always said it counted. At the 32-window
bound, an older row inserted and evicted in the same fold changes no retained
span, so it is not a recovery; its eviction remains reported separately.

Enforcement: `band-decision.spec.ts` — `trigger history stays in time order`
(a row at T−31 s against a live `[T, T+40 s]` keeps recording; `recovered`
counts only undelivered rows; any arrival order yields the sorted, gap-separated
history of the sorted order; a bridging row; an older level span; the maximum
over an out-of-order list; an inserted-and-evicted row is not recovered) and
`recording-controller-trigger-reconcile.spec.ts`
— a recovered older row does not SIGTERM the writer. Disarmed: removing the
ordered insert fails 4, removing the maximum fails 1, removing both fails 6
including the controller test (either half alone keeps the gate up).
