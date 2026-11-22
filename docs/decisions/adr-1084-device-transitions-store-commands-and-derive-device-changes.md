---
id: D1084
title: A device transition store holds only commands, ok or failed; the device's own changes are derived on read from device-history
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/transitions/**
  - packages/system/src/builtins/device-history/transitions/**
  - packages/system/src/migrations/hub/2026-11-22-device-transitions-commands-only.ts
  - packages/types/src/audit/**
  - packages/types/src/capabilities/device-transitions.cap.ts
  - packages/addon-post-analysis/src/notification-center/**
---

## Context

D1022 stored every audited change of a device, and matched a command to the slice
change it caused with a correlator held in the hub mirror: a 30 s confirmation, a
burst-settling rule that decided which command a change belonged to, and an expiry
that wrote `unconfirmed`. The outcomes were five (`confirmed`, `already`,
`unconfirmed`, `failed`, `device`). The machinery was the largest part of the
feature, it needed a tap inside `DeviceStateMirror`, and its answers were wrong at
the edges: a slow cover, a device that reports late, a seam with no completion
signal. The device's own changes were stored a second time, though device-history
already records the same fields.

The first plan moved the ledger into history.db. That cannot be built: history.db
never hosts records (D850); the records engine runs only over events.db and
camstack.db.

## Decision

The transition store holds one row per COMMAND, written when the call completes,
with outcome `ok` or `failed`. Nothing is confirmed, matched, settled or expired at
write time, and `DeviceStateMirror` has no transition tap.

A device's own change is never stored. `listTransitions` merges the stored
commands with changes derived from the raw device-history series of the audited
fields, newest first, under one cursor `<at>.<source>.<id>`. The burst rule that
turns a cover's five raw points into `state closed->open` and `position 0->100`
lives in ONE helper, `device-history/transitions/change-coalescing.ts`, applied on
read; a burst still open is not shown.

The commands stay in events.db with their own retention (`transitionDays`). A
same-file hub migration (`hub/2026-11-22-device-transitions-commands-only`) maps
`confirmed`, `already` and `unconfirmed` to `ok` and deletes the `device` rows,
and refuses (rolls back) when a row would be left without an `ok|failed` outcome.

The Notification Center `device-command` body keys and the `commandOutcomes`
filter shrink to `ok | failed`.

## Consequences

- A command row says the call was made and whether it threw, not whether the device
  obeyed. What the device did is the derived row beside it.
- A device's own change shows only for a field whose cap has a `history` block and
  only inside the raw retention window; before, the ledger kept it for
  `transitionDays`. Raw retention for discrete fields is a separate piece of work.
- A seam that gives no completion promise records `ok` at departure.
- `commandOutcomes` values `confirmed`, `already` and `unconfirmed` in a stored
  notification rule no longer parse; no live rule used them.
- `getTransition` and `listRecentTransitions` answer stored commands only.

## Enforcement

`transitions-service.spec.ts` (merge order, cursor stable across sources, disarmed
by removing the source tie-break), `change-coalescing.spec.ts`,
`history-change-port.spec.ts` (real runtime), `command-recorder.spec.ts`,
`migration-device-transitions-commands-only.spec.ts` (marked row mapped, device
rows gone, rollback) and the migration-ledger guard
`scripts/check-migrations-well-formed.ts`.
