---
id: D1083
title: A group owns the one automation of its triggers, and may build no device
status: superseded
superseded-by: D1086
date: 2026-11-22
supersedes:
applies-to:
---

## Context

"Buttons → devices" was a built-in automation template: a button press commands
some devices. It stored numeric device ids, could not say what the press did to
a GROUP (toggle decided from the members' state), and a group had no place to
hold the triggers that drive it. A second place to author "a press switches
these lights" next to the group meant two truths about one behaviour.

## Decision

A trigger belongs to the group. An actuator group of type switch, light, fan or
climate stores `triggers` in its helper spec (stable refs, never numeric ids);
core-blocks compiles them into ONE automation block the group owns
(`ownedBy: { kind: 'group', blockId }`), regenerated on save, at boot and when
a device registers. An owned block is read-only everywhere else and says
"managed by <group>". A trigger only commands the group (or, with
`output: 'none'`, its members); there is no timer in a trigger — a delayed off
stays an automation (`builtin:motion-light`).

`GroupHelperSpec.output` is `'device'` (default) or `'none'`. A `'none'` group
builds no device: nothing in the registry, lists, exports or viewer; the owned
block fans out to the members with the same method and arguments. `toggle` there
decides from the members' aggregate state at trigger time (an unknown or stale
member makes it a traced no-op, D49); a `'none'` group with no trigger is
refused at save, since it would do nothing. The loop guard (a trigger whose
action re-enters its own source through the group) applies to both outputs.

The step trace of a command sent to a group names what it did on each member
(`members`, read from the `group-commands` slice); a result that could not be
read is `members: null` with the reason, never `[]` (D393).

"Buttons → devices" is retired: it is no longer shipped, and an existing
instance keeps running, flagged `missing-template`, until
`scripts/hub/migrate-buttons-template-to-group-triggers.ts` converts it (preview
by default, `--apply`, then `--finalize`; it builds the group with
`output: 'none'`).

## Consequences

A group is the one place a press-to-switch behaviour is written. A new trigger
source needs a case in `group-triggers.ts`, the recipe builder and the editor.
The migration converts only a plain switch command per button; anything else is
named and left alone. A change to the generated block code (members in the
trace) means a force-publish of `@camstack/server`.

## Enforcement

`group-triggers.spec.ts` (compile, refusals, loop guard, `none` output),
`generated-block.spec.ts` (owned-block trace, fan-out), the core-blocks specs
for the owned-block refusal, and `migrate-buttons-template.spec.ts`.
