---
id: D1032
title: Per-target settings are the base rule of every delivery, and a notifier declares them
status: accepted
date: 2026-11-10
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/target-settings.ts
  - packages/addon-post-analysis/src/notification-center/build-entries.ts
  - packages/addon-post-analysis/src/notification-center/deliverable-fields.ts
  - packages/types/src/notification/notification-fields.ts
  - packages/types/src/notification/degrade-engine.ts
  - packages/addon-import-alexa/src/speak/speech-text.ts
  - packages/addon-admin-ui/src/pages/system/NotificationRuleTargetSettings.tsx
---

## Context

D1030 gave a rule per-target overrides (texts, schedule, priority), but only
the event path (`buildEntries`) read them. A summary, a timelapse and a
calendar digest built their own rows and ignored the map, so a target's own
schedule or text silently did not apply to them. The settings a notifier
really has were also not all declared: a priority had no named levels, a
picture kind and the action buttons could not be chosen per target, and the
delivery parameters of D938 were never handed to an adapter.

## Decision

1. **The base rule.** A rule's `targetOverrides` apply to EVERY delivery the
   rule makes. The one layer is `target-settings.ts` (`targetsInSchedule`,
   `targetDelivery`); the event, summary, timelapse and calendar row builders
   all go through it. A target outside its schedule gets no row and the skip
   is logged. Grouped close and state summaries reuse `buildEntries`.
2. **The notifier declares.** Priority with named levels (`caps.levels`,
   read by `priorityLevelsOf`), the picture kind (`attachmentKindsOf` from
   `caps.attachments`), the action buttons (`caps.actions`), and per-notifier
   parameters (`deliveryParams`, now carried on `PreparedNotification.delivery`
   to the adapter). The editor derives every control from the declaration;
   none is hand-written per notifier.
3. **An unsupported override is accepted and not delivered.** The row freezes
   `targetSettings` (`attachment`, `actions: false`); the dispatcher narrows the
   produced media and buttons to it at send and logs `narrowedByTarget`. It
   only narrows, never adds media.
4. **Declared so far.** Alexa: `normal` (follows Do Not Disturb) and `high`
   (overrides it). Telegram: `threadId` (forum topic). Home Assistant push:
   `group`, `channel`. No notifier declares volume or voice: none of them
   can set one.

## Consequences

- An Echo has no `silent` level any more; the lowest priority still speaks
  quietly. The per-target `respectDnd` switch stays a hard opt-out.
- The summary, timelapse and calendar editors have no per-target panel yet;
  the hub applies a map saved for them.
- A new notifier setting is a declaration on its kind plus a spec; no editor
  or dispatcher change.
