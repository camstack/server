---
id: D647
title: A device-events or system rule may send a scheduled STATE SUMMARY instead of one notification per event; the alarm stays instant
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/system-event-summary.ts
  - packages/types/src/notification/template-vars.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/**
  - packages/addon-post-analysis/src/notification-center/rule-summary-guard.ts
  - packages/addon-post-analysis/src/notification-center/alerts/open-alert.ts
  - packages/addon-post-analysis/src/notification-center/alerts/device-alerts.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-admin-ui/src/pages/system/NotificationSystemEventDelivery.tsx
  - packages/addon-admin-ui/src/pages/system/notification-system-event-delivery.ts
  - packages/addon-admin-ui/src/pages/system/notification-rules.helpers.ts
  - packages/addon-admin-ui/src/pages/system/rule-form-state.ts
  - packages/addon-admin-ui/src/pages/system/rule-form-save.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/wire-subscriptions.ts
  - packages/addon-admin-ui/src/components/notifications/template-field.helpers.ts
  - scripts/check-nc-mirrors-in-sync.ts
---

## Context

Battery, consumable, tank, liveness, stream, "camera detecting nothing" and
update notifications are INSTANT: one push per band crossing or edge. On a hub
with 70 battery devices, two vacuums and a mower, that is a steady trickle of
pushes about slow facts, most of which the operator acts on at one moment of the
day. The operator (2026-09-26): "for the instant ones — batteries, consumables,
cameras without detections, updates — extend them with a schedule that, if set,
instead of being instant sends a summary for that section". Answers: content is
the CURRENT STATE, not the changes; the schedule is the one the other rules use
(`NcSchedule`); the mode is OPT-IN per rule; nothing to report sends nothing.

What did not work, or was rejected:

- **Summarising the EVENTS of the window** (a digest of raises): a battery that
  went low on Monday and is still low on Friday would appear once, on Monday,
  and a raise that recovered an hour later would be reported as a problem. The
  operator asked for state.
- **The field inside `conditions.systemEvent`**: the viewer re-emits
  `conditions` WHOLE on every save, so an installed phone that does not know
  the key would STRIP it and silently turn a summary rule back into an instant
  one. A top-level rule key survives the store's patch merge.
- **A new system-event kind for the summary row**: the viewer parses every
  kind with a strict enum, rule by rule and history row by history row; one
  unknown kind drops the whole rule on the phone. The row carries the rule's
  first kind and `data.stateSummary`.
- **Reading the state from the authorities at send time** (the device manager's
  online flag, the update checker): a second copy of facts the instant path
  already mirrors, which can disagree with what the same rule would have
  announced. The summary reads the SAME mirrors the instant raises read.
- **Summarising backups and exports**: both are jobs that COMPLETED. The only
  "state" they leave is the last run's outcome, which is not a condition that
  is still true and would be reported every day forever. They are excluded,
  and the preview says so (`excludedGroups`).

## Decision

A `system-event` rule of the `device-events` or `system` family may carry
`systemEventDelivery: { mode: 'summary', schedule }` (absent or `instant` = one
notification per event, the only behaviour before this record). Such a rule
sends NOTHING per event: its match is recorded (so a raise it covers is heard,
not kept pending) and every other rule on the same kinds is untouched. At the
END of each window of `schedule` — the fixed-time digest's machinery,
`findLastClosedWindow` over `isScheduleActive` — it sends ONE notification with
the current state of every section its kinds belong to (the D637 kind groups),
after its own filters, judged by `evaluateRule` on the raise the instant path
sends for that state. A section whose mirror has not been read says
"unavailable", never nothing. Nothing open and every section read sends
nothing and says so in the log. The summary is an ordinary system-event outbox
row (`state-summary:<ruleId>:<windowEndMs>`), so targets, template, snooze,
retries and history are the rule's own. The alarm family, a `mixed` rule, a
non-system rule, an active-hours `schedule` beside a summary and `actions`
beside a summary are refused on both save routes.

## Consequences

- **Two new durable ledgers.** `notification-center:system-state` keeps what is
  still open among the event-driven kinds (stream offline, switched off,
  detecting nothing, cannot infer, crash-looped runner, update available) and
  deletes the row on the closing event. Two kinds have no recovery event
  (`node-inference-unavailable`, `addon-crash-loop`): they close on the node's
  next liveness edge or a server update on it — the respawns that revive them.
  An update applied by a path that emits no `addon.updated` / `server-updated`
  stays listed until a newer `update-available` replaces it.
  `notification-center:state-summary-stamps` records the window last sent, the
  floor (`armedAt`, re-armed when the schedule changes) and the schedule it was
  armed for.
- **A row is a memory, never the truth (fix round 1).** Closing events are
  read from the RAW event before the intake's gates (a recreated broker's
  `first-packet` online would otherwise leave a stream "offline" forever), an
  `update.available` list REPLACES its node's rows, a crash-looped runner
  closes when one of its addons starts, a node that could not infer closes
  when the balancer places a camera on it, and every item is reconciled at
  summary time against the device directory and a complete `nodes.directory`
  — an unanswered directory makes the section "unavailable". Neither
  `node-inference-unavailable` nor `addon-crash-loop` has a readable
  authority outside the process that decided it (the orchestrator's usability
  mirror, the kernel's crash supervisor), so their revival is read from the
  events those processes already emit.
- **The window is computed, not scanned**: candidates (each window's start and
  end minute per day) verified with `isScheduleActive`, O(windows × days); the
  next close is cached per arm or stamp. A window is owed by its close, so an
  arm in the middle of a window sends it at its end.
- **Restart.** The stamp plus the outbox dedup id mean a window is sent once. A
  window that closed while the process was down is sent LATE inside a 3 h grace
  and logged `late`; past it, it is MISSED — stamped and logged at WARN, never
  silent. Only the last closed window counts: a summary of now supersedes an
  older one.
- **The words are frozen at enqueue**, like the digest's: the state is the
  state at the window's end, and so is the language.
- **Users reach admins only**: the row files under the system device (0), and a
  user whose grant is narrower than the installation must not receive the
  names of devices they cannot open.
- **A new cap field and method** — `systemEventDelivery` on the rule and
  `notificationRules.previewStateSummary` (admin). An older `@camstack/server`
  closure strips the field at save (the rule stays instant) and has no preview
  method, which the admin's preview names as "update the server first".
- **The summary vocabulary is held back from the SERVED template catalog**
  (`isHeldBackTemplateVar`): an installed viewer ignores the delivery axis and
  would offer `{{summaryText}}` on every instant system rule. The admin restores
  it (`restoreHeldBackVars`). `{{eventKind}}` renders empty on a summary row.
- **The viewer authors and shows a summary from 1.0.564** (it kept the field
  through the patch merge before that). `check-nc-mirrors-in-sync.ts` compares
  the rule's top-level keys; the self-expiring `aheadOfViewer` allowance for
  `systemEventDelivery` was deleted when the viewer caught up.
- The scheduler rides the existing rule-reload tick and reads RAM only — no
  SQLite read on its schedule (D447).

## Enforcement

- `system-event-summary.spec.ts` (types): refused on alarm and mixed, allowed on
  device-events and system, absent means instant, send-time ⇄ window mapping
  including midnight.
- `rule-summary-guard.spec.ts` and `state-summary-center.spec.ts`: both save
  routes refuse; the instant rule beside a summary rule still fires; a raise
  only a summary rule covers is heard; sent once at the window end, not again
  after a restart; nothing to report sends nothing and logs it.
- `state-summary-window.spec.ts`, `state-summary-scheduler.spec.ts`: window end,
  timezone, midnight, late / missed, failed enqueue retried, unread stamps hold.
- `state-summary.spec.ts`: content per section, every filter, the per-rule
  consumable threshold, cleared items absent, muted devices dropped, unread
  sources "unavailable".
- `template-var-parity.spec.ts`: the summary row's variables are declared and
  every declared one is filled.
- `scripts/check-nc-mirrors-in-sync.ts`: the rule's top-level keys, with the
  viewer's gap allowed by name until it closes.
