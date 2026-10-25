---
id: D934
title: A consumable of every form is one low signal and one summary section
status: accepted
date: 2026-10-24
supersedes:
  - adr-0642-a-consumable-is-judged-at-each-rules-threshold-and-tanks-notify.md
  - adr-0915-consumables-cap-unifies-wear-supply-and-waste-on-one-slice.md
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/system-event-families.ts
  - packages/addon-post-analysis/src/notification-center/alerts/consumable-routing.ts
  - packages/addon-post-analysis/src/notification-center/alerts/device-alerts.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/**
---

## Context

Evening summaries on 2026-10-24 listed the same dishwasher salt and robot clean
water twice: once under **Tanks** (`device-tank-*`) and once under **Consumables**
(`device-consumable-*`). D915 moved every item into the `consumables` cap, but
D642 still routed `supply` / `waste` through a separate tank notification family.

## Decision

Every form (`part`, `tank`, `product`, `bin`) raises only `device-consumable-low`
/ `device-consumable-normal`. Provider-judged items use subject
`consumable:<deviceId>:<key>` without `consumableLowPercent`. The state summary
has one **Consumables** section, grouped by device. Nothing rewrites stored rows
(D900).

## Consequences

- Leftover `tank:<deviceId>:<key>` rows are closed silently when the item is seen
  on the consumables slice.

## Enforcement

- State summary spec with several consumable kinds → one consumables section.

## Amended 2026-10-24

[D935](adr-0935-the-device-tank-kinds-leave-the-schema.md) removed the
`device-tank-*` legacy tail, the read-time remap and the emit guard; see that
record for how unmigrated rows are skipped on read.
