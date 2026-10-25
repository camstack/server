---
id: D702
title: Parked zone membership uses the same engine and bar as live
status: accepted
date: 2026-10-05
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-zones.ts
  - packages/addon-post-analysis/src/pipeline-analytics/zone-analytics-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
---

## Context

Live tracks stamp zones through `ZoneEngine.annotateDetection` (bbox∩polygon /
bbox area ≥ `TrackingSettings.zoneMembershipMinOverlap`). Parked registry
entries used a second path — normalised centroid point-in-polygon with no
threshold — so a car mostly inside a bay flapped between zones when the
detector jittered the box a few pixels across the polygon edge. Raising
`zoneMembershipMinOverlap` fixed live stamps and left occupancy untouched.
Package-drop zone gating shared that centroid path.

## Decision

Parked membership (occupancy census, hydration, package-drop gate) calls the
same `ZoneEngine.annotateDetection` and the same
`zoneMembershipMinOverlap`. `computeStationaryEntryZones` is a thin adapter
over that engine; it does not invent geometry or a parked-only bar. Origin
(live track vs registry vs baseline) must not change the answer for the same
bbox and zones.

## Consequences

- A camera-wide membership bar now moves parked occupancy the same way it
  moves live event stamps. Default remains `0` (any positive overlap).
- Centroid-PIP semantics for parked objects are retired; tests that assumed
  them must use overlap fixtures.
- Per-bay inclusion % via a `stationary` zoneRules stage is still allowed
  later, but it must feed the same engine rather than reopen a second path.

## Enforcement

Unit tests on `computeStationaryEntryZones` assert identity with
`ZoneEngine.annotateDetection` for the same inputs. Review: any new parked
zone attribution that does not call that adapter (or the engine) is a
regression.
