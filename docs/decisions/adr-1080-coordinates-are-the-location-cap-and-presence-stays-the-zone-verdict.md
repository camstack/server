---
id: D1080
title: Coordinates are the location cap; presence stays the zone verdict
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/capabilities/location.cap.ts
  - packages/types/src/capabilities/presence.cap.ts
---

## Context

`presence.state` is a zone verdict (`home`, `not_home`, a zone name) the source derived. It is typed to the `Presence` device type, has no recorded series, and its `gps` object is nullable as a whole, so it is not a path a history can record. A car has coordinates and no zone.

## Decision

`location` is a generic, device-native cap bound on every device type: latitude, longitude, accuracy, heading, speed and the time of the fix, all `null` when unknown. Both coordinates are null together or set together (`locationFix` drops the pair if either is missing or out of range). Latitude, longitude and speed are recorded with a 0.0002 degree (about 22 m) deadband, on by default with the per-device history opt-out. The building's own position stays the `system` site location; `presence` stays the verdict.

## Consequences

A position is a privacy-relevant series and is recorded by default, with the existing opt-out. A dense track for a moving tracker would be a producer series later, not a change to this cap. A geofence condition in the automation vocabulary is separate work. A Home Assistant device_tracker mapping lands with the first provider.

## Enforcement

`packages/types/src/capabilities/__tests__/location.cap.spec.ts` (bounds, the pair rule, the history catalog holds exactly latitude, longitude and speed). Guards: `check-cap-history-declared`, `check-runtime-state-durability`, `check-export-coverage`.
