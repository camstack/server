---
id: D628
title: An editor empties a rule field by naming it in `clear`
status: accepted
date: 2026-09-24
supersedes:
covers:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/rule-store.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/nc-actions.ts
  - packages/addon-admin-ui/src/pages/system/notification-rules.helpers.ts
  - camstack/src/components/notifications/rule-editor.ts
  - camstack/src/data/notification-center.ts
---

## Context

`updateRule` persists `{ ...existing, ...patch }` — a partial patch. That is
correct for every field an editor did not touch, and wrong for a field an
editor DID touch and left blank: the merge cannot tell "the operator never
opened this tab" from "the operator cleared the template and hit save",
because both arrive as the same omitted key. An emptied template, schedule, or
target-user list silently reverted to its stored value on the next save — the
merge kept what the form had just thrown away.

`schedule` cannot even be sent empty to say "no schedule": `NcScheduleSchema`
requires `windows.min(1)`, so there is no value an editor could patch it to
that would mean "remove the schedule." The only way to remove one is to name
it for removal, separately from the patch.

Duplicate is a CREATE, not an edit — it calls `createRule` with a freshly
assembled `NcRuleInput`, never `updateRule`. A field the form does not author
(`throttle`, `confirm`, `groupIdleSec`) has no `clear` question to answer on
Duplicate: `rulePreservedFields` carries it over from the source rule so it
is not silently dropped, which is a different failure from the one `clear`
fixes and was tried and rejected as the whole answer — it says nothing about
a field the SAME editor already renders and the operator just emptied.

## Decision

`updateRule` takes an optional `clear: NcRuleClearableKey[]` alongside `patch`
(`NcRuleUpdateInputSchema` in `notification-rules.cap.ts`). `NC_RULE_CLEARABLE_KEYS`
names every field a rule may lose this way: `template`, `schedule`,
`targetUsers`, `snoozeOptions`, `snoozeAllowGlobal`, `waitForEnhancement`,
`actions`, `confirm`, `groupIdleSec`. `rule-store.ts#update` removes the named
keys from the existing rule BEFORE applying the patch, so an editor empties a
field by putting its name in `clear` — never by sending an empty/undefined
value the merge would treat as "unchanged."

Only the AUTHORED keys clear automatically: `buildRuleClears` (admin) and
`ruleClearsFor` (viewer) each derive their `clear` list from the same
form-to-input builder the patch itself comes from — a key is cleared only
when the editor's own assembled input has no value for it, and only among the
keys that editor actually renders (the admin editor authors seven of the nine;
the phone's `rule-editor.ts` authors two: `template`, `schedule`). A field
neither editor shows (`confirm`, `groupIdleSec`) is never cleared by either
one, matching `buildRuleInput`'s existing `preserve` carry-over.

Setting and clearing the same key in one call is a contradiction, not an
ordering question: `rule-store.ts#update` refuses it (`patch[key] !==
undefined` for a key also in `clear` throws) rather than picking a winner.
`updateRule`'s cap provider (`notification-center/index.ts`) treats a cleared
`targetUsers` as absent for the "at least one addressee" check, the same as an
omitted one — clearing the only addressee is refused the same way omitting it
always was.

## Consequences

An older hub — one built before this change — does not know the `clear` key.
Which layer drops it depends on the route: the generated cap router
(`generated-cap-routers.ts`) validates `updateRule` input with `.loose()`, so
it passes `clear` through and the older provider simply never reads it; the
`nc.*` bridge (`nc-actions.ts`) validates with the plain `z.object` and strips
it as an unknown key. Either way the patch still lands and `clear` has no
effect, which is exactly today's pre-fix behaviour: an emptied
field reverts on save. That is a known, accepted degradation — not a crash,
not data loss beyond what already shipped — and both editors already send
`clear` only when it is non-empty, so a call against a current hub that
clears nothing is byte-identical to the old wire shape.

`addon-post-analysis` builds self-contained and INLINES `@camstack/types`, so
its own `NcRuleUpdateInputSchema` (the `nc.updateRule` action validates with
it) is always the one it was built with — deploying the addon first breaks
nothing at load. The coupling is the hub's cap-router INPUT validation:
`notificationRules.updateRule` is validated against the copy of
`@camstack/types` that `@camstack/system` inlines (`bundleTypesMainEntry`), so
the `@camstack/server` release carrying the schema must be installed before a
caller sends `clear` through the cap route — until then the router is the
older one described above.

A new clearable field must be added in **both** places that carry the enum as
a literal list, or an editor can be given a control it cannot actually clear:
`NC_RULE_CLEARABLE_KEYS` in `packages/types/src/capabilities/notification-rules.cap.ts`
(the hub's source of truth) and the hand-mirrored
`NcRuleClearableKeySchema` in `camstack/src/data/notification-center.ts` (the
viewer has no live import of the hub schema — same shape as every other
condition/enum mirror in this system, guarded by
`scripts/check-viewer-condition-mirror.ts` for the condition catalog but NOT
by that script for this enum, since `clear` is not a condition descriptor).
Missing either side is not silent. A key added only to the viewer mirror is
rejected by the hub's `z.enum`, so the save fails loudly with a validation
error. A key added only to the hub cannot be named by the viewer at all: the
viewer's authored-key list is a narrowed type checked with `satisfies`
against its mirror, so naming a key the mirror lacks is a compile-time error
— the new field simply is not clearable from the phone until the mirror
gains it.

## Enforcement

Nothing generated — no codegen or guard ties `NC_RULE_CLEARABLE_KEYS` (hub)
to its viewer copy `NcRuleClearableKeySchema`
(`camstack/src/data/notification-center.ts`), unlike the condition catalog's
checked mirror. Review only:
a PR adding a clearable field should touch both files in the same diff, and a
reviewer who sees one without the other should ask where the second one went.
