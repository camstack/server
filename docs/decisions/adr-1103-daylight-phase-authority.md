---
id: D1103
title: One daylight-phase authority decides day or night; a sensor reading is a source, the sun is the fallback
status: accepted
date: 2026-11-26
supersedes:
applies-to:
  - packages/system/src/builtins/core-blocks/daylight/**
  - packages/types/src/time/daylight-phase.ts
  - packages/types/src/capabilities/daylight-phase.cap.ts
---

## Context

"Day" and "night" were the sun everywhere: the `night` preset expanded to a sunset
to sunrise window, and a time spec could only name a sun event. An install whose
cameras switch to IR on a light sensor (a garage, a covered porch) had two
different notions of night. Putting the sensor in each consumer would have given
every consumer its own threshold, its own flapping and its own failure mode.

## Decision

The `daylight-phase` capability (singleton, provided by core-blocks) is the one
answer. Its source is the sun (the default, byte-identical to before) or a sensor
reading with a dark threshold, a hysteresis band and a minimum dwell, judged by the
pure `advanceSensorPhase` in `@camstack/types`. The pure evaluators never call it:
a site carries an optional `phase`, and only a `sensor` phase changes a verdict
(`siteWithPhase`). A sensor that cannot be read is not a measurement: the sun
answers and the reason is logged once, with the device. A time spec of kind
`phase` (`day`/`night` plus an offset in minutes) follows the sensor transition
when there is one and the sun otherwise.

A transition is announced as `daylight.phase-changed`, which is telemetry (D8,
D49): every consumer reads `getPhase` when it judges (the scheduler on each load,
a step guard on each call, a generated block on each site refresh), and the
authority re-judges on a bounded interval and on the watched device's state event,
so a dropped event delays a verdict by at most the re-check.

## Consequences

A consumer that builds its own `TimeSite` must attach the phase or it judges on the
sun. The sun-only sites, named: `notification/schedule.ts` and the recorder's
`addon-pipeline/src/recorder/band-engine.ts` (both build a zone-only site, and both
judge CLOCK ranges only — they take no `TimeSpec`, so a `phase` spec cannot reach
them), and the scheduler's preview and conflict check (`scheduler-service.ts`,
`timeSiteOf` without a phase: a preview shows what the sun would do, the engine
itself reads the authority). A sensor-judged window reports its next change as now
plus the re-check bound, as the next transition cannot be predicted.

A sensor that stops answering keeps its LAST verdict for `SENSOR_HOLD_MS` (30 min):
a failed read changes nothing (D49), so a hiccup flips no phase, emits no event and
does not reset the hysteresis and dwell. Past the hold, or when the sensor never
produced a verdict, the sun answers and the reason is logged.

## Enforcement

Specs: `daylight-phase.spec.ts` and `daylight-evaluators.spec.ts` (types),
`daylight-phase-service.spec.ts`, `scheduler-daylight.spec.ts`,
`step-condition-door.spec.ts` (system), and the generated-block shim spec. No guard.
