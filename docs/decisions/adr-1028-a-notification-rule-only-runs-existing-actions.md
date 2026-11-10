---
id: D1028
title: A notification rule and a notification button only run existing Actions
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/rule-actions.ts
  - packages/addon-post-analysis/src/migrations/rule-actions-to-actions.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - scripts/check-nc-no-executor.ts
---

## Context

The notification centre (NC) grew its own copy of what the Actions surface
already is: a step vocabulary (`NcRuleActionSchema`), shared sequences stored in
the `notification-center/sequences` record kind, an executor with its own
stop-at-first-failure, device-scope boundary and throttle, and five cap methods to
manage the sequences. An operator had two places to author the same work, two
throttles, two run ledgers, and an Action step fixed in one place stayed broken
in the other (planning#473).

## Decision

A rule hook (`onActivation`, `onDeactivation`, `onTrigger`, `onTriggerOff`) is a
list of Action ids (at most four) and a notification button names one `actionId`.
Both run through `actions.run`; the centre has no step vocabulary, no executor
and no sequences. What a match tells an Action travels as declared variables
(`device`, `deviceId`, `class`, `rule`, `ruleId`), and only the ones the Action
declared are sent. Buttons keep token-only authority (D47). The throttle a
sequence carried is the Action's `minDelaySec`.

The existing rule data moves by a migration (D987,
`pipeline-analytics/2026-11-09-rule-actions-to-actions`): each sequence becomes an
Action, the inline steps of one hook become one Action named after the rule, and
rules and buttons are rebound. It is idempotent, and the old sequence rows are
deleted only after a second read shows no rule still in the old shape and every
Action listed by the Actions surface (D49).

## Consequences

- A rule's alarm membership and the snooze exemption read the steps of the
  Actions it names, from a RAM mirror of the Actions list (revalidated every 60 s
  and refreshed on a rule save). A freshly made Action is seen at the next
  refresh.
- A rule fire passes its match as the command origin of `actions.run` (out of
  band, `commandOrigin`, the same channel D1022 uses — not an argument). The
  Actions provider threads that origin onto every cap call the run makes, so an
  Action that presses `alarm-panel.trigger` is attributed to the rule (D705). An
  Action run that presses the panel with no such origin, while the arm excludes
  sensors, is refused (D735). A notification button still passes no origin (D47).
  A press of the panel from its own control, outside an Action, is unchanged.
- The Actions throttle is in memory. A button token minted for the old
  `sequence` kind dies at deploy.
- Per-user notification TARGETS are unchanged.

## Enforcement

`scripts/check-nc-no-executor.ts` (wired into `checks.yml`) fails when the NC
sources regrow a step vocabulary, an executor or the sequences record kind.
`rule-actions-to-actions.spec.ts` pins the migration, including the rerun after a
partial pass.
