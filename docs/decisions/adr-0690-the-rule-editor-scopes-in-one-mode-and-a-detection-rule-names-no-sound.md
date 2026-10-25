---
id: D690
title: The rule editor scopes each list in ONE mode, a detection rule names no sound, and a default is shown as its value
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/types/src/i18n/state-labels.ts
  - packages/types/src/notification/rule-kinds.ts
  - packages/addon-post-analysis/src/notification-center/detection-audio-guard.ts
  - packages/addon-admin-ui/src/pages/system/notification-condition-layout.ts
  - packages/addon-admin-ui/src/pages/system/rule-condition-scopes.ts
covers:
  - packages/types/src/notification/condition-taxonomy.ts
  - packages/addon-admin-ui/src/pages/system/notification-scope-fields.tsx
  - packages/addon-admin-ui/src/pages/system/zone-scope-items.ts
  - packages/addon-admin-ui/src/pages/system/NotificationRuleSnoozeSwitch.tsx
  - packages/addon-admin-ui/src/pages/system/NotificationRules.tsx
---

## Context

The operator's review of both rule editors (2026-10-01, R1–R15) found the same
shape of fault in several places: a control that offered a second way to say
one thing, or a way to break the rule it was editing.

- **Two lists side by side.** Zones and known faces each had an include list
  AND an exclude list, drawn as two unrelated fields, plus an "any of / all of"
  quantifier on the zones. The object classes and the devices had already been
  moved to ONE field (D641) because the combination of both lists is one nobody
  means. "All of" on an immediate rule asked one detection to stand in every
  listed zone at the same instant — it "did not work", and no stored rule on the
  hub used it.
- **A detection rule could name a sound.** The class picker listed the audio
  kinds beside person and vehicle, and the Sound condition was offered on a
  detection rule as a way to "convert" it. Either click turned a working
  detection rule into a sound rule (or the legacy one-sample audio rule) and
  listed every detection condition as what Save would drop.
- **A default that was a choice.** The crossing select offered "Not set —
  entering" and "Entered a zone" — two options that match identically — each
  with a paragraph explaining that. A new detection rule's source was "any",
  so onboard camera detections reached rules the operator meant for the
  pipeline.
- **Hidden fields.** Half the conditions sat behind "Show more
  configurations", so a field the operator was looking for could be in either
  half; the Devices tab paged its list behind "Add…" and "Show N more".
- **Raw words.** Device states (`armed_away`, `not_home`) were printed as the
  wire keys, in both editors, each with no translation.

## Decision

1. **One mode per list.** Classes, zones, known faces and labels are each ONE
   field — "All | Only these | All except these" over one picker (labels: no
   exclusion exists) — and the editors never write the quantifier: `zones` is
   written as `{ ids }`. `NcZoneConditionSchema.match` stays in the schema as an
   OPTIONAL legacy key so every stored row parses, and the engine still honours
   a stored `all`. A stored rule carrying both lists opens in Only with its
   exclusions named and kept until the operator removes them (D49).
2. **A detection rule names no sound.** `rule-kinds.ts` excludes `audio` from
   the detection kind; the rule class picker is `pickerForRuleClasses` (the
   class vocabulary without the audio group). The hub REFUSES a create or
   update of a detection rule whose `classes`/`classesExclude` carry an
   `audio-*` class (`detection-audio-guard.ts`, both save routes). An update is
   refused only for a sound the save ADDS against the stored rule, so a legacy
   rule that already names one stays editable (a threshold, a schedule, a
   zone). A rule stored that way keeps loading and firing exactly as it did;
   the loader reports it once, at WARN, with its id.
3. **A default is shown as its value, with one representation.** The crossing
   select shows an absent condition as "Entering" and offers no "not set";
   choosing Entering writes absent. The hub serves Entering as the absent
   value `''` (plus `exit`, `any`) — the wire every viewer already reads as
   "unset = entering". A new detection rule is seeded with
   `source: 'pipeline'` (`ruleSeedForSection`), which is dropped if the rule
   moves to a sensor or system trigger. The shared seed is the one both editors
   use.
4. **Everything visible.** No "Show more": the Advanced section holds the
   detection source and the crossing direction and nothing else; minimum
   confidence sits with the object classes. The Devices tab lists every
   device, always open, never paged. The viewer-drawn custom zones are not
   offered by the admin editor.
5. **One dictionary of state words.** `STATE_LABELS` / `stateLabel` in
   `@camstack/types` (en + it) labels every state word a device-state or scene
   gate offers; both editors render through it and fall back to the raw word
   for a vocabulary it does not know.

## Consequences

- The legacy one-sample audio rule can no longer be authored. It is read and
  evaluated as before; recreating it is a Sound rule (`conditions.audio`).
- A client that still sends `zones.match: 'all'` is accepted — the schema is
  not narrowed — but no editor produces it. **Editing the zones of a stored
  `all` rule saves it as any: accepted (operator ruling, 2026-10-01).** The
  operator asked for any/all to go, and no such rule exists on the hub.
- `match: 'any'` and an absent `match` are the SAME rule to the unchanged-save
  comparison (`rule-family-guard.ts` `canonicalZones`): the editors write
  `{ ids }` against rows stored with `match: 'any'`, and a rename-only save of
  a grandfathered rule must not be re-judged by the update guards.
- Crossing compatibility: an old viewer (≤1.0.565) drops `enter` from the
  served set and binds `value ?? ''`, so the served entering choice must be
  `''` or that viewer can never select entering again (pinned in
  `rule-kinds.spec.ts`). The admin maps `''` and `enter` to one Entering
  choice, so a pre-D690 hub serving both still shows three.
- **Release note:** a detection rule can no longer name a sound. An old viewer
  still lists sounds in its class picker; saving one is refused with "a
  detection rule cannot name sounds (…) — create a Sound rule for them".
  Rules that already name one keep working. Until the viewer OTA, a rule new
  from the old viewer starts on any source, from the admin on pipeline.
- The zone list fans one `listZones` out per camera the rule covers, which
  for a rule on every device is every camera.

## Enforcement

- `packages/types/src/notification/__tests__/rule-kinds.spec.ts` pins the
  detection exclusion and the pipeline seed.
- `detection-audio-guard.spec.ts` pins the refusal on the cap route, the
  added-only rule on update, the `match: 'any'` equivalence and the loader's
  keep-and-warn; `nc-actions.spec.ts` pins the bridge route; the legacy audio tests seed their rules through the
  store, as a pre-D690 row was written.
- `state-labels.spec.ts` holds the dictionary to the alarm, cover, lock and
  scene enums and to every boolean reader's words.
- Admin: `notification-condition-layout.spec.ts`, `rule-condition-scopes.spec.ts`,
  `zone-scope-items.spec.ts`, `rule-devices-show-all.spec.tsx` and the D690
  blocks of `NotificationRules.spec.tsx` / `NotificationRuleConditions.spec.tsx`.
