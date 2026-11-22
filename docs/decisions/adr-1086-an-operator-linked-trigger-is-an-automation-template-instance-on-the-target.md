---
id: D1086
title: An operator-linked trigger is an automation template instance shown on the commanded device, and it never claims the device's state
status: accepted
date: 2026-11-22
supersedes: D1083
applies-to:
  - packages/types/src/template/linked-trigger.ts
  - packages/types/src/template/builtin-automation-templates.ts
  - packages/system/src/builtins/core-blocks/automation-template-instances.ts
---

## Context

"A button press switches this light" had three candidate homes. D1083 put it in
the actuator group: the group owned one automation compiled from its triggers.
The operator dropped that: a group is a composed device, and an operator wants
to open the LIGHT and see what switches it. The two other homes were refused for
reasons that still stand: a composition (D659) is a pure derivation of values
and a toggle cannot be derived; a device link (D1063, `check-no-device-links`)
joins fields, and deriving the light's `on` from a button would claim a value
its own provider owns (D663, D676).

The live need is one automation: a button's short press, channels 1 and 2,
toggles one light. It was an instance of the retired "Buttons → devices"
template.

## Decision

A linked trigger is an ordinary automation made from the built-in template
`builtin:linked-trigger`, run by the existing engine (traces, run mode). It is
shown on the COMMANDED device's Customize tab, found by the template's `target`
input through `coreBlocks.listTemplateInstances({ templateId, deviceId })`; it
is created, changed and deleted through the existing `coreBlocks` create,
update and delete, the template link riding in the recipe. Its sources are
events only (`device-fired`, optionally narrowed by part, event, kind and
payload; or `device-event` of a category); its action is on, off or toggle of a
capability of the target. It COMMANDS the target and never claims or derives
its state: that stays with the target's provider.

## Consequences

Nothing new is stored: the link is the recipe's `template` literal, so deleting
the automation deletes the link. There is no follow or derived mode and no
detection source; a thing that must mirror a state is a composition. An
instance of the retired "Buttons → devices" template keeps running (the engine
runs the generated code, not the template) and is flagged `missing-template`.
D1083 is superseded; group triggers are removed.

Amended 2026-11-22: a linked trigger is a CUSTOMIZATION of the commanded
device and has one surface. It is shown, created, changed and deleted only in
the "Triggered by" section of that device's Customize tab, one row per source
device, one automation per source device. Build → Automations, its count and
the global search leave these automations out (`isListedAutomation`); Build →
Custom Device shows the commanded device as a customization row that links to
its Customize tab, sharing the row of a customization block when there is one.

## Enforcement

Specs: the template expands and runs through the generated block for each
action, a non-matching press does nothing, and the list read returns an
instance for its target and never for a source (`generated-block.spec.ts`,
`list-template-instances.spec.ts`). `check-no-device-links` keeps the third
home closed. The single surface is held by `listed-automation.spec.ts`,
`search-items-build.spec.ts`, `composition-rows.spec.ts` and
`TriggeredByTable.spec.tsx`.
