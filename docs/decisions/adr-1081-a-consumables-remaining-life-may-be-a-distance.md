---
id: D1081
title: A consumable's remaining life may be a distance
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/capabilities/consumables.cap.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/ui-library/src/composites/device-history/history-units.ts
---

## Context

A car's service is due in kilometres, not days or a count, and `consumables` could only say a duration or a count. The history unit set had no length unit, so a series stored in metres could not be shown in km or miles.

## Decision

`remaining.kind` gains `distance`, stored in metres and shown in the operator's length unit. One item has one `remaining`, so a service due by distance and by date is two items. The history unit set gains `m`, offered as km, mi or m, keyed by the stored unit (a series stored in `mm` still offers only `mm` and `in`).

## Consequences

A provider that reports a distance converts to metres first. The Home Assistant export maps a distance remaining to a sensor in metres.

## Enforcement

`consumables-cap.spec.ts`, `consumables-chip.spec.tsx`, `history-units.spec.ts` and the Home Assistant `item-entities` spec.
