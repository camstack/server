---
id: D960
title: A notifier declares its delivery parameters; a rule offers them when a selected notifier declares them
status: accepted
date: 2026-10-28
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-output.cap.ts
  - packages/types/src/notification/delivery-params.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-admin-ui/src/pages/system/rule-form-delivery.ts
  - packages/addon-import-alexa/src/speak/provider.ts
---

## Context

Speaking on an Echo needs two things no other notifier has: a mode (`speak` or
`announce`) and a volume. They lived on a dedicated "Speak on Echo" admin page
that duplicated the generic notification targets page, and they were saved on
the target, so every rule that reached that Echo spoke the same way. Teaching
the rule editor about Echo by name would have put one vendor's vocabulary into
`admin-ui` and the dispatcher.

## Decision

A target KIND declares the extra delivery parameters it accepts
(`TargetKind.deliveryParams`: key, label, type `enum | number | boolean |
string`, options, bounds, default). A rule target already carries free
`params`; the dispatcher forwards only the keys the target's kind declared, and
only values that satisfy the declaration (enum member, number clamped to
bounds), as `Notification.delivery`. A kind that declares nothing is handed
nothing. The rule editor offers a control per declared parameter, derived from
the kinds of the targets selected in THAT rule, and renders nothing when none
of them declares any. A value set on a rule overrides the target's saved
config for that send; absent falls back to it.

## Consequences

The cap schema grows two optional fields (`deliveryParams` on a kind,
`delivery` on a notification), so an addon older than this change keeps
working and a hub older than it refuses a notification that carries `delivery`
(train-bound, like any cap change). Only the event rule editor offers the
controls today; the summary, timelapse and calendar-event editors keep
carrying `params` untouched. The Speak page, its custom actions and the legacy
`speak` settings (`email`, `password`, `region`, `session`) are gone, and the
Echo targets are stored under `echoTargets` with no migration from the old
`speak.targets`.

## Enforcement

`delivery-params.spec.ts` (types), `dispatcher-delivery-params.spec.ts`
(post-analysis) and `rule-form-delivery.spec.ts` (admin-ui) pin the three
steps; `alexa-speak-provider.spec.ts` pins the notifier's side.
