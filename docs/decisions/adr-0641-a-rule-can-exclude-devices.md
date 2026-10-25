---
id: D641
title: A rule can exclude devices, and each scope axis is ONE field — All, Only these, or All except these
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/device-scope-guard.ts
  - packages/addon-post-analysis/src/notification-center/device-prune.ts
  - packages/addon-post-analysis/src/notification-center/rule-test-plan.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-mode-coverage.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-arm-guard.ts
  - packages/addon-admin-ui/src/pages/system/rule-scope-model.ts
  - packages/addon-admin-ui/src/pages/system/RuleScopeField.tsx
  - packages/addon-admin-ui/src/pages/system/notification-class-scope-field.tsx
  - packages/addon-admin-ui/src/pages/system/class-picker-items.ts
  - packages/addon-admin-ui/src/pages/system/notification-rules.helpers.ts
---

## Context

A rule could say "only these devices" (`conditions.devices`) and nothing else.
"Every camera except the garage" had to be written as the list of every other
camera — which silently stops covering the next camera added. System rules
already had an exclusion (`systemEvent.excludeDeviceIds`, D636); detection,
sensor, occupancy, sound and package rules did not.

The first design (operator approval 2026-09-26) added the exclusion as a second
picker shown only while the include list was empty. The operator then revised
the editor: the classes already had the same pair (`classes` /
`classesExclude`), drawn as two unrelated fields far apart, and "a combination
does not exist" — nobody means "only these, minus those". So each axis became
ONE field with a pre-selector.

Rejected alternatives:

- **Reuse `valueType: 'deviceIdList'` for the new descriptor.** The shipped
  viewer renders EVERY `deviceIdList` descriptor as the `devices` picker, so a
  pre-D641 phone would have drawn the include list twice and written an
  exclusion into `devices` — the silent corruption `condition-field-keys.ts`
  exists to prevent. A new member, `deviceIdExcludeList`, is DROPPED by the
  viewer's per-item catalog parse instead: missing, never wrong.
- **A stored `mode` field per axis.** A switch that can disagree with the lists
  under it is worse than no switch (D62). The mode is derived: include
  non-empty → Only; else exclude non-empty → Except; else All.
- **Merge `devicesExclude` into `systemEvent.excludeDeviceIds`.** The two are
  judged on different subjects (a detection's camera and sensor vs a system
  event's device, with its family rules). They stay separate; the hub refuses
  `devicesExclude` on a `system-event` rule.
- **Drop a legacy rule's second list on save.** A read that destroys is D49's
  failure. A rule carrying both opens in Only, and a notice names the
  exclusions and offers "Remove exclusions"; a save keeps them until then.
- **Prune the LAST excluded id by keeping it and disabling the rule** (D633's
  include rule). Removing an excluded id widens the rule only by a device that
  can no longer fire, so it is always removed — the last one deletes the key.

## Decision

`conditions.devicesExclude?: number[]` (`min(1)`) applies wherever `devices`
does (immediate, track-end, device-event, package-event — so occupancy and sound
too) and is judged on the SAME subject ids at the same place
(`deviceScopeExcludes`, the row-by-row complement of `matchesDeviceScope`): a
per-camera sensor row is excluded by its camera or by the sensor; a linked set is
excluded by its sensor or when every row camera is; a camera that only LINKS a
sensor excludes nothing. The engine fails `devicesExclude` by name.

Editors present each scope axis — devices, and detection classes — as ONE field:
"All | Only these | All except these" over ONE picker. `devices`/`classes` is
Only, `devicesExclude`/`classesExclude` is Except. The pure model
(`rule-scope-model.ts`, byte-identical in the admin and the viewer) derives the
mode, keeps both lists across a switch, writes only the active mode's list on
save and SAYS what that clears, and keeps a legacy rule's exclusions until the
operator removes them. "All except these" is offered only when the hub serves
the exclusion for the rule's trigger and kind. The class picker is the device
picker's generic core over the class taxonomy, grouped by taxonomy category,
with no "Group by".

## Consequences

- The catalog's wire ids are unchanged (`classes`, `classesExclude`); the one
  field is an editor composition.
- The per-camera stills gates (audio, occupancy) and the linked-camera capture
  gate read the exclusion with the evaluation's predicate, so an excluded
  camera is never photographed for a rule that cannot fire.
- The per-rule Test says when the camera it would use is excluded.
- The admin form no longer carries the scope lists inside `conditions`
  (`splitRuleScopes` / `formScopedConditions`). That also fixes a latent bug:
  clearing the Devices tab of a saved rule used to leave `devices` in the
  saved conditions.
- The alarm coverage (`alarm-mode-coverage.ts`) carries `allDevicesExcept`:
  the ids every unscoped covering rule excludes (the INTERSECTION — one unscoped
  rule that excludes nothing covers everything) minus the ids a named rule
  covers; a named rule covers its list minus its own exclusions, in the arm
  guard too. The arm notification says "all devices except N: names"
  (`alarm.arm.body.allDevicesExcept`) — excluded by the rules, so never in
  `skippedDevices`. The audio watch log names an excluding rule's scope
  `@all-except:<ids>` and logs each excluded camera on that camera.
- Not changed: the clip-retention asks still ask for every camera. It
  over-states and silences nothing.
- The viewer mirrors this in a second step. Until then a phone save STRIPS
  `devicesExclude` — the rule widens to the devices it excluded. Both mirror
  guards carry self-expiring `aheadOfViewer` allowances (`devicesExclude` in the
  rule condition keys, `deviceIdExcludeList` in the valueType enum).

## Enforcement

- `rule-engine-devices-exclude.spec.ts` (detection, per-camera row by camera and
  by sensor, the unowned sensor, the linked set, and "included ⇔ not excluded"
  on every per-camera row); the stills gates in `sensor-linked-evaluation`,
  `occupancy-media` and `audio-rule-media` specs.
- `device-scope-guard.spec.ts` and `nc-actions.spec.ts` (both save routes).
- `device-prune-exclude.spec.ts`; `rule-test-plan.spec.ts`.
- `rule-scope-model.spec.ts` (derive, switch, save projection, legacy both),
  pinned byte-identical with the viewer's copy by
  `scripts/check-device-selection-in-sync.ts`; `notification-rule-scope.spec.tsx`
  and `NotificationRules.spec.tsx` for the admin field and its wiring.
- `scripts/check-nc-mirrors-in-sync.ts` and
  `scripts/check-viewer-condition-mirror.ts` fail until the viewer mirrors it,
  and again once it does, until the allowances are deleted.
