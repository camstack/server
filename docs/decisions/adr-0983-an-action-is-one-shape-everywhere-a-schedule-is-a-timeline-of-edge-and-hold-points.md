---
id: D983
title: An action is one shape everywhere — a vocabulary action on a target — and a scheduler is a timeline of edge and hold points
status: proposed
date: 2026-10-31
supersedes:
applies-to:
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/when.ts
  - packages/types/src/device/cap-vocabulary/types.ts
  - packages/system/src/builtins/core-blocks/actions-service.ts
---

## Context

The operator asked for schedulers: an entity that performs actions over the
day, on a single device or on a whole domain ("open the covers", optionally in
one room), with the same conditions an automation has.

Looking for where a scheduled action would live showed that "an action" already
has four shapes that only partly agree:

- an automation step (`AutomationCapStep`: `deviceId: number | number[] | {$var}`
  plus a raw `cap` / `method` / `args`);
- an Action entry (D954), whose steps are the same `ActionStep` but are picked
  through a different UI;
- a notification rule's action sequence, with its own form;
- the vocabulary (D920), which names `cover.open` with a phrase and its args,
  but which the persisted step does not reference — the step stores the cap
  method, not the vocabulary id.

None of them can say "every cover in the living room": a target is a list of
device ids frozen at save time, so a device added later is silently left out.
None of them knows what an action LEADS TO, so "keep the cover open from 08:00
to 20:00" cannot be expressed — only "open it at 08:00", which a person closing
it at 09:00 undoes for the rest of the day. And the `schedule` leaf of the
`when` tree (D980) is a cron string only: no sunrise or sunset, no one-shot
date, no site timezone, no catch-up after a restart.

Building the scheduler on top of these would have added a fifth action shape.
The operator rejected that: the action concept is unified in data and in UI
first, and "schedule" is one more way to say WHEN, inside it.

## Decision

**One action shape.** Every place that performs an action — automation steps,
Action entries, notification sequences, scheduler points — stores the same
`ActionStep`: a vocabulary action id (`cover.open`) with its args, applied to a
**target**. A target is one of:

- `devices`: device ids the operator picked;
- `domain`: every device that offers the step's vocabulary action, optionally
  narrowed to one device type and one room, **resolved when the step runs** (a
  device added later is included; an empty resolution is logged, never a silent
  no-op). The operator picks the action from the same vocabulary the
  single-device picker uses, then the domain — never a raw cap name;
- `var`: a `$var` resolved from the run's scope.

One UI building block edits it (action picker + target picker), shared by every
page that edits actions; the viewer ports the same block. The scheduler editor
is a tab of the admin Build page, beside Automations and Actions.

**An action declares what it leads to.** A vocabulary action may carry an
`effect`: the cap status field and the value it produces (`cover.open` →
`state = 'open'`, `switch.on` → `on = true`, `brightness.set` → `brightness =
<arg>`). Only an action with an `effect` can be HELD.

**Schedule is a time spec.** One `TimeSpec` — clock time, sun event
(sunrise/sunset/dawn/dusk) ± offset, or a one-shot date — evaluated in the
site timezone. **No cron**: a cron expression has no position on a day's
timeline, so neither the editor nor the conflict check can tell which hold
windows overlap. The `when` tree's `schedule` leaf gains the `TimeSpec` form;
its existing `cron` form stays readable for automations already saved, and
the editor no longer offers it. The scheduler's points use `TimeSpec` only.

**A scheduler is profiles of timeline points.** A scheduler has one or more
profiles; each profile has a set of weekdays and an ordered list of points on a
0–24 h timeline. The scheduler AND each profile carry a manual `enabled` flag
and an optional `activeWhen` — a `when` state tree (facts only, no event
leaves). A profile is in force when the scheduler and the profile are both
enabled, both `activeWhen` hold, and today is one of its days. Profiles may
share days; when two are in force at once, the first in the scheduler's order
wins (a "holiday" profile placed first, active on a variable, overrides the
weekday one), and the editor warns about two profiles sharing a day with no
`activeWhen` to tell them apart. `activeWhen` is level-triggered: turning false
suspends the profile's hold (nothing is reversed) and skips its edge points
(recorded `inactive`); turning true inside a hold window applies the hold. A point has a
`TimeSpec` (clock or sun), its action steps, optional conditions (the same
`when` state tree, including `expression`, and scheduler variables), and a mode:

- `edge`: run once at the point's time;
- `hold`: from this point until the next point of the profile, keep the
  actions' effects true. On drift the hold re-applies, with a bounded number of
  attempts per window; giving up is logged and recorded. A manual change during
  a hold is configurable per point: `respect` (default — the hold is suspended
  until the next point) or `reassert` after a grace delay. A change CamStack
  itself made is never treated as manual;
- `release`: end the current hold without acting.

**Missed runs.** An `edge` point missed while the hub was down runs if it is
late by less than the scheduler's `maxLateMs`, otherwise it is recorded
`missed`. A `hold` window has no missed state: on start the scheduler
reconciles every profile to the window it is in now.

**Conflicts.** Each scheduler has a priority. When two holds target the same
device with different effects at the same time, the higher priority holds and
the other records `overridden`; the editor shows the overlap before saving.

**Where it runs.** On the hub, in core-blocks next to the actions service
(D954), which already owns action records and the run ledger. One timer for the
next point across all schedulers (a time-ordered queue), not one timer per
point; holds wake on state-mirror changes of the devices they target, never by
polling; domain targets are cached and invalidated on device-registry changes.
Every point outcome (`done`, `missed`, `inactive`, `condition-false`, `failed`, `held`,
`gave-up`, `overridden`, `suspended-manual`) goes to the existing runs ledger.

## Consequences

- The existing steps migrate: a stored `cap` step with a device list becomes a
  `devices` target; a step whose cap method matches a vocabulary action gains
  its id. A step with no vocabulary match stays valid as a raw cap call (the
  escape hatch) and cannot be held. The migration is tested with a marked
  field (the old shape must be readable until every store is migrated).
- The vocabulary gains `effect` entries; an action without one is edge-only in
  the UI, never a hold that silently does nothing.
- Sun times need a solar calculation in `@camstack/types`; the private one in
  post-analysis's scene condition resolver moves there and both use it.
- The site location and timezone become a dependency of the scheduler; a site
  without a location cannot save a sun point (refused with a reason, not a
  point that never fires).
- The composite-device editor is NOT part of this: a domain target is a
  property of the action, not a device.

## Enforcement

- Zod schemas in `@camstack/types` are the only definition of `ActionStep`,
  `ActionTarget`, `TimeSpec` and the scheduler record; the admin UI and the
  viewer infer from them.
- Specs: target resolution (domain + room, empty resolution logged), the time
  spec over DST changes in the site timezone, catch-up under/over `maxLateMs`,
  hold re-apply bounded, manual override `respect` vs `reassert`, priority
  conflict, migration of a marked legacy step.
- Nothing yet stops a page from hand-rolling an action picker: review only,
  until a guard lists the shared block's importers.
