---
title: Viewer notification-rule authoring — parity with the admin UI through shared primitives
last-verified: 2026-08-19
covers:
  - camstack/src/components/notifications
  - camstack/src/screens/notifications
  - camstack/src/data/notification-center.ts
  - camstack/src/data/use-notification-center.ts
  - camstack/src/data/use-zones.ts
  - packages/addon-admin-ui/src/pages/system/notification-rules.helpers.ts
  - packages/addon-admin-ui/src/pages/system/notification-rule-pickers.tsx
  - packages/types/src/notification/**
  - packages/addon-post-analysis/src/notification-center/nc-actions.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-rule.ts
---

# Viewer notification-rule authoring — parity with the admin UI

> Status: **implemented, 2026-08-19. Phases 0-3 all shipped.** Phase 0 (zone
> names) and Phase 1 (the shared kind/section model in `@camstack/types`, the
> viewer's section strip + seeded creates + kind-filtered editor) landed on
> 2026-08-18/19 with `@camstack/types@1.2.89`. Phase 2 (timelapse + summary
> authorable from the viewer, and `nc.upsertSummaryRule` relaxed off `admin`)
> and Phase 3 (the duplicate collapse, and the exclusion sentences translated)
> landed on 2026-08-19 — see §5 for what each one actually became, and §3 for
> the correction to the MF-singleton claim that shaped the original plan.
>
> The operator's request, verbatim: *"analizzare attentamente come rendere la
> creazione di una notifica sul Viewer quanto più vicino alla admin UI. Adesso
> le UI sono molto divergenti (niente sezioni, componenti diversi, zone Ids
> invece dei nomi etc). Magari non esportare completamente il componente ma
> utilizzare le stesse primitive. Rimane che sul viewer la rule deve essere più
> semplice senza troppe settings complesse. Supporters occupancy, detection,
> timelapse, audio e summary. Rimangono fuori praticamente le system rules."*
> [Analyse carefully how to make creating a notification on the Viewer as close as possible to the admin UI. Right now the UIs diverge a lot (no sections, different components, zone IDs instead of names, etc.). Maybe do not export the component entirely but use the same primitives. It remains that on the viewer the rule must be simpler, without too many complex settings. Support occupancy, detection, timelapse, audio and summary. Practically only the system rules stay out.]
>
> Required background: `docs/architecture/notifications.md` (rule engine,
> outbox, dispatcher), `docs/architecture/ui.md`. Everything below is read off
> the tree; no live hub call was made. Two decisions are left to the operator
> (§6); the phases in §5 do not block on them except where noted.
>
> The headline finding, stated once: **the divergence is in the form model,
> not in the data plane.** The viewer already reaches everything it needs —
> the condition catalog, the taxonomy, the zones cap by name, and (unused
> today) the timelapse and summary rule stores over the same bridge. What the
> two surfaces do NOT share is the layer the admin UI built between schema and
> widgets: the **rule-kind model** (which fields a detection / occupancy /
> sound rule actually has), the **section model** (one list tab and one seeded
> "New rule" per kind), and the **name-resolving pickers**. All three are pure
> TypeScript with no DOM in them — exactly the kind of module this repo
> already ships to both surfaces through `@camstack/types`
> (`src/notification/condition-taxonomy.ts` et al.). The plan is to make that
> the norm rather than the exception.

---

## 1. What ships today — admin UI

The admin editor lives in `packages/addon-admin-ui/src/pages/system/` (web,
React DOM, `@camstack/ui-library` primitives — `Tabs`, `Dialog`, `Select`,
`Input`, `DataTable`).

### 1.1 The section model (list level)

`notification-rules.helpers.ts:149–207` — `NcRuleSectionKey = 'all' |
'detection' | 'audio' | 'occupancy' | 'system'`, each with a label, a blurb,
a per-section "New rule" label and an empty-state hint. Membership is
`ruleMatchesSection` (`:248`): sound and occupancy are claimed by their
**condition** (`conditions.audio` / `conditions.occupancy`), system by its
delivery, everything else falls to `detection` so no rule is ever invisible.
"New rule" started from a section is **seeded** (`ruleSeedForSection:296`):
occupancy seeds `{ delivery: 'device-event', conditions: { occupancy:
NC_OCCUPANCY_DEFAULTS } }`, sound seeds an audio condition with a level floor
so the rule can never be born fail-closed. The section strip is a
`Tabs` row with live counts (`NotificationRules.tsx:339–349`).

### 1.2 The editor tab model

`notification-rules.helpers.ts:1156–1209` — `NC_RULE_TABS`: `rule` (name,
enabled, trigger, targets) · `devices` · `conditions` · `notification`
(priority, media, template) · `actions` · `advanced` (snooze, cooldown,
wait-for-enhancement). Each tab **declares the form fields it claims**, and a
spec asserts every field is claimed exactly once — a field no tab renders is a
field the operator silently loses. `ruleTabsFor(:1224)` drops the Devices tab
for system rules and renames the Conditions tab to "Sound" / "Occupancy" when
the rule's discriminating condition makes it that kind.

Note: the admin form lifted `devices` out of `conditions` into its own tab
(`notification-rules.helpers.ts:613`); the viewer still authors it as a
condition in the `scope` group.

### 1.3 The rule-kind model — the load-bearing piece

`notification-rule-kinds.ts:53–229`. `NcRuleKind = 'detection' | 'sensor' |
'occupancy' | 'sound' | 'system'`; `ruleKindOf` derives the kind from
`delivery × conditions` in the engine's own precedence order. Each
`NcRuleKindSpec` declares:

- `excluded` — conditions the kind's delivery offers that the engine **fails
  closed** on for this subject, each with its reason as user-facing text
  (e.g. a sound rule excludes `zones` because "a sound has no position in the
  frame");
- `carriesMedia` / `carriesSubjectCrop` — whether the media controls decide
  anything at all;
- `discriminator` — the condition that makes the rule this kind, never
  hidden.

`conditionVisibleForKind(:240)` composes this with the server catalog's
`appliesTo`, and `droppedConditionsForKind(:274)` tells the operator what a
Save will drop, and why, before Save is pressed. **This module exists only in
the admin bundle.** The viewer filters conditions on `appliesTo` alone
(`rule-editor.ts:114`), so a viewer-authored occupancy rule is still offered
`sensorKinds`, `eventTypeTokens` and `source` — the exact "in occupancy
alcuni campi non hanno senso" failure the admin fixed on 2026-08-14.

Why it was admin-local and not in `@camstack/types`: the file's own docblock
(`:28–40`) claimed `@camstack/types` reaches the admin UI as a
Module-Federation singleton *provided by the host*, so a newly added export
would read `undefined` until a server closure carrying it is installed. **That
claim was wrong for this surface, and Phase 3 checked it rather than inheriting
it** — see §3's correction. The file, and the equality spec pinning it, are
gone.

### 1.4 Widgets and pickers — how the admin resolves names

- Leaf widgets are one-per-`valueType`, deliberately dumb
  (`notification-condition-widgets.tsx`); the `descriptor.id → NcConditions`
  key binding is a separate typed layer (`notification-condition-fields.ts`),
  and grouping is `groupDescriptors(:212)` over a `GROUP_ORDER (:158)`.
- **Zones are picked by NAME, ids are stored** —
  `notification-rule-pickers.tsx:40–73` (`useZoneOptions`): one
  `zones.listZones({ deviceId })` query per selected camera, options are
  `{ value: zone.id, label: zone.name, hint: cameraName }`. Identities do the
  same against the face gallery (`:109`), event kinds against
  `pipelineAnalytics.listEventKinds`, plates against the plate gallery. Every
  picker keeps the free-text escape hatch, and a stored value the catalogue
  cannot name renders as a removable chip rather than disappearing.

### 1.5 Timelapse and summary — separate rule families, separate editors

- **Timelapse**: rule model in `@camstack/types`
  (`packages/types/src/notification/timelapse-rule.ts` — deliberately NOT a
  cap; it rides the addon bridge). Admin editor
  `NotificationTimelapseEditor.tsx` (schedule-defined window, cameras,
  cadence with a three-state "Automatic" dense cadence, framerate, targets,
  caption).
- **Summary (digest)**: rule schema lives in the addon
  (`packages/addon-post-analysis/src/notification-center/summary/summary-rule.ts`),
  admin editor `NotificationSummaryEditor.tsx` — **tabbed**
  (`NC_SUMMARY_TABS`, `notification-summaries.helpers.ts:1048`: rule /
  window / content / AI / delivery / …) after the operator's report on the
  one-long-scroll version: *"non ci sono sezioni organizzate"* [there are no organised sections]. That report
  is the same complaint now aimed at the viewer.

### 1.6 Where the schema lives

`packages/types/src/capabilities/notification-rules.cap.ts` —
`NcRuleSchema (:1218)`, `NcConditionsSchema`, `NcConditionDescriptorSchema
(:1250)` with the `valueType` enum (`:1277`) and the served condition catalog;
cap methods `listRules` / `createRule` / … (`:1993–2009`) for the admin path.
Pure notification logic already hoisted for both surfaces:
`packages/types/src/notification/` — `condition-taxonomy.ts`,
`audio-condition.ts`, `schedule.ts`, `timelapse-rule.ts`,
`system-event-filters.ts`, `degrade-engine.ts`, `format-transcode.ts`.

---

## 2. What ships today — viewer

The viewer authors **personal** rules (server-stamped `ownerUserId`, own
targets only) over the `addons.custom` bridge — never the cap directly
(`camstack/src/data/notification-center.ts:1–21`; bridge actions in
`packages/addon-post-analysis/src/notification-center/nc-actions.ts:119`).
Schemas are viewer-local Zod mirrors, by design (older/newer hub tolerance).

### 2.1 The surface

`camstack/src/screens/notifications/` — `RulesTab.tsx` lists rules
partitioned into "My rules" / "Admin rules (read-only)"
(`rule-row.ts` `partitionRules`); `RuleEditorScreen.tsx` is the create/edit
form; `ConditionForm.tsx` + `ConditionField.tsx` render the catalog-driven
condition surface with RN primitives (`Section`, `SelectRow`, `StepperRow`,
`ToggleRow`, `SegmentedControl`).

### 2.2 The concrete divergences (file, line, what is missing)

| # | Divergence | Viewer today | Admin today |
|---|---|---|---|
| 1 | **No sections in the list.** `RulesTab.tsx` splits only by ownership; a sound rule, an occupancy rule and a detection rule are one pile. No seeded "New occupancy/sound rule". | `RulesTab.tsx:1–19` | `NC_RULE_SECTIONS` + seeds, §1.1 |
| 2 | **No sections/tabs in the editor.** One scrolling form + a single "Show advanced" expander (`rule-advanced.ts:21` — base = `devices`, `classes`, `systemEvent`; everything else advanced). The admin's field-claim discipline (a spec proving every field is rendered somewhere) has no viewer counterpart. | `RuleEditorScreen.tsx:120–254`, `:183` | `NC_RULE_TABS` + spec, §1.2 |
| 3 | **Zone conditions show raw ids.** `zones` (`zoneSelection`) and `zonesExclude` (`zoneIdList`) render a free-text `TagsInput` with placeholder "zone id" — the operator types UUIDs. The viewer ALREADY has the name path: `data/use-zones.ts:24–40` (`useZoneRefs`, `zones.listZones` by cap) and `OccupancyField.tsx:29,58` already picks zones by name with deleted-zone handling (`occupancy-condition.ts:9–13`). The two generic zone widgets just never got wired to it. | `ConditionField.tsx:130–134` and `:752–770` | `useZoneOptions`, §1.4 |
| 4 | **No kind model.** Conditions filter on `appliesTo` only (`rule-editor.ts:114`), so an occupancy rule is offered sensor/event/source fields the engine fails closed on; no "Save will drop X because Y" warning. | `ConditionForm.tsx:143–158` | `notification-rule-kinds.ts`, §1.3 |
| 5 | **Raw trigger select, `system-event` included.** The user picks a delivery enum member (`RuleEditorScreen.tsx:136–142`, `NC_DELIVERY_OPTIONS` `rule-editor.ts:289–295`) instead of picking a *kind* of rule; system rules are authorable in the viewer even though the operator wants them out. | | Kind is chosen by the section, delivery is derived (§1.1) |
| 6 | **No timelapse, no summary.** The bridge already serves both (`nc-actions.ts:265/281/290` timelapse — `caller: 'required'`, personal; `:324/342/351` summary — list is caller-scoped, upsert/delete are `auth: 'admin'`), and the rule models exist (`timelapse-rule.ts` even ships in `@camstack/types` the viewer already depends on). The viewer calls none of them; these rules are invisible in the app. | `data/notification-center.ts` (no `nc.*Timelapse*`/`nc.*Summary*`) | §1.5 |
| 7 | **Group order drift.** Viewer `GROUP_ORDER` puts `occupancy`,`audio` before `package` (`ConditionForm.tsx:32–44`); admin puts `package` first (`notification-condition-fields.ts:158–172`). Also the admin appends unknown server groups; the viewer silently drops them (`GROUP_ORDER.filter` at `ConditionForm.tsx:100` — a new server group renders nothing). | | |
| 8 | **Stale duplication that is now unblockable.** `camstack/src/components/notifications/condition-taxonomy.ts:1–7` says it stays a local copy "because the viewer pins `@camstack/types@0.1.42`". The viewer now depends on `^1.2.81` (`camstack/package.json:59`) and the installed package ships `dist/notification/condition-taxonomy` + `audio-condition` + `schedule` + `timelapse-rule`. The collapse-to-re-export the file itself asks for is actionable today. | | canonical copies in `packages/types/src/notification/` |
| 9 | **Labels/i18n.** Viewer uses `v2.nc.rules.*` i18n keys (en + it); admin hard-codes English strings. Same concepts, independently worded. | | |

What the viewer does **better** than the admin, and must not lose: the pure
RN-free `*-condition.ts` / `rule-editor.ts` form-model split with node-env
specs, the absent-means-default media pruning (`pruneMediaPolicy`), the
authored-empty recognition scopes, the strip-on-save `preserve` contract, and
the Hermes-safe idioms (`rule-editor.ts:557–564`).

---

## 3. Convergence options

### Option A — export the admin component into the viewer: **rejected**

The admin editor is React DOM: `@camstack/ui-library` peer-depends on
`react-dom` (`packages/ui-library/package.json:45`), the widgets are
`<input>`/Tailwind-class DOM, and the addon is a Module-Federation web
bundle. The viewer is React Native (Hermes) rendering native views (plus
RN-web for the PWA — where DOM *would* load, but then iOS/Android would need
a second implementation anyway, which is the same problem plus a fork).
Deployment trains also differ: admin UI ships with `camstack deploy`,
the viewer ships via EAS OTA. There is no component-level export that
survives all of that.

### Option B — shared, RN-free form-model primitives; per-platform renderers

Hoist the **model** — not the widgets — into `@camstack/types
src/notification/`, the channel that already carries `condition-taxonomy.ts`
to both surfaces:

- the rule-kind model (§1.3): kind specs, exclusions **with their reason
  strings**, `ruleKindOf`, `conditionVisibleForKind`, `droppedConditionsForKind`;
- the section model (§1.1): section keys, seeds (`NC_OCCUPANCY_DEFAULTS`,
  the audio seed), membership predicate;
- the section/tab **contract**: ordered section keys and the
  `fields`-claimed-by-section map, so both surfaces can spec "every field is
  rendered exactly once" against the same table;
- grouping (`groupDescriptors` + one canonical `GROUP_ORDER`, fixing #7's
  drift and the viewer's silent-drop of unknown groups);
- the pure half of the zone/identity option shaping (id+name merge,
  unknown-id preservation) — the fetch stays per-platform.

Renderers stay native to each platform: admin keeps `Tabs`/`Dialog`, the
viewer renders the same section list as its existing `Section` stack or a
segmented header. Labels: the shared model carries stable ids + English
fallback strings; the viewer maps ids to its `v2.nc.rules.*` keys.

**Honest trade-offs.** (1) ~~The MF-singleton lag (§1.3)~~ — **CORRECTED
2026-08-19, and the correction is the whole of Phase 3's step 1.** The lag is
real, but it applies to addon widget REMOTES and not to the admin UI. The admin
UI is the module-federation **HOST**: `packages/addon-admin-ui/vite.config.ts`
declares `federation({ name: 'admin_ui_host', remotes: {}, shared: {
'@camstack/types': { singleton: true, requiredVersion: false, import: typesEsm
} } })` where `typesEsm = workspaceEsmEntry('../types')`, and
`resolve.alias['@camstack/types']` points at `../types/src/index.ts`. Both are
BUILD-TIME workspace paths, so the admin UI *provides* the singleton, bundled
from the monorepo copy — it never consumes one from a server closure. A
consumer looks different and exists: `packages/addon-benchmark/vite.config.ts`
declares the same package `import: false`, which is what "reads `undefined`
until the host has it" actually describes. Empirically, after the collapse the
exclusion sentences appear in `dist/assets/dist-*.js` — the admin UI's own
`@camstack/types` provider chunk, beside `NC_CONDITION_CATALOG`. Existing
practice already contradicted the claim too: `notification-rules.helpers.ts`
imports `NC_CONDITION_CATALOG` / `NC_AUDIO_DEFAULTS` / `audioIsFailClosed`, and
`notification-timelapse.helpers.ts` imports `TimelapseRuleSchema` and
`TIMELAPSE_DENSE_FLOOR_SEC`, all as runtime values from that package. (2) The
viewer must tolerate older hubs, so anything hoisted must stay pure
logic/constants — never transport, never a schema the viewer needs to relax for
back-compat. (3) A types change still rides the framework release train
(`docs/architecture/update-and-release.md`) *for the server*; the admin UI gets
it on its own `camstack deploy` from the same workspace.

### Option C — disciplined duplication under a shared contract, no shared code

Same section keys, same field order, same wording, enforced only by parity
specs on each side (the pattern `rule-editor.ts:576–588` and
`notification-rule-kinds.ts:35–40` already use). Cheap to start, no release
train — but the kind model's value is its **content** (twelve exclusion
reasons traced to the engine), and content duplicated across two repos is
exactly what rots. This repo already paid for two knobs writing a store
nobody read; two kind tables disagreeing about which fields an occupancy rule
has is the same failure wearing a different hat.

### Recommendation: **Option B as the destination, Option C's specs as the transition mechanism.**

The precedent already exists and works: `condition-taxonomy.ts` was hoisted
to `@camstack/types`, the viewer kept a spec-pinned local copy while its
dependency lagged, and today the pin has caught up (#8) and the copy can
collapse to a re-export. Every new shared piece follows that exact
lifecycle: **hoist to `packages/types/src/notification/` → consume natively
in the viewer (npm bump) → admin keeps a spec-pinned local copy until the
next server closure → collapse.** No component export, same primitives at
the model layer, platform-native widgets — which is precisely what the
operator asked for ("non esportare completamente il componente ma utilizzare
le stesse primitive").

---

## 4. Target design for the viewer (simpler, five kinds, no system rules)

The viewer's rule vocabulary becomes **five authorable kinds** — detection,
occupancy, sound, timelapse, summary — surfaced identically at both levels:

**List (RulesTab).** A section strip above the existing My/Admin partition:
`All · Detection · Occupancy · Sound · Timelapse · Summary`. The first four
partition `nc.listRules` output by the shared `ruleMatchesSection`; the last
two are backed by `nc.listTimelapseRules` / `nc.listSummaryRules`. "New rule"
inside a section seeds that kind (shared seeds), exactly like the admin. A
personal **system** rule cannot be created (the section does not exist), but
an admin system rule the caller is targeted by still renders read-only in
`All` — hiding it would repeat the "rule looks deleted" failure the admin's
`all` section exists to prevent.

**Editor (RuleEditorScreen).** No raw trigger select: the kind was chosen at
create time and is derived on edit (`ruleKindOf`); delivery becomes an
implementation detail exactly as in the admin's seeded flow. The form keeps
ONE scroll (phones scroll; dialog tabs are a desktop idiom) but its sections
mirror the admin tab order and take the shared claim table:

1. **Rule** — name, targets (own only, unchanged).
2. **Cameras** — the `devices` multiselect, promoted out of the condition
   pile to mirror the admin's Devices tab, and feeding every zone picker.
3. **\<Kind\>** — the discriminating condition first (occupancy / sound
   composite widget), then the kind-visible conditions grouped by the shared
   `GROUP_ORDER`, filtered by `conditionVisibleForKind` — not by bare
   `appliesTo`. Fields the kind excludes are simply absent (viewer stays
   simpler: no disabled-with-reason rows), but the **save-drop warning**
   (`droppedConditionsForKind`) is kept verbatim, because silently dropping
   an authored value is the one failure both surfaces agree is worst.
4. **Notification** — priority, media, template (existing widgets), gated by
   the kind's `carriesMedia` / `carriesSubjectCrop`.
5. **Advanced** — the existing expander, minus what moved up.

"Simpler" stays true structurally, not by forking the model: the viewer
renders a **subset** of the shared contract (no actions section, no snooze
options, no cooldown editor, no per-target params authoring — all preserved
verbatim on save exactly as `formToInput` does today).

**Timelapse editor (new, small).** Personal (`caller: 'required'` upsert):
name, cameras, weekly windows (existing `ScheduleField`), framerate +
cadence with "Automatic" dense cadence, targets, caption. Schemas imported
from `@camstack/types` `timelapse-rule.ts` — no local mirror needed, the
type already ships in the pinned package.

**Summary editor (new, admin-gated).** `nc.upsertSummaryRule` is
`auth: 'admin'` (deliberate v1 decision — vision-model cost). The viewer
ships list + read-only detail for everyone, and the edit form only for admin
sessions; if the operator later relaxes the auth (§6), the form is already
there.

**Zones by name, everywhere** (Phase 0 below): both generic zone widgets
adopt the `OccupancyField` pattern — options from
`useZoneRefs(conditions.devices ?? [])`, label = name, value = id, a stored
id the hub no longer serves rendered as an explicitly-unknown removable chip,
free text kept as the escape hatch, and "pick cameras first" as the empty
state.

---

## 5. Implementation plan

### Phase 0 — zone names instead of zone ids (urgent, immediately shippable)

Viewer-only, no server change, no shared-code prerequisite.

- `camstack/src/components/notifications/zone-picker.ts` (new, pure):
  merge `NcZoneRef[]` + stored ids → options with `known/unknown` flags
  (lift the logic `occupancy-condition.ts` already proved; share it between
  the three zone widgets instead of writing it twice more). Node specs.
- `camstack/src/components/notifications/ConditionField.tsx`: replace the
  `TagsInput` in the `zoneIdList` case (`:130–134`) and in
  `ZoneSelectionField` (`:752–770`) with a name-labelled multi-select fed by
  `useZoneRefs(conditions.devices ?? [])` (`data/use-zones.ts:24`), keeping
  the any/all segmented control and the free-text escape hatch. Empty-devices
  state: the admin's own wording — nothing authoritative to list, pick a
  camera first.
- i18n: `locales/en.json` / `it.json` keys for the empty state and the
  unknown-zone chip.

Complexity: **S** (half a day including specs). Ship via the proven OTA
chain.

### Phase 1 — the shared kind/section model, and the viewer consumes it

- `packages/types/src/notification/rule-kinds.ts` (new): port <!-- drift-ok: proposed new file -->
  `notification-rule-kinds.ts` (specs, reasons, `ruleKindOf`,
  `conditionVisibleForKind`, `droppedConditionsForKind`) plus the section
  model + seeds from `notification-rules.helpers.ts:149–307` (moving
  `NC_OCCUPANCY_DEFAULTS` and the audio seed beside the audio defaults that
  already live in types). Specs come with it. `npm run codegen` untouched
  (no cap change).
- Publish types; bump `camstack/package.json`. **Admin UI is NOT migrated
  yet** (MF lag, §3) — instead extend
  `notification-rule-kinds.spec.ts` to also assert equality against the
  types copy, so the two cannot drift while they coexist.
- Viewer: new `rule-kind` consumption in `RulesTab.tsx` (section strip +
  seeded create) and `ConditionForm.tsx`/`RuleEditorScreen.tsx`
  (kind-filtered conditions, save-drop warning, kind-gated media, trigger
  select removed for create, system-event removed from authoring —
  `NC_DELIVERY_OPTIONS` keeps parsing it for read-only display).
- Adopt the shared `GROUP_ORDER`/`groupDescriptors` (fixes #7 and the
  unknown-group silent drop).

Complexity: **M** for the types module (mostly a disciplined move with
specs), **M–L** for the viewer editor restructure (the widgets all exist;
the work is the section scaffold + filtering + specs).

### Phase 2 — timelapse and summary in the viewer — **DONE 2026-08-19**

- `camstack/src/data/notification-center.ts`: the six bridge calls
  (`nc.listTimelapseRules`, `nc.upsertTimelapseRule`,
  `nc.deleteTimelapseRule`; `nc.listSummaryRules`, `nc.upsertSummaryRule`,
  `nc.deleteSummaryRule`) + hooks in `use-notification-center.ts`. Timelapse
  schemas imported from `@camstack/types`; the summary rule is a viewer-local
  mirror (its schema deliberately lives in the addon, §1.5). The four
  hand-rolled per-element parse loops collapsed into one `parsePerItem`.
- `TimelapseEditorScreen.tsx` + `timelapse-form.ts` (pure);
  `SummaryEditorScreen.tsx` + `summary-form.ts` (pure); `FamilyRuleRow` +
  `family-row.ts`. `TargetPicker` / `LabeledInput` / the section label / the
  error banner were lifted out of `RuleEditorScreen` into
  `components/notifications/RuleFormFields.tsx`, and `ScheduleField` /
  `DeviceMultiselect` / `Hint` are now exported from `ConditionField.tsx` —
  three editors, one set of widgets.
- Strip: `Timelapse` and `Summary` are **not** `NcRuleSectionKey`s. They are
  separate stores behind separate bridge actions, so `rule-sections.ts` keeps
  them in a distinct `NcViewerFamilySection` union and their counts come from
  their own queries. Handing `'timelapse'` to `ruleMatchesSection` would return
  the whole detection list (it is the catch-all) — the spec asserts it cannot.
- **The phone authors a SUBSET, and the patch is a DIFF.** Each editor emits
  only the keys that changed, so the four timelapse knobs it does not offer
  (`denseCadenceSec` — absent is a value, `minDwellSec`, `previewText` — three
  states, `reportClasses`) and everything about a digest's mosaic (tiles, rank,
  filters, captions, the AI section) survive an edit untouched. That is the
  whole justification for "più semplice" [simpler] not meaning "destructive".
- **`nc.upsertSummaryRule` / `nc.deleteSummaryRule` relaxed off `auth: 'admin'`**
  to `caller: 'required'` (operator decision, §6.1), matching
  `nc.*TimelapseRule*` exactly: ownership enforced in the handler,
  `ownerUserId` stamped from the caller, an admin still authors GLOBAL rules,
  targets still ownership-checked. `nc.listSummaryRules.readOnly` went from
  `!isAdmin` to `!isAdmin && ownerUserId !== callerId`. `nc.testSummaryRule`
  stays admin — it DELIVERS. **This is a bridge action, not a cap**, so there is
  no codegen and no framework train: `npm run codegen:check` reports no drift
  and it ships on `camstack deploy packages/addon-post-analysis`.
- **The degrade is a capability probe, not a caught 403.** `nc.listSummaryRules`
  now returns `canAuthor`; the viewer mirror has it `.optional()`, so an older
  hub (which says nothing) is read as "this hub refuses your write" and the tab
  shows the list read-only with a note. Never an error, never a hidden tab.

Complexity as built: **M** (timelapse) + **M** (summary, including the server
relaxation).

### Phase 3 — collapse the debt — **DONE 2026-08-19**

- `camstack/src/components/notifications/condition-taxonomy.ts` is a re-export
  of `@camstack/types` (its own TODO, unblocked). Explicit rather than
  `export *`: the shared module also exports `NC_BASE_CONDITION_KEYS` /
  `isBaseConditionKey` and this app's base set is deliberately different (it
  adds `systemEvent`). The existing spec now exercises the shared
  implementation through the re-export and asserts **identity**
  (`toBe(sharedPickerForCondition)`) — the one assertion a copy that happens to
  agree cannot satisfy.
- The admin UI's `notification-rule-kinds.ts` and its equality spec are
  **deleted**; `NotificationRules.tsx`, `NotificationRuleConditions.tsx` and
  `notification-rules.helpers.ts` import from `@camstack/types` directly. The
  MF-singleton reason for keeping the copy did not survive being checked (§3).
  The section MODEL went with it — `notification-rules.helpers.ts` now
  re-exports `ruleMatchesSection` / `ruleSeedForSection` /
  `defaultDeliveryForSection` / `parseRuleSection` / `isAudioRule` /
  `isOccupancyRule` / `isSystemDelivery` and keeps only the admin-WORDED
  `NC_RULE_SECTIONS` table (it says "Click" and names the Devices tab, which
  the surface-neutral shared copy cannot). `NC_OCCUPANCY_DEFAULTS` re-exports
  too. The catalog-pinning spec lives in
  `packages/types/src/notification/__tests__/rule-kinds.spec.ts` and covers
  everything the deleted one did.
- One shared-model fix fell out of the collapse:
  `NcRuleConditionsSubject` named only `occupancy` and `audio`, which made it a
  *weak type* — TypeScript's excess-property check then rejected
  `{ classes: ['person'] }` written INLINE while accepting the identical value
  read out of a variable. It now admits the rest of the conditions explicitly.
- **The fifteen exclusion sentences are translated**, en + it, under
  `v2.nc.rules.editor.dropReason.<kind>.<conditionId>`, plus the fourteen
  `condition.<id>` labels above them (an Italian operator was being told that
  "sensorKinds" would be removed). The spec DERIVES the key list from
  `NC_RULE_KIND_SPECS`, so an exclusion added upstream fails until both locales
  carry its sentence. The shared model's English stays the `defaultValue`
  fallback, so there is still no second English copy.

Complexity as built: **M**.

---

## 6. Decisions left to the operator

1. **Summary authoring from the phone.** ✅ **CLOSED 2026-08-19 — relaxed.**
   `nc.upsertSummaryRule` and `nc.deleteSummaryRule` are now
   `caller: 'required'` with handler-enforced ownership, exactly like
   `nc.*TimelapseRule*`. No new ownership model was invented: `NcSummaryStore`
   has had `ownerUserId` / `listForOwner` since it was written and they were
   simply unreachable. `nc.testSummaryRule` stays admin. The budget guard the
   original question asked about is `assertSummaryBudget`, unchanged, still
   checked on the MERGED rule. Older hubs are handled by the `canAuthor` probe
   rather than by a caught refusal.
2. **The `sensor` kind on the viewer.** The admin distinguishes
   detection vs sensor (doorbell/device-event) rules; the requested viewer
   list is "occupancy, detection, timelapse, audio, summary". Default here:
   fold sensor rules into the Detection section (they render and edit fine;
   they just get no section of their own). A sixth section is a one-line
   change if wanted.

## 7. Verification notes

Claims that must be re-checked at implementation time, not assumed from this
document: export parity between the viewer's local `condition-taxonomy.ts`
and the published `@camstack/types@1.2.81` copy (the local file gained i18n
key wiring); whether `NcViewerTimelapseRuleSchema`'s `readOnly` extension is
mirrored correctly viewer-side; and that no admin rule in the wild carries a
delivery this viewer build cannot classify (fallback is `detection`, same as
the admin's).
