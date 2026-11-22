---
id: D1092
title: "On for a time" is a hold outside the run, and only what it turned on is turned off
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/automation/on-for.ts
  - packages/types/src/automation/codegen.ts
  - packages/system/src/builtins/core-blocks/runs-ledger.ts
  - packages/ui-library/src/composites/duration-parts-input/**
---

## Context

"Motion turns the light on for five minutes" was the built-in template
`builtin:motion-light`: turn on, wait, turn off, as three steps of one run. That
run turned off a light the operator had switched on by hand before the motion,
a second motion during the wait was dropped or queued by the run mode instead of
extending the time, and a hub restart mid-wait left the light on for good. The
linked trigger of D1086 had no timed action at all.

## Decision

A command step may carry `onFor: { seconds }` (`switch.on` only, 1 s to one
day). The step does not wait: it hands the device to a HOLD kept by the
generated block outside the run (`OnForHolds`). At the first event the hold
reads the device: already on, it does nothing and holds nothing; off, it turns
it on and starts the timer. Each later event restarts the timer. At expiry it
turns off only a device it turned on, and a device the operator switched off
meanwhile ends the hold. Holds are written to the automation's EXISTING
run-state document (`reportAutomationRun({ onForHolds })`, two optional fields,
no new store); at block start they are re-armed with the time left, and an
overdue hold is turned off at once. A held "on" exists only as an automation
step: a plain action and a narrow action refuse it.

The linked trigger gains the action "on for", the sources "a field becomes a
value" (motion) and "a camera detected a class", and an optional time window
that applies to the whole automation. `builtin:motion-light` is retired; its
instances keep running and are flagged `missing-template`.

A duration is typed in ONE shared control, `DurationPartsInput` (hours, minutes
and seconds side by side), in the triggers table and in the automation editor's
wait steps. A number with a unit select is no longer written for a duration.

## Consequences

A hold is not a run: it has no trace of its own, only `on-for:` log lines tagged
with the device. A report that names no holds leaves the stored ones alone; an
empty list releases them. `coreBlocks.reportAutomationRun` is now scoped by the
devices of its holds. The time window of a linked trigger covers every source of
that automation. Only `switch.on` can be held until another capability declares
its opposite in `ON_FOR_FIELDS`.

## Enforcement

`on-for.spec.ts` (already on, restart, expiry, operator switch-off, restore,
overdue), `generated-block.spec.ts` ("on for a duration"), `runs-api.spec.ts`
(holds kept, replaced, released), `linked-trigger.spec.ts`,
`DurationPartsInput.spec.tsx`, `TriggeredByTable.spec.tsx`. The schema refuses a
hold on any other action.
