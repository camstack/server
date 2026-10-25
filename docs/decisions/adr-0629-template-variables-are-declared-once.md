---
id: D629
title: Template variables are declared once, and checked in both directions
status: accepted
date: 2026-09-24
supersedes:
covers:
  - packages/types/src/notification/template-vars.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/clock-text.ts
  - packages/addon-post-analysis/src/notification-center/template-preview.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/timelapse-delivery.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-delivery.ts
  - packages/addon-post-analysis/src/notification-center/__tests__/template-var-parity.spec.ts
  - scripts/check-nc-text-catalog.ts
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

A rule's `template.title`/`template.body` interpolates `{{var}}` names, but
nothing ever declared what those names WERE. The vocabulary lived only as the
side effect of three producers building a `Record<string, string>` at render
time — `buildTemplateVars` in the dispatcher (ordinary rules), the timelapse
delivery's own `templateVars`, and the summary/digest delivery's own
`templateVars` — and every editor that wanted to show a picker kept its own
hand-written list of names, independently, because there was no catalog to
read.

Three drifts came out of that, each found by tracing a real symptom rather
than by inspection:

- The admin digest editor's own picker list (`SUMMARY_TEMPLATE_VARIABLES`,
  `packages/addon-admin-ui/src/pages/system/NotificationSummaryEditor.tsx`)
  offered `{{tiles}}`. No producer ever supplied it — the digest producer's
  tile count is `{{shown}}`/`{{events}}` — so it was a ghost variable an
  operator could pick into a template and never see rendered, with no error
  and no log line.
- `{{scope}}` (`buildTemplateVars`) was computed as `occupancy?.zone ??
  deviceName` — unconditional on `occupancy` being present, so on every
  NON-occupancy kind it silently resolved to the camera name, a second,
  undeclared spelling of `{{camera}}`.
- `{{class}}` fell back to `subject.className`, a required field that a
  system row fills with the literal placeholder `'event'` — so a system
  rule's `{{class}}` rendered the word "event" as if it were a detected
  class, not emptiness.

Each of these was reachable only by reading the three producers against each
other and against what the editors actually offered; nothing in the codebase
checked that the offered set, the supplied set and the shipped-text set
(`en.json`/`it.json`) agreed.

## Decision

`NC_TEMPLATE_VARS` (`packages/types/src/notification/template-vars.ts`) is
now THE catalog: one `NcTemplateVarDescriptor` per variable (name, label,
example, `group`, and the `family`/`field`/`kind` axes it applies to, plus an
optional `systemEventKinds` narrowing). `templateVarsFor(ctx)` filters it for
one editor context; `isKnownTemplateVar(name, ctx)` answers one name — both
pure functions over the catalog, no I/O, so every consumer (cap provider,
`nc.*` bridge, either shipped editor) reads the same answer.

Parity is enforced in both directions, not assumed:

- **Producer → catalog**: `template-var-parity.spec.ts`
  (`addon-post-analysis/src/notification-center/__tests__/`) runs each of the
  three producers — `buildTemplateVars`, the now-exported
  `timelapseTemplateVars`, `summaryTemplateVars` — and asserts the keys it
  actually returns equal exactly what `templateVarsFor` declares for that
  context: nothing supplied that isn't declared, nothing declared that isn't
  supplied. The four ordinary rule kinds use one representative row each.
  SYSTEM rows are never hand-typed: 37 samples are built by the real intake
  (`incomingFromSystemEvent` for every bus category it handles,
  `incomingFromBatteryBand`, `incomingFromConsumableBand`, and
  `incomingFromAlarmTransition` fed the real `buildArm*Announcement` bodies),
  one per branch that changes the frozen params, and the spec requires at
  least one sample for EVERY authorable `NcSystemEventKind` (all 26). The
  hidden-var check runs per sample; the ghost check runs per kind over the
  union of its samples (a kind whose intake picks between branches — one node
  vs several, measured vs binary — fills a variable on one of them).
  `{{camera}}` is fed the name the dispatcher itself derives
  (`notificationDeviceName`), so a device-less system row carries the filler
  `'system'`. Two named carve-outs, both commented in the spec: `{{subject}}`
  on any system row (the dedup slot), and `{{deviceName}}` on
  `export-completed` (the in-flight-row rescue's id stand-in).
- **Shipped text → catalog**: `scripts/check-nc-text-catalog.ts` gained a
  placeholder-declared check restricted to the six dispatcher title/body
  prefixes (`detection.`/`package.`/`occupancy.`/`system.`/`timelapse.`/`summary.`),
  with a named carve-out for the `detection.subject*` fragments (composed by
  `ncSubjectText`, never the catalog) — a shipped key naming an undeclared
  `{{var}}` fails CI.

An operator previews before saving, through the real render path rather than
a second guess at it: `notificationRules.getTemplateCatalog` serves the
catalog; `notificationRules.previewTemplate`
(`packages/addon-post-analysis/src/notification-center/template-preview.ts`)
renders a draft title/body against example values through the LIVE
`NcTextCatalog`, so a preview speaks the hub's current language and text
overrides. Both are mirrored on the `nc.*` bridge
(`nc.getTemplateCatalog`/`nc.previewTemplate`). Auth is the same as
`getConditionCatalog`: a protected (signed-in) procedure with `view` access —
any authenticated caller, no admin requirement. `previewTemplate` is a
MUTATION (POST) on both the cap and the bridge purely for transport: a
2.5k-character draft does not belong in a batched GET URL. It still sends
nothing, and its access stays `view`.

New variables landed alongside the catalog, each backed by a real producer
field and a parity sample: `sounds`/`hitPercent`/`db` for `sound` rules
(`NcAudioWindowSubject`'s `labels`/`hitPercent`/`peakDbfs`, frozen onto the
outbox row), `eventType` for `sensor` rules, `exportId` for
`export-completed`, and the alarm's coverage params (`rules`, `names`,
`skippedNames`, `bypassedNames`, plus `devices`/`seconds` on the arm and
refusal kinds) that the arm/arming/refusal bodies already froze. `{{eventKind}}`
and `{{db}}` are implemented and declared. `{{time}}` renders hours and minutes
in the notification's OWN language via `ncClockText`
(`packages/addon-post-analysis/src/notification-center/clock-text.ts`,
`Intl.DateTimeFormat`, host time zone): `it` renders "20:05", `en` renders
"08:05 PM". It replaces `toLocaleTimeString()`, which used the SERVER
container's locale and printed seconds, so an Italian hub running an English
container read "8:05:13 PM" inside an Italian sentence. The same formatter now
serves `{{time}}` in all three families: the timelapse and digest producers
used to print a host-24h `HH:MM` of their own (`{{from}}`/`{{to}}` keep it).

Running the parity spec over the real intake also narrowed or widened the
catalog where it had been wrong: `{{camera}}` is offered on a system rule only
for the kinds whose intake freezes a device (the device, battery, consumable,
stream, detection-blind and alarm kinds, plus `export-completed`), because a
node, backup or update row renders the filler `'system'`; `{{mode}}` is not
offered on a disarm or a trigger (the transition carries none); `{{node}}`,
`{{package}}`, `{{packageName}}` and `{{nodeId}}` are offered on the completed
updates whose intake fills them; and an alarm a detection rule set off (the
combined row) offers that rule's `{{class}}`, `{{label}}`, `{{confidence}}`,
`{{zones}}`, `{{zone}}` and `{{inZones}}` on `alarm-triggered`.

The `scope`/`class` bugs found while building the parity spec were fixed in
the producer (`dispatcher.ts`), not papered over in the catalog: `scope` is
now `occupancy !== undefined ? (occupancy.zone ?? deviceName) : ''`; `class`
now blanks on a plain system row (`detection?.className ?? (systemEvent !==
undefined ? '' : subject.className)`), while a combined-alarm system row (one
whose body speaks a triggering rule's detection vocabulary) is unaffected —
`detection` still wins first. Neither fix touches any SHIPPED text — no
built-in template used either variable outside the kinds where it was always
genuine — but an operator's own custom template that leaned on the old
leak now renders that variable empty instead of the leaked value.

## Consequences

Adding a variable costs three things in the SAME change, or the parity spec
or the CI guard catches the gap: a descriptor in `NC_TEMPLATE_VARS`, the
producer code that actually supplies it for the kinds the descriptor claims,
and a `template-var-parity.spec.ts` case that exercises it on a real sample
row. A descriptor with no producer fails the parity spec (declared, never
supplied); a producer field with no descriptor fails it the other way
(supplied, never declared) the moment a parity sample happens to carry it,
and fails the CI text guard the moment any shipped string names it.

`packages/addon-post-analysis` builds self-contained and INLINES
`@camstack/types`, so the new schemas (`NcTemplateVarDescriptorSchema`,
`NcTemplatePreviewInputSchema`, etc.) travel inside the addon and the
`nc.getTemplateCatalog`/`nc.previewTemplate` bridge actions work on the addon
deploy alone. The coupling is the hub's cap-router INPUT validation, the same
one D628 records: `notificationRules.getTemplateCatalog`/`previewTemplate` are
routed and validated by `@camstack/system`, which inlines its own copy of
`@camstack/types` (`bundleTypesMainEntry`). The `@camstack/server` release
carrying them must be installed before a caller uses the cap routes.

The historical requirements spec (planning repo: superpowers/specs/2026-07-22-notification-center-requirements.md)
§2.8) is marked superseded rather than rewritten — it documents what was
PLANNED, including the never-built `{{classLabel}}`/`{{identity}}`/`{{plate}}`/
`{{importance}}`/`{{dwellSeconds}}`/`{{audioLabels}}` names, and rewriting it in place would erase the record of the
drift this decision closes.

## Enforcement

Two guards, both wired into CI: `template-var-parity.spec.ts` (part of the
regular `addon-post-analysis` vitest run) and
`scripts/check-nc-text-catalog.ts` (`.github/workflows/ci.yml`). Both were
disarmed during development — a fabricated `{{tiles}}` descriptor with no
producer, and each producer fix reverted in turn — and confirmed to fail
before being restored.
