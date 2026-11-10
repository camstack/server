---
id: D1030
title: A notifier declares the message fields a target delivers, and a rule's target overrides the rule only within them
status: accepted
date: 2026-11-10
supersedes:
applies-to:
  - packages/types/src/notification/notification-fields.ts
  - packages/types/src/notification/degrade-engine.ts
  - packages/types/src/capabilities/notification-output.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/build-entries.ts
  - packages/addon-post-analysis/src/notification-center/deliverable-fields.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-admin-ui/src/pages/system/rule-form-target-settings.ts
  - packages/addon-admin-ui/src/pages/system/NotificationRuleTargetSettings.tsx
---

## Context

A speaker target (an Echo) speaks a sentence. Before this record it spoke the
title and the body joined into one, because nothing said a body does not
belong on a speaker, and the rule editor offered the operator a body, a
picture and buttons for a rule that addressed only that speaker. The
`TargetKindCaps` already described media, actions, levels and sound per kind,
but not the text: a kind could not say "title only".

A rule also had one set of texts, one priority and one schedule for every
target. "Speak a short line on the kitchen speaker only by day, push the full
text to the phones at night" needed two rules that drifted apart.

## Decision

The **notifier** declares what a target delivers, once, on its kind:
`TargetKindCaps.text = { title, body }` (absent = both, every kind declared
before this record). `deliverableFields(caps)` in `@camstack/types` is the one
reading of that declaration into fields (`title`, `body`, `attachments`,
`actions`, `priority`, `sound`, `clickUrl`) — the dispatcher, the degrade
engine, the admin editor and the viewer read it, nothing names a service.

A rule carries an optional `targetOverrides` map keyed by target id: texts,
schedule, priority. Absent = the rule's value; the target list is not
reshaped and nothing is migrated. The D938 knobs stay in `targets[].params`
(one store per fact). At enqueue, a target outside its own schedule gets no
outbox row and the skip is logged (D391); the others still deliver. The
rule's template is merged with the target's, and a target priority replaces
both the rule's and a legacy `params.priority`. At send, the dispatcher drops
every field the target's kind does not deliver and logs `fieldsDropped`.
A kind that delivers the title but not the body, handed a title that
rendered empty, is sent the rendered body as its title, cut to
`NC_TEMPLATE_TITLE_MAX_CHARS`, and the delivery line says `titleFromBody` —
a speaker never says nothing.

## Consequences

- An override the target cannot deliver is never saved by the editor
  (`sanitizeTargetOverride`), and is dropped at send if it reaches the hub
  some other way — the hub does not refuse it at `createRule`.
- A kind the catalog did not answer delivers "everything": unknown never
  narrows (D315).
- Priority is a field only for a kind with two distinct level ordinals; a
  speaker with silent/announce therefore keeps a priority control.
- Summary, timelapse and calendar-event producers do not read the overrides.
- The viewer's rule editor does not mirror `targetOverrides` yet; the NC
  mirrors guard carries an `aheadOfViewer` allowance until it does, and a
  phone save keeps the map through the hub's patch merge.

## Enforcement

Specs: `notification-fields.spec.ts` (types), `dispatcher-deliverable-fields`,
`target-overrides-enqueue`, `rule-store-target-overrides` (post-analysis),
`rule-form-target-settings`, `NotificationRuleTargetSettings` and the
`#483` block of `NotificationRules.spec.tsx` (admin-ui). Each fails with its
gate removed. `scripts/check-nc-mirrors-in-sync.ts` names the viewer's gap.
