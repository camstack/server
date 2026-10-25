---
id: D917
title: A keyed array records history per item key, and an orphan series is reported, never purged on that judgement
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/consumables.cap.ts
  - packages/types/src/capabilities/device-history.cap.ts
  - packages/system/src/builtins/device-history/capture/capture-engine.ts
  - packages/system/src/builtins/device-history/retention/orphans.ts
  - scripts/lib/cap-history.ts
---

## Context

D915 moved the vacuum tanks (clean water, dirty water, detergent, dust bin)
and the dishwasher's salt and rinse aid into items of the `consumables` cap.
The `vacuum-control` tank levels had been history series (D850); `consumables`
had to answer `history: 'none'`, because a history path was only allowed
through fixed objects and `items` is an array keyed by runtime ids. So the
move silently ended the long-term series of every consumable, while the
operator expects device history ON by default.

Two other shapes were possible. A path with the key spelled in it
(`items[cleanWater].level`) needs one catalog entry per item the code cannot
know in advance, and a new item of a new device would have no series. A
per-item metric key would mint a metric row per item and per device type.
Device history already has a dimension that is exactly "one more instance of
the same measurement": the series SCOPE, used for zone x class occupancy and
per-location storage series.

The move also left series nobody writes: `cap:vacuum-control.*.level` (no
provider ever reported one, so they hold no data on a real hub) and every
series of a device that disappeared. The departure clock purges the second
kind after a week; the first kind waits for retention. The operator asked to
SEE both and delete them by hand, with no automatic purge on that judgement.

## Decision

A cap's `history` block may declare `items: { path, key, label?, fields }`:
one series per (item field, item key), the key `cap:<cap>.<path>[].<field>`
and the item key as its SCOPE. Codegen projects it into
`HISTORY_ITEM_CATALOG`; the guard judges each item field against the ITEM
schema with the same rules as a top-level field. A series' display name is
read at query time from the item's `label` (its key once the item is gone).
`consumables` records `level` (gauge %), `status` (enum) and
`remaining.value` (gauge, unit from the item's `remaining.unit`).

A device series is ORPHAN when its device's departure clock is running
(`device-gone`) or its `cap:` key is declared by no catalog
(`undeclared`). `listOrphanSeries` reports them with their rows per tier;
`deleteOrphanSeries` deletes by id, re-judging each id at that moment and
refusing one that is not orphan. Nothing deletes on this judgement by itself.

## Consequences

- No continuity for the four old tank series: they hold no data (D915), so
  no alias is declared. They are listed as `undeclared` orphans if a hub has
  them, and an admin removes them.
- An item key is a scope: at most 64 items per slice and 128 characters per
  key are captured, the rest counted (`item-overflow`, `item-key-invalid`).
- `undeclared` is judged against the catalogs, not against the device's
  bindings: a device that stopped being bound to a cap whose field is still
  declared is not reported. Asking every device's bindings would add a
  fallible read per device to an admin listing (D49).
- The week-long departure purge still runs; an orphan listing shows the
  device-gone series until then.

## Enforcement

- `item-capture.spec.ts` (capture per item key over the real catalog, deadband,
  reconcile, restart, naming).
- `check-cap-history-declared.spec.ts` (keyed-array rules) and the guard
  `scripts/check-cap-history-declared.ts`.
- `orphan-series.spec.ts` (both reasons, refusal of a live series, re-judging at
  delete time, the per-device deletion line) and `history-query-plans.spec.ts`
  (the per-series count is a primary-key range, D447).
