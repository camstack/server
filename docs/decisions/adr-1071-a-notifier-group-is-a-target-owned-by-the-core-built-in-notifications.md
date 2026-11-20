---
id: D1071
title: A notifier group is a notification target owned by the core, built in Notifications
status: proposed
date: 2026-11-20
supersedes:
applies-to:
  - packages/types/src/notification/notifier-group.ts
  - packages/system/src/builtins/core-notifier/**
---

## Context

An operator who wants one event to reach several notifiers (a phone push, a spoken announcement, a
chat) had to repeat the same rule target several times, each with its own overrides, and had no way to
say "the speaker only at night" or "the chat only while the alarm is armed". The first idea was a
helper device in the automation builder (BYS); the operator rejected it: the flow belongs in
Notifications, where notifiers are already listed and picked, and it must work from both senders (a
notification rule and the automation "Send notification" step).

## Decision

A group is a notification target, not a device and not a new list: an instance of `notification-output`
of the record kind `notify-group`, served by the core builtin `core-notifier` as one more provider of
that collection capability. Both senders already address a target as `(addonId, targetId)` read from the
instances of `notification-output`, so they reach a group with no change.

- Delivery is one `ctx.api.notificationOutput.send` per member. A member that is itself a group is
  refused by the editor and skipped at send (`nested-group`).
- Each member carries its own policy: enabled, a schedule or an alarm-panel state set, the fields it
  receives, title/body templates, a minimum priority and a throttle. Every skip is logged with its reason
  and the group's tags (D391).
- The kind declares static, permissive caps (D1030): every field a member could need is delivered to the
  group, so the notification center strips nothing before the group sees it. The group never reads the
  catalogue to answer `listTargetKinds`.
- The result is per member; an outbox retry re-sends only the members that failed (an in-memory
  delivered-set keyed by notification and member, with a TTL: a restart costs one duplicate at worst).
- A retry is recognised by a key: the event id (or tag), the notification's `metadata.ruleId` when it carries
  one, and the body, so two rules on the same event are never deduplicated against each other. With
  neither an event id nor a tag the key is a hash of title, body, device id and rule id.
- Only a complete read may call a member's target unknown. When a holder of `notification-output` could not
  be read and the target is missing, the member FAILS (the outbox retries it); it is never skipped (D49).
- Each member receives the notification clamped to ITS OWN kind's caps (body length, attachments, actions,
  level, sound, click URL), read from the catalogue at send time with the group's own kind dropped at the
  source (`readMemberKinds`). When that read fails the group warns and sends the member unclamped, so the
  member's provider degrades it by its own caps.
- A group has no secrets and no destination keys (D634): members keep their own.

No capability changes: only a provider and a record kind are added.

## Consequences

- The save-time nested check (`refuseNestedGroups`) reads the group ids from the instances store, so it
  sees every stored group; the send-time skip remains the guarantee.
- `SendResult` carries no per-member breakdown: the summary is in `error` on failure, and the detail is in
  the logs. A test panel showing sent / skipped / failed per member needs a cap field and is a later step.
- Escalation and content routing are not part of this record.

## Enforcement

Specs in `packages/system/src/builtins/core-notifier/__tests__` (fan-out, nested refusal, retry only
re-sends failures, throttle, alarm gate, per-member clamp, static caps, the group listed as an instance) and
`packages/types/src/notification/__tests__/notifier-group.spec.ts`.
