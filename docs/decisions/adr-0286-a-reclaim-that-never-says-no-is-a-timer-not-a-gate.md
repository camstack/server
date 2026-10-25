---
id: D286
title: A reclaim gate that never says no is a timer — back it off, and never widen the trigger that another process depends on
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/system/src/kernel/heap-watch.ts
---

## Context

`heap-watch` runs a synchronous `gc({ execution: 'sync', flavor: 'last-resort' })`
when `strandedMb` — `rss − heapUsed − external` — exceeds
`HEAP_RECLAIM_TRIGGER_MB` (1024), no more often than
`HEAP_RECLAIM_MIN_INTERVAL_MS` (120 s). It was written as a threshold with a
rate limit.

hub-main's first 25 minutes of telemetry, 2026-08-29, showed it is not one:

- `stranded` sat at **1031–2313 MB for the entire boot**. The lowest reading of
  the boot already clears the trigger, so no sample can fail it and the only
  thing left deciding is the timer.
- **Nine minutes out of nine that contained a reclaim show `loopMax` ≈ the
  pass's own duration (555–869 ms)**; every minute without one is 107–435 ms.
  The largest recurring event-loop stall on the process that mediates every
  cross-runner call is the memory patch it applies to itself.
- Each pass freed less than the last (1193 → 462 MB) while the post-pass RSS
  floor ratcheted **1940 → 3510 MB in fourteen minutes**, with `heapUsed` never
  moving.

The reason `stranded` cannot discriminate is structural, not a bad constant. It
lumps together V8 pages committed at a sawtooth peak — which the pass RETURNS —
and glibc arena memory already freed, which **no V8 flavor can reach** (nothing
here calls `malloc_trim`). Once the second term exceeds the trigger, the quantity
can never fall back under it.

**The obvious fix is the wrong one.** Raising the trigger moves the number at
which the same degeneration happens, and it silences `hub/recorder` — which
fires this pass **once in six hours**, at `stranded=1029MB`, two megabytes from
hub-main's minimum. That single line (`freed=507MB`, and V8 still holding
1.44 GB live 40 s later) is the only cheap proof anyone has that the recorder's
1.4 GB is retained rather than churn. A trigger wide enough to quieten hub-main
destroys that probe.

## Decision

The gate is not the LEVEL of the strand; it is **whether the strand ever falls
back under the trigger between passes** — which `RECLAIM_STEADY_STATE_PASSES`
already counted and used only to print a warning. That counter becomes
load-bearing: once the pass has fired at the floor `RECLAIM_STEADY_STATE_PASSES`
times running, the trigger has demonstrably stopped discriminating on this
process, and the cadence falls back to `HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS`
(600 s) — a period chosen for its COST rather than a threshold pretending to be
a gate. The run resets the moment the strand falls under the trigger, and the
120 s floor returns with it.

600 s is the value `HEAP_RECLAIM_MIN_INTERVAL_MS` held before 2026-08-17. The
reason it came down is recorded there: *"the ten-minute floor let a peak that
re-formed in seconds stand for ten minutes"* — an argument about a BURST. A
burst subsides, which resets the run and restores the 120 s floor, so the burst
bound is untouched and the steady state gets the period that argument was never
about.

## Consequences

- **hub-main**: first six passes at 120 s, unchanged. From the seventh
  consecutive floor-to-floor pass, every 600 s. Stop-the-world cost on the
  router falls from ~0.58% of wall clock to ~0.12%. The pass is **not removed** —
  it is still the only measurement of this process's live ArrayBuffer set (ten
  passes out of ten land at 12–29 MB, which is what proved `arrayBuffers` is a
  rate and not a retained set).
- **`hub/recorder`**: zero change, by construction. `passesAtFloor` increments
  only when a pass fires within `floorMs * 2` of the previous one; a strand that
  takes six hours to re-form resets the counter to 1 on every pass and can never
  reach six.
- The warn that already existed now says what it DID and why, once per run.
- This bounds the peak less tightly on a process in steady state. That is the
  intended trade: the pass never held that floor anyway — it ratcheted 1940 →
  3510 MB while firing every 120 s — so the frequency was buying a stall and not
  a bound.
- **It does not fix the allocation source.** The line says so out loud, because
  a safety net that has become the mechanism is the moment to go after the rate,
  not the symptom.

## Enforcement

`packages/system/src/kernel/__tests__/heap-reclaim-cadence.spec.ts` drives a
permanently-stranded process for an hour of virtual time and asserts 9–12 passes
where the unfixed timer gives 30, and drives a recorder-shaped process for six
hours and asserts it is never declared steady state. `reclaimIntervalMs` is pure,
so the cadence itself is asserted without allocating a gigabyte to reach it.
