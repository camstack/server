---
id: D637
title: A system rule answers one family — device events, system, or alarm — and the hub refuses the rest
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/types/src/notification/system-event-families.ts
  - packages/types/src/notification/system-event-filters.ts
  - packages/types/src/notification/rule-kinds.ts
  - packages/addon-post-analysis/src/notification-center/rule-family-guard.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-events.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-event-field.tsx
  - packages/addon-admin-ui/src/pages/system/scope-pickers.tsx
  - packages/addon-admin-ui/src/pages/system/scope-pickers.helpers.ts
  - server/backend/src/core/agent/node-directory.ts
  - camstack/src/components/notifications/system-event-family.ts
  - camstack/src/components/notifications/SystemEventField.tsx
  - camstack/src/components/notifications/ScopePickers.tsx
  - camstack/src/components/notifications/scope-pickers.helpers.ts
  - scripts/check-nc-system-filter-scope.ts
  - scripts/check-nc-mirrors-in-sync.ts
  - scripts/check-device-selection-in-sync.ts
---

## Context

One `system` rule kind covered thirty-one authorable event kinds
(`NC_AUTHORABLE_SYSTEM_EVENT_KINDS`; the schema carries thirty-five, four of
them a legacy `camera-*` tail that is parsed but never offered) and five
optional narrowing filters (`deviceIds`, `deviceTypes`, `excludeDeviceIds`,
`nodeIds`, `packageNames`). Device, node and alarm questions shared one editor,
so a filter meant for one family silenced another: the live rule "Eventi di
sistema" carried battery kinds under a liveness `deviceTypes` filter and
delivered nothing for two weeks (D636). D636 answered it on the viewer alone —
a battery/consumable rule got its own section, a warning fired when a
liveness-shaped filter met a battery kind — but a "System events" rule could
still mix a node question, a package question and a device question on one
form, and the admin editor had no battery section at all. Filter scoping per
kind (`system-event-filters.ts`) stopped the engine from starving a kind with
a filter it does not speak about, but nothing stopped an author from BUILDING
a rule that asks three unrelated questions at once — the node/package filters
were free text, so a rule could also name a node or a package that no longer
existed.

## Decision

A system-event rule's kinds belong to ONE family, stated once in
`NC_SYSTEM_EVENT_FAMILY`: **device-events** (device and stream liveness, the
switch, battery and consumable band crossings, `detection-blind` — 11 kinds),
**system** (nodes, addon crash-loops and updates, server and wrapper updates,
backups, `export-completed` — 11 kinds) or **alarm** (the panel's nine
transitions, `NC_ALARM_SYSTEM_EVENT_KINDS`). A rule's filters are only the
family's (`NC_SYSTEM_EVENT_FAMILY_FILTERS`): device-events carries `deviceIds`
/ `excludeDeviceIds` / `deviceTypes`; system carries `nodeIds` /
`packageNames`; alarm carries only `deviceIds` (the camera whose rule set the
alarm off).

The rule's kind is DERIVED from its event kinds, never stored (`ruleKindOf` →
`systemRuleKindOf` → `systemEventFamilyOf`). A stored rule whose kinds span
more than one family, name a legacy kind, or name none, derives `mixed`: it
keeps firing — the engine reads `kinds` as a set and has no notion of family —
and stays listed, but is not editable (`NcRuleKindSpec.editable: false`),
because a save that changed its kinds would flip the family mid-edit. The hub
accepts a save that leaves its conditions unchanged; the admin can switch it
off (the rule list's enable column, `setRuleEnabled`); both UIs can delete it. Neither UI offers
a rename or retarget of a `mixed` rule. The viewer draws a `mixed` rule as a
plain read-only line instead of a family editor.

The hub REFUSES a create or an update whose merged result breaks the
invariant: `rule-family-guard.ts` runs `assertRuleFamily` on every create and
`assertPatchKeepsFamily` on every update, through both save paths (the
cap-provider route and the rule bridge — `guardRuleFamily` /
`guardPatchFamily`), naming the offending kind or filter, and logs the refusal
as `nc rule refused: outside one family` (WARN). An update is judged on the
rule the patch WOULD produce, merged the way the store merges it, and only
when the patch actually CHANGES `delivery` or `conditions` relative to what is
stored — a save that leaves an existing `mixed` rule's conditions unchanged
passes untouched. (The admin's enable column is a separate method,
`setRuleEnabled`, which the family guard does not judge.)

`export-completed` is a SYSTEM fact and is no longer narrowed by device: an
export is the operator's own job, not a device's, so it carries no `deviceIds`
filter (a rule that already stored one on it keeps the field, but the engine
now ignores it and the hub refuses to set it again). No migration code: the
operator's existing rules are recreated by hand, one rule per family.

## Consequences

- Three sections and seeds in both editors; the viewer's dedicated battery
  section (`battery-rules.ts`) is gone — battery and consumable kinds are two
  of the device-events family's groups.
- A seed carries kinds, and an editor refuses to untick the last one, because
  the kind is derived from the kinds and must not flip mid-edit.
- Node and package filters are pickers over `nodes.directory` (the cheap
  registry-plus-durable-history merge, no cluster fan-out — never
  `nodes.topology`, which walks the whole cluster in 32–51 s) and
  `addons.listPackages`, so a rule can no longer name a node or package that
  does not exist. A stored id missing from an ANSWERED, COMPLETE directory is
  "removed"; missing from an incomplete one, unknown rather than removed
  (D315). Every stored id stays removable whatever the verdict (D49).
- The engine's family-relevant change is `export-completed` losing its
  `deviceIds` scoping (above); everything else about evaluation is unchanged.
- An old viewer can still open a family rule as it did before D637 shipped,
  but any save that breaks the family is refused by the hub, so it cannot
  corrupt one.

## Enforcement

`scripts/check-nc-system-filter-scope.ts`: every kind in exactly one family;
`NC_SYSTEM_EVENT_FAMILY_FILTERS` equal to the union of `systemEventFilterApplies`
over each family's kinds; the hub validator (`systemEventFamilyProblems`)
refusing exactly what the table forbids, observed on a one-kind probe; and
neither the admin's nor the viewer's per-family visibility
(`systemEventFilterVisibilityFor`, `familyFilterVisibility`) showing a filter
the hub would refuse. The viewer half is skipped, with a printed note, when the
`camstack/` submodule is not checked out.
`scripts/check-nc-mirrors-in-sync.ts`: the viewer's rule-kind enum against the
cap's `NcRuleKindSchema`, and the system-event condition schema's keys. The
check has an `aheadOfViewer` allowance mechanism for kinds the hub ships before
the viewer OTA learns them (self-expiring: it fails once the viewer catches
up); no pair uses it at present. `scripts/check-device-selection-in-sync.ts`: the admin and viewer copies
of `scope-pickers.helpers.ts` are byte-identical, so both UIs judge a stored
node or package id the same way. Tests: `system-event-families.spec.ts`,
`rule-family-guard.spec.ts`, `rule-kinds.spec.ts`.
