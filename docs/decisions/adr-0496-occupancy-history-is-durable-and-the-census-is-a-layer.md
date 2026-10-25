---
id: D496
title: Occupancy history is DURABLE, and the census is a layer of its own
status: proposed
date: 2026-09-14
supersedes:
applies-to:
  - packages/types/src/types/overlay-layer.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/zone-analytics-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/widgets/OccupancyHistoryChart.tsx
  - packages/ui-library/src/composites/detection-overlay.tsx
---

## Context

Two complaints turned out to be the same shape.

**"The occupancy history only goes back an hour."** It was served from a
60-minute in-memory ring that dies with the process. The chart's presets —
`5m / 30m / 1h` — existed to hide that horizon, not to answer a question; nobody
asks how busy a driveway was in the last five minutes, they ask about last
night. Meanwhile the long-term store had been writing `occupancy` rows for every
camera the whole time: ~60 bytes per (camera, scope, 5-minute bucket), capped at
a year. **Nothing read them.**

**"I still can't see the stationary objects."** The switch was wired, `isStill`
was fixed to read `idle`, the admin UI was rebuilt — and still nothing. Because
when the evidence ledger promotes a parked object, `birthStationaryFromEvidence`
calls `processor.dropTrack()`: the tracker is told to FORGET it, which is the
entire point (it stops re-spawning tracks and events). From that instant the
object is not a detection at all. A switch that filters DETECTIONS on
`movementState === 'idle'` can only catch the narrow window between the tracker
calling a track idle and the ledger promoting it away — measured on device 102,
28 of 235 tracks in 24 h ever reach `idle`, and the ones that park leave the
stream shortly after.

Both were a reader pointed at the wrong source while the right one already
existed.

## Decision

**History comes from the long-term store.** `pipelineAnalytics.readLongTermSeries`
is the read surface for every chart that used to be served from a RAM ring. The
occupancy chart reads it, its presets are `1h / 6h / 24h / 7d` (5 minutes is the
bucket, so a sub-hour window is one or two columns and reads as a fault), and it
plots `max` per bucket — what the operator reads off an occupancy chart is "how
many were here", not a sum that scales with the frame rate.

`zoneAnalytics.getCameraHistory` / `getZoneHistory` / `getUnzonedHistory` are
DEPRECATED. The ring stays only until they go, nothing else reads it, and the
baseline sampler's gate no longer does — it keeps one timestamp per device.

**The scope grammar lives in `@camstack/types`.** `occupancyScope(zoneId?,
className?)` and `parseOccupancyScope` are shared by the writer in the addon and
every reader. A class dimension was added as NEW scopes (`'|className'`,
`'zoneId|className'`) beside the aggregates, which keep their exact meaning, so
no chart already drawn changes what it reads.

**The census is a LAYER, not a filter.** `OverlayLayer` (`motion | objects |
discarded | stationary`) is the shared vocabulary, and its docblock states which
of the four does not come from the detection stream. `DetectionOverlay` draws
the census from `stationaryObjects` — normalised rows of the occupancy snapshot,
fetched by `useStationaryOverlay` — under the existing stationary switch.

## Consequences

- The occupancy chart survives a restart and answers about last night. It also
  stops pretending to be live: the poll is 30 s–5 min by preset, because a
  5-minute bucket cannot move faster than that.
- A census box is drawn dashed and dimmer than a detection, labelled with how
  long the object has been there — the only question anyone asks about a parked
  car, and the one a detection box can never answer.
- Absence is preserved end to end: an unfetched census is `undefined` and draws
  nothing rather than claiming an empty lot; a bucket that does not exist is not
  plotted as zero; a class nobody saw writes no row.
- The per-class scopes multiply the LTS write rate by what is actually in the
  scene, not by the combinatorial product — a parking zone that never sees a
  person never writes that scope at all.
- The viewer's `useCameraOccupancyHistory` is gone. It wrapped the deprecated
  ring, no component called it, and its docblock still told the next reader that
  durable history did not exist.

## Enforcement

`detection-overlay-movement.test.tsx` pins that the census draws with NO
detections on the frame, that both switches govern it, and that an unfetched
census draws nothing — verified to fail when the layer is removed.
`lts-read-surface.spec.ts` pins that the addon imports the scope grammar from
`@camstack/types` rather than re-declaring it, and that an aggregate scope is
never parsed as a class scope. `zone-analytics-provider.spec.ts` pins that the
class split does not change what the aggregate scopes mean. Nothing guards that
a NEW chart reaches for the deprecated ring instead of the long-term read; the
cap docblock says "do not add a fourth caller", and that is review only.
