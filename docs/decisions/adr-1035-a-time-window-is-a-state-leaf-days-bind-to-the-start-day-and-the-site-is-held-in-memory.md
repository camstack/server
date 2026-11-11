---
id: D1035
title: A time window is a state leaf — days bind to the day it starts, the site is held in memory, and a sun window without a location is unknown
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/time/time-window.ts
  - packages/types/src/automation/when.ts
  - packages/types/src/automation/condition-eval.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/step-condition.ts
  - packages/types/src/automation/when-site.ts
  - packages/system/src/builtins/core-blocks/step-condition-door.ts
---

## Context

"Only between 22:00 and 06:00" or "only on weekdays" could not gate another
trigger: `schedule` is an event leaf, a tick, and an `all` of two instants is
never true. The `when` tree (D980) separates events from states, so the missing
piece was a STATE leaf that answers "is the site clock inside this window now".
The hard parts are not the comparison: a window that wraps midnight, what a
weekday filter means for the half that lands after midnight, a clock that
jumps (DST), a sun time on a site that has no location, and a tree made only of
states that has no event to wake it when the window opens.

## Decision

`{ kind: 'time-is', between?: { from, to }, days?: WeekdayKey[] }` is a state
leaf; one of `between` / `days` is required, and a one-date spec is refused (only
a clock time or a sun event repeats daily). It is judged by the pure
`judgeTimeWindow`, built per local date on `occurrenceOn`, so DST needs no case.

- A window whose `to` is not after its `from` wraps to the next local day.
- **`days` names the local day a window STARTS on.** 22:00-06:00 on weekdays is
  inside at 01:00 Saturday (it started Friday) and outside at 23:00 Saturday.
  `days` alone is the whole local day.
- **The site is in-memory state** (D49). A generated block reads
  `system.getSiteLocation` at start and on its reconcile interval, keeps the
  previous value when a read fails, and evaluates from memory only. A sun
  window on a site with no location (a zone-only site) is **unknown**, never
  placed at a guessed sunrise; `not` over an unknown is not to be trusted, as for
  every state leaf.
- **A boundary timer wakes a state-only tree.** `nextTimeBoundaryInMs` walks
  every `time-is` leaf (a short-circuit cannot hide one) and its result joins
  the hold timer, so the tree turns true AT the boundary with no device event;
  it fires on the false-to-true edge and never at start-up when already inside.

## Consequences

`TimeSite` gains an optional `zoneOnly` marker (set by `zoneOnlySite`) so the
judge can tell a placeholder location from a real one.

- **The hub-side step-condition door reads the site per evaluation**, and only
  for a tree that holds a `time-is` leaf. A guard is already a fresh read of the
  state it depends on, so the site is one more: a read that fails is `unknown`
  with its reason, and neither branch runs.
- **A window the site cannot place is refused at save**, with the typed reason
  of `validateTimeSpecForSite` (`sun-needs-site-location`, `unknown-time-zone`):
  `whenSiteIssues` / `recipeSiteIssues` walk the tree and every step guard. The
  scheduler save (`validateSchedulerInput`), the draft validator and the
  automation editor call it. The editor refuses only on a site that ANSWERED; an
  unanswered read does not block a save. The run-time `unknown` stays as the
  backstop for a location removed after the save.
- **The scheduler engine queues a wake at the next boundary** of any `time-is`
  leaf of a scheduler (`activeWhen`, a profile's, a point's conditions) each
  time it reconciles that scheduler, so a hold is suspended and resumed AT the
  boundary rather than at the next device event.

Not covered: the action save (`actions-service`) and the CLI's automation save
do not run the site check; a sun-bounded guard saved there on a site with no
location reads `unknown` at run time, with the reason on the trace.

## Enforcement

`time-window.spec.ts` (judge, DST nights, start-day semantics),
`time-is-leaf.spec.ts` (schema refusals, evaluator, unknown, short-circuit),
`generated-block.spec.ts` (a state-only tree fires once at the boundary, not at
start-up), `step-condition-door.spec.ts` (the guard is judged on the site, a
failed site read is unknown, no site read without a time leaf),
`when-site.spec.ts` and `scheduler.spec.ts` (the save-time refusal and its
paths), `scheduler-engine.spec.ts` (a hold follows a `time-is` `activeWhen` at
both boundaries with no device event).
