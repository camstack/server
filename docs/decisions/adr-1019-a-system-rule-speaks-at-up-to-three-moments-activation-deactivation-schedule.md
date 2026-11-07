---
id: D1019
title: A system rule speaks at up to three moments — activation, deactivation, schedule
status: accepted
date: 2026-11-07
supersedes:
applies-to:
  - packages/types/src/notification/system-event-delivery-modes.ts
  - packages/types/src/notification/system-event-classes.ts
  - packages/types/src/notification/system-event-summary.ts
  - packages/addon-post-analysis/src/notification-center/evaluate-and-enqueue.ts
  - packages/addon-post-analysis/src/migrations/system-event-delivery-modes.ts
---

## Context

A `device-events` / `system` rule had ONE delivery: a message per edge (instant,
D906: every class heard both its bad and its recovery edge) or a scheduled
state summary (D647), never both. An operator who wanted "tell me when a camera
goes offline, and send me a summary at 18:00" needed two rules over the same
kinds; one who did not want the "back online" noise could not drop it, because
D906 widened every instant rule to the whole class on load and on every write.

## Decision

`systemEventDelivery` gains a third variant, `{ mode: 'modes', onActivation,
onDeactivation, onSchedule?: { schedule, grouping } }`, and the rule speaks at
every moment it enables:

- **activation** — the bad edge of each selected class and every single-edge kind;
- **deactivation** — the recovery edges of the classes of the selected kinds
  (derived, never stored per kind);
- **schedule** — the D647 state summary, with D698's grouping (`rule` | `section`).

`systemEventDeliveryModesOf` is the one reader; the legacy `instant` / absent
(both edges, D906) and `summary` shapes stay parseable and read through it, and
the store rewrites them to `modes` on load and on every write. `instantKindsOf`
is what the engine asks: a match outside it is held for the summary when the rule
has one, and otherwise dropped, said (`excludedByDeliveryMode`). A NEW rule is
written `onActivation: true, onDeactivation: false`; an EXISTING rule keeps what
it did (migration `pipeline-analytics/2026-11-07-system-event-delivery-modes`:
instant becomes activation plus deactivation when its kinds have a recovery edge,
a summary becomes schedule-only with the same schedule object, so the scheduler's
schedule hash — and its armed window — does not move).

The validator refuses a rule with every mode off (`no-mode`), deactivation alone
over kinds that never clear (`no-instant-kind`), and a schedule on the alarm or a
mixed rule. The rule's own active-hours `schedule` and `actions` are refused
only on a schedule-only rule; beside an instant mode they belong to the instant
sends and the summary ignores both.

Amends D647 (the delivery shape), D698 (grouping moves into `onSchedule`) and
D906 (deactivation is optional on a rule that says so; a rule that never said
keeps both edges).

## Consequences

- The installed viewer parses `systemEventDelivery` with a strict union: a hub
  that stores `modes` before the viewer learns the variant drops those rules from
  its list. The viewer's parse ships first.
- The cluster `alertNotifyRecovery` setting still silences battery and
  consumable recoveries whatever a rule asks.
- A reminder (`alertRenotifyMinutes`) is unchanged.

## Enforcement

`delivery-modes-engine.spec.ts` (what the engine sends per combination),
`system-event-delivery-modes.spec.ts` in `types` (reader, `instantKindsOf`,
validator) and the migration's fixture spec (every production rule decides the
same before and after, kind by kind, schedule hash included).
