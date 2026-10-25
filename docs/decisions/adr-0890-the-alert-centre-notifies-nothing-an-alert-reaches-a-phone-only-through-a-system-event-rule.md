---
id: D890
title: The alert centre notifies nothing; an alert reaches a phone only through a system-event rule
status: accepted
date: 2026-10-21
applies-to:
  - packages/system/src/builtins/alerts/alerts.addon.ts
  - packages/system/src/builtins/alerts/alert-episode-policy.ts
  - packages/types/src/notification/alert-episode.ts
  - packages/addon-post-analysis/src/notification-center/alert-episode-ledger.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
---

## Context

D877 made the hub-main alert centre the SOLE pusher of runner failures, straight
through `notification-output`, because on 2026-10-17 the only push path ran
through Notification Center, itself one of the refused runners. D885 extended
the same digest push to any `critical` alert. The result was two notification
systems with different settings (`criticalPushEnabled`, `criticalPushTargetIds`),
different targets, different dedup (`metadata.push`, a per-target `sentTo`) and
different wording, one of which the operator could not route, snooze, mute per
node or word. NC even had a special case that dropped `addon-crash-loop` so that
the two would not double every message.

## Decision

The alert centre never sends. Everything it used to push is announced on the bus
and notified by Notification Center rules:

- every alert it stores carries an `episodeId` (`metadata.episodeId`): minted
  when the alert opens, kept through every re-emit while it stays open, new
  after `completed`/`dismissed` or when the emitter changes `metadata.episodeKey`;
- the opening and the closing of a `critical` or `error` episode are emitted as
  `EventCategory.AlertEpisode` (`alert.episode`), from the one place every alert
  write passes through;
- NC turns the edge into `alert-critical`, `alert-error` or
  `alert-critical-resolved` (system family; `error` announces its opening only);
- one notification per episode: `NcAlertEpisodeLedger` (a durable ledger of the
  episodes NC notified) admits an edge once, whichever path sees it first;
- an event may be dropped (D8), so NC reconciles from `alerts.list` at boot and
  every five minutes (D11): an open critical/error alert without a ledger row is
  notified, a notified episode whose alert is closed gets its resolution. The
  reconcile never runs on a ledger the store has not answered, and never reads
  an alert's absence as closure (D49).

Rejected: (1) keeping the push behind a flag, "for when NC is down" — a second
system that nobody routes is the defect, and a flag keeps it alive; (2) a
`notified` mark on the alert row written by NC — a cross-addon write whose loss
re-notifies, and the alert store is not NC's; (3) one kind for every severity —
a rule must be able to opt into `error` separately from `critical`.

## Consequences

- Removed: `critical-push.ts`, the digest, `metadata.push`/`pushLine`, the
  alert-center settings `criticalPushEnabled` and `criticalPushTargetIds`
  (stored values are ignored), and NC's `addon-crash-loop` early return.
  `addon.runner-failed`, `addon.runner-refused` and `system.runner-check` are
  ordinary `critical` alerts.
- If Notification Center is down, nothing notifies; the alert and the bell
  remain the record, and the reconcile notifies when NC is back. An operator who
  has no rule on the alert kinds receives nothing.
- A critical alert that is open when its first matching rule is created is not
  notified retroactively: its episode was already admitted.
- A write lost to a crash costs one duplicate notification of a still-open
  episode (write-behind ledger), never a lost one.
- The viewer's catalog mirror holds the three kinds back until its OTA
  (`NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS`).

## Enforcement

`alerts/__tests__/alert-episodes.spec.ts` (the alert centre never calls the
notifiers; one announcement per episode), `notification-center/__tests__/
alert-episodes-center.spec.ts` (one notification per episode, boot reconcile,
restart), `scripts/check-nc-system-filter-scope.ts` and
`scripts/check-nc-mirrors-in-sync.ts` for the vocabulary.
