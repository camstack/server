---
id: D911
title: A device that needs the operator raises a critical alert, and it notifies in the devices family
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/types/src/notification/alert-episode.ts
  - packages/types/src/notification/system-event-classes.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-provider-dreame/src/devices/dreame-pin-attention.ts
---

## Context

A Dreame robot camera without its privacy PIN failed `startMonitor` (code -1)
every 30 s, forever: the broker re-dialled the lazy source, the addon woke the
robot, the robot refused, and the only trace was a warning line. Nothing told
the operator. The alert centre already carries a critical alert from any addon
to the admin UI and, as an alert episode, to the notification centre — but as
`alert-critical`, in the `system` family. The rule operators build for their
devices ("Eventi di sistema — dispositivi") is the `device-events` family, so a
device's alert never reached it.

## Decision

A device that needs the operator raises a critical alert with
`source: { type: 'device', id: <deviceId> }`. The notification intake announces a
CRITICAL alert episode with a device source as `device-attention-required` /
`device-attention-resolved` (class `device-attention`, family `device-events`)
INSTEAD of `alert-critical`: one alert notifies once, through one family, and the
device id it carries makes the rule's device filters apply. Any other source, a
non-numeric device id, and a device-sourced `error` alert keep the generic
`alert-*` kinds. The episode ledger is unchanged — it still tracks the generic
kind. A refusal that needs the operator is terminal: the raising addon stops
retrying until the setting that fixes it changes (Dreame: `navigationAccessCode`).

## Consequences

A device-events rule hears device alerts; a `system` rule on `alert-critical` no
longer hears them. The viewer's rule editor and catalog mirror must learn the two
kinds (they are held back from the served catalog until then).

## Enforcement

`device-attention-intake.spec.ts` and `alert-episodes-center.spec.ts` (one
notification, never two), `template-var-parity.spec.ts`, and
`dreame-pin-attention.spec.ts`.
