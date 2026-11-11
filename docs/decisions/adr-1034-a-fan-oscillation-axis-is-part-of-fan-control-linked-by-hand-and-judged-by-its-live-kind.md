---
id: D1034
title: A fan's oscillation axes are part of fan-control, linked by hand in Customize, and a union field is judged by its source's live kind
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/types/src/capabilities/fan-control.cap.ts
  - packages/types/src/capabilities/fan-presets.cap.ts
  - packages/types/src/capabilities/customize-spec.ts
  - packages/types/src/capabilities/customize-catalog.ts
  - packages/types/src/composition/field-kinds.ts
  - packages/types/src/composition/state-fields.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/types/src/composition/evaluate-field.ts
  - packages/types/src/composition/customize/scalar-compile.ts
  - packages/types/src/device/schema-fields.ts
  - packages/system/src/builtins/core-blocks/fan-link-forward.ts
  - packages/system/src/builtins/core-blocks/fan-presets-service.ts
  - packages/system/src/builtins/core-blocks/composition-sources.ts
  - packages/system/src/builtins/device-manager/field-ownership.ts
  - packages/system/src/kernel/device-call-redirect.ts
  - packages/addon-admin-ui/src/components/device/customize/table/customize-rows.ts
  - packages/addon-admin-ui/src/components/fan-presets/**
---

## Context

A fan that oscillates on two axes (the Home Assistant Dreo fan "Ventilatore
studio", device 3370 under container 3360) exposes each axis as a separate
device: swing switches (3361, 3362), angle and sweep controls (3364–3369) and a
select for its 3D preset (3375). `fan-control` had one `oscillating` boolean and
no angle, so none of this reached the fan, and fan presets were a list of
action steps captured from the fan's siblings.

The first attempt mapped the siblings to axes from their Home Assistant entity
names. It was rejected: a name is a vendor's label, it differs across
integrations and languages, and a wrong guess silently drives the wrong motor.

The angle controls are `numeric` and the preset select is `select`, but the
value a Customize link reads is `control.value`, whose schema is a union of
scalars. The validator could only wire a field of one declared kind, so a
`control.value` source could not be linked at all. Mirror fields (a numeric
copy and a string copy of `value`) were rejected as a second copy of the same
value.

## Decision

**The axes are fan-control state.** `fan-control` carries
`oscillationAxes.{horizontal,vertical}` (`oscillating`, `angle`, `sweepFrom`,
`sweepTo`, and the `min`/`max`/`step` limits) and the method
`setOscillationAxis`. A provider may feed them natively; otherwise the operator
links each one BY HAND in Customize. Nothing is inferred from entity names.

**A link is a `replace` target on the fan's own cap** (D984 amended: the
`overridable` allow-list now names the eight axis fields and `preset`). The
angle link also carries the axis limits, read from the same linked control's
`min`/`max`/`step`, so the limits are the source's, never guessed. The targets
name their Customize section (`target.section: 'oscillation-axes'`); the table
lists a target in the section it names, else the one its cardinality implies.

**A write follows the link.** `setOscillationAxis` and `setPreset` on a fan
with a linked field are redirected (the D963 device-call redirect) to the
linked source: `switch.setState` for an `oscillating` link,
`control.setValue` for an angle, a sweep or the preset. A numeric value is
checked against the control's live range and a preset against the select's
live options (`out-of-range`); a gone, unread or failing source is
`source-gone` / `source-unknown` / `source-call-failed` (the D967 vocabulary,
here on an existing device — D967 amended), each logged with
`tags: { deviceId }`. A call that mixes linked and unlinked fields is refused
(`axis-not-linked`), never half-applied. A covered method the provider does not
implement still asks the redirect, and an unredirected call names the missing
method.

**A union field is judged by its source's live kind** (D659 amended). A field
whose schema is a union of scalars is wireable; its member kinds are
enumerated. At save the source's live kind (from its current state) must be one
the target accepts, else `source-kind-mismatch`. At read time a value of
another kind evaluates to `null`, logged with the device tag — never coerced.
The admin pickers offer a union field under its live kind.

**A fan preset is a desired fan-control state** `{speed?, preset?, direction?,
oscillationAxes?}`, applied through the fan's own fan-control methods (so a
linked field follows its link), in the order preset, speed, direction, then one
`setOscillationAxis` per axis. Each field reports `applied`, `failed`,
`refused` or `not-run`; apply stops at the first field that did not land.
Capture reads the fan-control state and omits an unknown reading, naming it
(D393). The action-source ids `fan-preset:<deviceId>/<presetId>` are unchanged.

## Consequences

- Prod had no fan presets, so the step-list shape was dropped without a
  migration. A stored step-list preset would be refused by the schema.
- `availablePresets` is not yet fed from a linked select's options (an array is
  not a composable scalar); `setPreset` checks the options at call time, so a
  wrong preset is refused, but a picker does not list them.
- The summary `oscillating` is not rewritten from the axes.
- While the redirect is installed, `setOscillationAxis` and `setPreset` appear
  on every fan-control provider; on a fan without a link and without a native
  implementation the call fails naming the method.
- A union source with no current value has no live kind: the save is accepted
  (an unread fact is not a mismatch, D315), and a later value of the wrong kind
  is caught at read time — the field reads `null` and the line is logged.

## Enforcement

- `fan-axes-union.spec.ts` and `fan-axes-replace.spec.ts` (types): prod-shaped
  fixtures for 3361/3362/3364–3369/3375 — union enumeration, save-time
  `source-kind-mismatch`, read-time `null`, compile of the limits companion.
- `fan-link-forward.spec.ts` and `capability-registry-device-call-redirect.spec.ts`
  (system): the forward, its range and options checks, the typed refusals.
- `fan-presets-service.spec.ts` (system): apply order, per-field outcomes, stop
  at the first failure, capture omissions.
- `composition-sources.spec.ts`, `field-ownership.spec.ts` (system);
  `live-wireable-catalog.spec.ts`, `customize-rows.spec.ts`,
  `fan-presets-model.spec.ts`, `FanPresetDialog.spec.tsx` (admin-ui).
- `check-customize-apply-add.ts` keeps every `replace` on the cap's
  `overridable` list.
