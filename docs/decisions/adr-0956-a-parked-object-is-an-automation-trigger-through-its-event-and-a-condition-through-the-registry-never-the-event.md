---
id: D956
title: A parked object is an automation trigger through its event and a condition through the registry, never through the event
status: accepted
date: 2026-10-28
applies-to:
  - packages/types/src/automation/stationary-trigger.ts
  - packages/types/src/automation/condition-eval.ts
  - packages/types/src/automation/recipe.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-event-zones.ts
  - packages/addon-post-analysis/src/pipeline-analytics/boot/build-stores.ts
---

## Context

Automations needed "a car parked in the drive" as a start and as a guard. The
parked-object registry already announces `pipeline-analytics.stationary-changed`
(`appeared` / `departed`), but the event carried no zones, and the registry's
zone membership lives in the occupancy snapshot, not on the entry. The tempting
shortcut is one mechanism for both halves: remember every appear/depart seen by
the automation and answer the condition from that memory. Events are telemetry
(D8): a dropped `departed` would leave the memory saying "parked" forever.

## Decision

The `stationary` TRIGGER reads the event; the `stationary-present` CONDITION
never does. The event now names the zones the box is in (`zones: string[]`),
computed by `computeStationaryEntryZones` with the camera's own
`zoneMembershipMinOverlap` — the one membership rule occupancy, package-drop and
live stamps already share. The condition reads the `zone-analytics` runtime-state
slice (the occupancy snapshot, `stationaryObjects` + each zone's `stationary:<id>`
track ids) through the same `ConditionMirror` every other leaf uses, so it is
memory-only at fire time (D49) and reconciled against the hub. A slice that was
never read is UNKNOWN and fails with that reason; a snapshot with no parked
objects is a definite "no".

## Consequences

A dropped `StationaryChanged` delays or misses a trigger fire and corrupts
nothing durable. The condition's freshness is the snapshot's: it follows the
registry through the provider's own refresh, and a camera whose slice never
updates reads as it last did (the reconcile bounds that to its interval). The
event's `zones` is emitted after two reads, so emits are serialised to keep an
appear ahead of its own depart; a failed zone read emits an empty list and a
tagged warning rather than dropping the event. No capability changed.

## Enforcement

`stationary-event-zones.spec.ts`, `stationary-trigger.spec.ts`,
`stationary-condition.spec.ts`, `stationary-recipe.spec.ts` and the generated-
block spec (`stationary trigger and condition`) fail if the zones, the filters
or the unknown-versus-none distinction are removed.
