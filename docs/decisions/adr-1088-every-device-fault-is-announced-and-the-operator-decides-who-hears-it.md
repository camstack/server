---
id: D1088
title: Every device fault is announced with its tier, and the operator's filters decide who hears it
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/notification/alert-episode.ts
  - packages/system/src/builtins/alerts/alert-episode-policy.ts
  - packages/addon-post-analysis/src/notification-center/alert-episode-ledger.ts
  - packages/addon-post-analysis/src/notification-center/target-settings.ts
---

## Context

A device fault opens an alert at the severity of its tier: an `error` fault is a
critical alert, a `warning` fault a warning alert. The alert centre announced
only critical and error episodes, and Notification Center mapped only a critical
device alert to `device-attention-required` (D911). So when the fault's alert
began to follow its tier, every warning fault (a low battery flag, a lost
connection the vendor calls a warning) went silent: a rule filtering on its
fault code stopped notifying until the fault became an error. The system had
decided, by tier, who gets told.

## Decision

A device fault (alert category `device.error`) is announced at EVERY tier as
`device-attention-required` / `-resolved`, and the event carries the tier.
What reaches a person is decided only by controls the operator already has: the
rule's `faultSeverities` filter, and the delivery priority (1..5) a notifier or
a notifier-group member filters on. A warning is delivered one level below the
rule's own priority, an error at the rule's priority; a target's own priority
override is used as written. No new priority scale exists.

Any other alert keeps the old bar: announced from `error` up.

## Consequences

- One function, `alertEpisodeRank`, says whether and how loudly an episode is
  announced. The alert centre's edge policy, the reconcile and the ledger all
  read it; a second copy of the bar is the bug this record removes.
- An escalation inside one episode (warning to error) is announced again. A
  de-escalation is not, and the resolution is announced once, when the last
  fault clears: a rule limited to errors hears the raise at the escalation and
  the resolution at the end.
- A rule that names no tier now hears warnings it did not hear the day before.
  That is the intended reading of "no filter".
- A critical device alert that is not a fault (a PIN request) counts as tier
  `error`.
- The viewer's rule editor has no fault-code or fault-severity input yet; a rule
  written there hears every tier.

## Enforcement

`device-fault-severity.spec.ts` (a warning fault produces the event, a severity
filter skips it and names the filter, the ledger admits raise, escalation and
resolution, the priority follows the tier), `device-attention-severity.spec.ts`
and `alert-episode-policy.spec.ts`. `scripts/check-nc-system-filter-scope.ts`
keeps the engine, the admin editor and the filter table in agreement on
`faultSeverities`.
