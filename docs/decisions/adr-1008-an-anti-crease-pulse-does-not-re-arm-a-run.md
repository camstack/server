---
id: D1008
title: An anti-crease pulse does not re-arm a run, and a run ends at its last real active instant
status: accepted
date: 2026-11-04
supersedes:
applies-to:
  - packages/types/src/expression/builtins.ts
  - packages/types/src/expression/expression-source.ts
  - packages/types/src/composition/evaluate-field.ts
  - packages/types/src/running-state/propose-threshold.ts
  - packages/system/src/builtins/device-history/runs/run-recorder.ts
  - packages/addon-post-analysis/src/notification-center/appliance-cycle-runs.ts
---

## Context

A heat-pump dryer finishes its cycle, drops to standby, and then tumbles for 30 to
60 seconds every ten minutes (anti-crease) for half an hour before it powers off.
`dwell(x >= T, onForMs, offForMs)` cancelled a pending off on any return to the
active side (D933), so every pulse re-armed the run. The operator raised the stop
to ten minutes to survive the pulse spacing, which merged back-to-back cycles
into one run, closed every run about thirty minutes late and fired the finish
notification the same distance late. The threshold proposal (planning#405) made
it worse: it split gaps at the largest log-scale jump anywhere, so a six-hour gap
turned three days into two "runs" and a twenty minute stop.

Rejected: a longer stop (it merges cycles), and a symmetric debounce for both
directions (a pending ON kept alive through a drop to off would be confirmed by the
next blip with the input off).

## Decision

1. `dwell` keeps a pending OFF through a return to the active side until that
   return has held `onForMs`. A shorter return is a pulse: the original deadline
   still fires once the input is off again. A pending ON is still dropped at once.
2. A run ends at the LAST REAL ACTIVE INSTANT: when `dwell` confirms a flip to false
   it reports when the pending transition began, and the `latchedAt` that stamps
   `running-state.since` uses it. The recorder's `endedAt`, the run duration and
   the "after N minutes" of the finish notification therefore exclude the stop
   dwell. A flip to true is still stamped at its confirmation.
3. The proposal treats an episode shorter than 90 s as a pulse (never a run or a
   pause, and it sets the start dwell), caps a pause at 30 min, drops a stretch under
   10 min as no run, and floors the stop by kind (dryer and dishwasher 3 min,
   washer 10 min). A restart within 5 min of an end is two runs.

## Consequences

The finish notification still fires one stop dwell after the end; its facts now
match a run that ended up to 30 min before the announcement. A `latchedAt` that
reads a `dwell` through an own field gets the instant through the evaluation
(`SourceFreshReading.transition`), with no capability change.

## Enforcement

`dwell.spec.ts`, `dwell-since.spec.ts`, `propose-threshold.spec.ts` (the
`heatPumpDryer` fixture: 14 runs; the old 5 W / 30 s / 600 s replays to 10) and
`run-recorder.spec.ts`.
