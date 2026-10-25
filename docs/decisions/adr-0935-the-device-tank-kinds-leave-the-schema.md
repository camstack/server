---
id: D935
title: The device-tank kinds leave the schema
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/system-event-families.ts
  - packages/addon-post-analysis/src/notification-center/rule-store.ts
---

## Context

[D934](adr-0934-a-consumable-of-every-form-is-one-low-signal-and-one-summary-section.md)
folded every consumable form into `device-consumable-low` /
`device-consumable-normal`, but left `device-tank-low`, `device-tank-full` and
`device-tank-normal` on the enum tail, a read-time remap
(`effectiveSystemEventKinds`), preview section id `tanks` → `consumables`, and
a grep guard so production never emitted the old kinds again.

## Decision

Remove the legacy tail, the remap, the `tanks` section alias and the guard.
Old outbox, history and rule rows that still carry a tank kind may fail Zod parse
— accepted under [D900](adr-0900-the-records-migration-is-closed-no-kind-adopts-and-the-product-carries-no-adoption-code.md);
each reader skips the row with one WARN line and continues.

## Consequences

- Unmigrated rules vanish from the engine until the operator re-authors them on
  the consumable pair.
- History or outbox rows frozen with a tank kind are omitted from list views that
  parse through `NcSystemEventKindSchema`.

## Amended 2026-10-24

The legacy tail, the remap and the guard were deleted; old rows with tank kinds
are skipped when read.

Residue removed: leftover tank episodes, tank subjects, the skip test.
