---
id: D676
title: The customization UI stores nothing — a device's Customize tab edits its ONE composition, its existing authorities and its D648 slot, and shows only controls the backend serves
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/device/customize/**
  - packages/addon-admin-ui/src/components/composition-editor/**
  - packages/addon-admin-ui/src/components/device/tabs/structural-tabs.ts
  - packages/addon-admin-ui/src/components/device/tabs/extensions-section.ts
  - packages/addon-admin-ui/src/pages/CompositionEditorPage.tsx
  - packages/addon-admin-ui/src/lib/customization-routes.ts
  - packages/types/src/composition/composable-caps.ts
  - packages/types/src/composition/customize/**
  - packages/types/src/composition/evaluate-field.ts
  - packages/ui-library/src/composites/extensions/ExtensionsPanel.tsx
covers:
  - packages/system/src/builtins/core-blocks/composition-api.ts
---

## Context

Slices 1, 2 and 2b (D659, D663, D670, D671) built compositions and customizations
API-first. Slice 5 is their operator surface, from mockups the operator approved on
2026-09-28. Reading the code against the mockups showed that several mockup controls
had no backend: a Type select (`setType` is re-stamped by `registerDevice`, D663 open
item 4), forwarded commands and "Prova" (slice 3), "Convert to code" (slice 4), a
composed `motion.detected` formula (superseded the same day by the camera-sensors
bridge, D672), a `for(cond, ms)` builtin (it does not exist), a flat fleet-wide field
list (each device's fields cost a `getBindings`, measured up to 5.24 s). And four
things the UI needs did not exist: which caps a type can be GIVEN, unit conversion
inside a composition, the doorbell builder outside `@camstack/system`, and a way to
show one Extensions slot.

## Decision

The Customize tab (structural, every device type, admin-only) and the composition
editor store nothing. A preset is a pure builder of one feature merged into the
device's ONE customization block (create / update with `expectedUpdatedAt` / delete);
identity writes `setRole`, `setName`, `setDisplay`; links are the D648
`linked-devices` slot through `ExtensionsPanel`; "Motion from…" writes the D672
bridge's own authority (`setCameraSensors`). A control is rendered only when its
backend exists and applies to the device: availability comes from
`coreBlocks.listComposableCaps` (the validator's own blockers, pinned by a parity
spec), the device's native bindings and the customization. Every read is one of its
answered states (D315): pending, unknown, not-loaded, none, present. A `/build`
custom-device row never links from a guessed id: a composed device's row opens the
editor by block id (its fields ARE the composition); a customization's row opens the
device only from the composer's own answered `deviceId`.

## Consequences

- Type is read-only on a provider device until a durable operator type is decided
  (open). A composed device's type is its composition's target type.
- The Extensions card left the Config tab; `doorbell-source` is no longer edited
  anywhere (shown read-only in the Doorbell card during D671's one-release overlap).
  The cap, both slots and owners stay until slice 6.
- The doorbell preset and the D671 migration share `buildDoorbellCompositionFeature`
  in `@camstack/types`; a preset can never write a shape the migration would refuse.
- `convert()` now works inside every composition (the unit table is the `convert`
  hook of `evaluateCompositionField`); the editor's preview runs that same function.
- The orchestrator's `setCameraSensors` is NOT a framework change: framework
  changes (types, system, ui-library) publish inside `@camstack/server`, but
  `@camstack/addon-pipeline-orchestrator` is a self-contained addon
  (`externals: 'self-contained'`) that publishes and deploys on its own. Release
  order: (1) publish the framework in `@camstack/server`, plus the orchestrator
  addon; (2) update the server on the agents, then on the hub; (3) update
  `pipeline-orchestrator` on the hub; (4) deploy `admin-ui`. An older server
  answers `listComposableCaps` with an error the UI shows as unknown; an older
  orchestrator answers `setCameraSensors` the same way.
- Not built, and not shown: commands and passthrough (slice 3), code fields (slice 4),
  Confirm / Replace camera-sensor modes (CS-2, D673).

- **Amended 2026-10-01** (spec (planning repo: superpowers/specs/2026-10-01-customization-assignments-design.md)).
  The tab still stores nothing and still shows only what the backend serves. Its
  presets became ASSIGNMENT cards on one shared picker (doorbell, motion with a
  mode per sensor — [D673](adr-0673-a-camera-sensor-has-a-mode-and-one-bridge-emits-the-cameras-effective-onboard-motion.md) —,
  battery, consumables, linked devices as a table); Invert and Convert left the
  tab for the transformations plan; the identity is name, room, hidden and role;
  the fields table became "What changes on the device" (removed 2026-10-25:
  the cards already say it; Advanced is a dialog, and Remove lives only in
  that dialog when a block exists); the legacy doorbell box
  and the same-location suggestions are gone, and `doorbell-source` is no longer
  shown anywhere (D671 slice 6). The "Motion from…" panel above is the Motion
  card now. The Enforcement specs this record names were replaced:
  `DoorbellPresetCard.spec.tsx` by the generic event cards
  (`packages/addon-admin-ui/src/components/device/customize/event/`),
  `preset-availability.spec.ts` and `PresetsSection.spec.tsx` by
  `packages/addon-admin-ui/src/components/device/customize/__tests__/assignment-availability.spec.ts`
  and `CustomizeTab.spec.tsx`. The tab's English and Italian text carry no
  decision id (`customize-i18n.spec.ts`).
- **Owed by this record.** `deviceManager.getWrapperActivation` has no consumer
  (the virtual doorbell was its only reader) and the extension slot's
  `activation` field has no producer; both are kept alive by a fake owner in
  `packages/ui-library/src/composites/extensions/__tests__/extensions-panel.test.tsx`
  and the spec defers their removal. A decision to delete `activation`, its card
  branch and that fake owner is owed if no slot adopts it.

## Enforcement

- `composable-caps.spec.ts` — the listing equals the validator's verdict for every
  capability on five device types (disarmed: dropping `wrong-device-type` or
  `has-commands` from the blockers goes red).
- `doorbell-feature.spec.ts` + the migration specs — one builder (disarmed: the
  debounce constant turns both red).
- `evaluate-field-convert.spec.ts` — `convert` inside a composition.
- `customization-models.spec.ts`, `CustomizeTab.spec.tsx` — five states, no write
  while unknown, removal behind a confirm.
- `preset-features.spec.ts` — every preset planned against the real capability table.
- `preset-availability.spec.ts`, `PresetsSection.spec.tsx` — no tile that cannot apply.
- `DoorbellPresetCard.spec.tsx` — the D671 shape, `enabled` as the switch, D356.
- `fields-table-rows.spec.ts` — a composed field shows the composer's report, never the
  snapshot.
- `expression-suggestions.spec.ts` — autocomplete = `EXPRESSION_BUILTIN_NAMES`, with a
  hint in both languages.
- `CompositionEditor.spec.tsx` — four steps, Save only after the server accepted THIS
  draft.
- `structural-tabs.spec.ts`, `extensions-section.spec.ts`, `LinksSection.spec.tsx`,
  `CustomDeviceTab.spec.tsx`, `composition-rows.spec.ts` — a customization's link is
  built only from the composer's own answered device id, never a fleet lookup
  (disarmed: building it from `block.id` instead goes red).
