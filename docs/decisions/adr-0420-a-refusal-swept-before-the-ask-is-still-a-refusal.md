---
id: D420
title: A native lease is bounded by the worker's tile TTL, and a handle swept before the ask is still reported as a refusal
status: superseded
date: 2026-09-09
supersedes: D419
applies-to:
  - packages/addon-pipeline/src/session-decode/native-crop-lease-age.ts
  - packages/addon-pipeline/src/session-decode/native-crop-registry.ts
  - packages/addon-pipeline/src/session-decode/media-clock.ts
---

## Context

D419 bounded a native crop lease at 10 s and was deployed to all three nodes
at ~14:00 on 2026-09-09. The operator marked nine tracks between 14:59 and
15:31 as "media mancanti, box fuori posizione, peggio di ieri". Measured on
every video track ≥ 1.5 s the hub stored that day (`debug.analyze` over 1 026
tracks, 32 cameras):

| window | tracks | keyFrame present | zero media | `native-miss` at close | raster thumbnail | lastFrame stale |
| --- | --- | --- | --- | --- | --- | --- |
| 11:00–13:50 (before) | 398 | **99.5 %** | 0.0 % | 1.3 % | 1.0 % | 12.8 % |
| 14:00–15:58 (10 s bound) | 628 | **76.6 %** | 11.8 % | 26.3 % | 16.4 % | 32.5 % |

Per camera it was worse where the subject is far from the decoder: 3829
(esterno garage) 100 % → 50 %, 102 (cortile) 89 % → 57 %, 587 (kitchen)
100 % → 66 %, 103 100 % → 64 %.

The mechanism, in the hub log (6 h, three nodes): `native crop miss
reason=no-registry-entry` went from **zero lines before 14:00 to 20 980 in the
following two hours**, and the refusal line D419 added
(`native crop refused`, `handle-expired`) fired **79 times** in the same
window. Both are the same event. `register()` sweeps entries past the bound,
so an ask that arrives after the sweep — the common case, since every
registration on a busy node sweeps — finds no entry, is classified `unknown`,
and is logged as a miss with `handleAgeMs=null`. The one number D419 promised
would make the bound tunable undercounted it by 265×, and its author, reading
79, concluded the bound was refusing "the tail the operator judged
meaningless". The asks it refused were the key-frame captures of a quarter of
the fleet's tracks.

Why so many asks land past 10 s at all is a second, pre-existing fact that
the new `pipeline-analytics frame lag` instrument (D417) made countable the
same afternoon: `busLagMaxMs` ≥ 5 s in 36 % of all 30 s windows, `busLagMinMs`
≈ 0 in 94 % of them (a burst-drain, not a clock offset), tracking hub-main's
own event-loop p99 (426–608 ms in the 14:00–14:20 buckets, 127–168 ms in the
quiet 14:30–15:00 buckets, 324–414 ms in 15:10–15:50, with 167/173 windows
starved in the worst bucket and 0/105 in the best). A frame handed to
analytics 10–40 s after decode cannot be asked for inside a 10 s bound; under
a 30 s bound it still can, and before D419 it was — the registry's 4 096
entries held ~30 s on this cluster, which is why the same asks did not miss on
2026-09-08.

Two things were tried first. Raising the constant to the worker's tile TTL
(30 s) was committed at 15:58 and deployed at 15:59 to all
three nodes; it removes the loss but leaves the instrument that hid it. The
alternative of removing the sweep — keeping expired entries until capacity
eviction so every late ask meets a live entry and is refused with an age —
was rejected: it restores the 4 096/4 096 pinning and the lease RAM D419 was
written to release.

## Decision

**A native lease is bounded by the age past which the worker provably holds
nothing — `NATIVE_TILE_TTL_MS`, 30 s — and never tighter.** A bound tighter
than the worker's own retention refuses asks the worker could have answered;
the only measurement that can justify one is the hit rate in the band it would
refuse, and that measurement must exist before the bound is lowered.

**A handle the registry swept by age is still a refusal.** `NativeCropRegistry`
remembers what the age bound dropped — `deviceId` and registration clock, in
a ring bounded like the live map — and a later `lookup` answers `expired`
with a real `ageMs`, never `unknown`. `unknown` is reserved for a handle the
registry never held or lost to capacity or to an explicit release: those are
different findings with different fixes, and folding a refusal into them is
how 20 980 refusals read as "79".

**A media-clock anchor belongs to a dial, not to a worker.** A warm re-attach
reuses the decode worker and re-dials inside it; the new dial's pts restarts,
and an anchor kept across it dated every later frame of camera 111 on
`agent-a` 268 655 ms in the past for the rest of the session
(`frameAge.avg` constant, `captureLagMaxMs=271 374`). `mediaClockForDial`
re-anchors on the first frame of each dial.

## Consequences

- The refusal line is now the count of late asks, whichever side of the sweep
  they land on. `no-registry-entry` returns to meaning what its doc says —
  never registered, or evicted by capacity — and its rate should return to the
  ~7 500/day of 2026-09-05. If it does not, the cap binds again and the answer
  is still not a bigger number.
- A second ask for a refused handle is refused again (previously `unknown`).
  The worker-side lease is released exactly once, on the first drop.
- The swept ring costs one more map of ≤ 4 096 small records per node. Past
  that window (≥ 60 s at the busiest measured rate) a refusal degrades to
  `unknown`; an ask that late is not a question about the bound.
- The per-dial anchor changes nothing for a worker that dials once. A
  re-dial's first frame is dated NOW, the same rule as the first dial (D411
  follow-up: the served span does not reach the worker, so 0 is the honest
  pre-roll).
- **Left open, measured, not fixed here.** hub-main's event-loop congestion is
  the source of the 10–40 s delivery lag that every downstream bound has to
  survive; it predates today (loop p99 105–450 ms all morning at 1.9–2.1 GB
  heap) and it is what "tracce inconsistenti" measures — position gaps of
  6–9 s inside tracks, `lastFrame` 4–8 s older than the track's end on a third
  of tracks, `toBuffer miss` ×6. The caller-side defects D419 named (the ~1 Hz
  detail dispatcher re-asking a frozen handle; `persistKeyFrames` and
  `offerGroupShot` without `staleAfterMs`) are still open; the `capture queue
  full` lines show `unexpirable` 0–4 on a 24-deep lane, so they were not the
  wedge this time.

## Enforcement

`packages/addon-pipeline/src/session-decode/__tests__/native-crop-lease-age.spec.ts`
pins the 30 s bound and that a swept handle answers `expired` with its age
while a capacity eviction stays `unknown`. `media-clock.spec.ts` pins that a
new dial re-anchors and that the old anchor would have reproduced the 268 s
back-dating. Both were run red before the change and red again with the
change removed. Nothing checks the hub-main lag itself beyond the
`pipeline-analytics frame lag` line (D417); the `starved` verdict rate is the
number to read before blaming any downstream bound.
