---
id: D701
title: An alarm rule gated on armed_* auto-triggers the panel; post-siren policy lives per mode
status: accepted
date: 2026-10-04
supersedes:
applies-to:
  - packages/types/src/notification/alarm-membership.ts
  - packages/types/src/notification/alarm-settings.ts
  - packages/addon-post-analysis/src/notification-center/**
  - packages/addon-admin-ui/src/pages/system/alarm-mode-card.tsx
  - packages/addon-provider-hikvision/src/accessories/siren.ts
---

## Context

Alarm rules gated on `armed_*` notified without calling `alarm-panel.trigger`
unless an `onTrigger` sequence did. After the operator deleted those sequences,
sensors while armed produced notifications but never armed the panel. Separately,
post-siren behaviour was only "re-arm after N seconds" (`triggeredDurationSec`)
or "stay triggered" (`0`) — no auto-disarm. Hikvision sirens seeded
`pulseDurationMs: 0`, so a single `setState(true)` left the siren on.

## Decision

1. A rule gated on any `armed_*` word **auto-triggers** the CamStack
   `alarm-panel` on match (`ruleAutoTriggersAlarm`). It never actuates sirens.
   Explicit `onTrigger` bindings remain for extra actions; a second panel
   trigger while pending/triggered is already a no-op.
2. After-trigger policy lives on the **panel**, per mode (UI label: After
   trigger): `postTriggeredAction` = `rearmAfter` | `disableAfter` |
   `doNothing`, with `triggeredDurationSec` as the duration (ignored for
   `doNothing`). Stock default is **rearmAfter 10 s** (every mode inherits).
   Absent action on an old blob is derived: duration `>0` ⇒ `rearmAfter`,
   else `doNothing`; the stock `0` + absent/`doNothing` seed migrates once
   at panel boot.
3. Hikvision siren `pulseDurationMs` defaults to **5000**; accessories still at
   the old seed `0` migrate to 5000 on load.

## Consequences

- Alarm rules no longer need a "trigger the alarm" sequence to raise the panel.
- Sirens stay outside this path (device settings, Customize, or explicit Do).
- `disableAfter` emits `alarm-disarmed` with body key `…body.autoCleared`.

## Enforcement

Unit tests on `ruleAutoTriggersAlarm`, state-machine `disableAfter` /
`rearmAfter`, `derivePostTriggeredAction`, and Hikvision schema default.
Review for any new path that actuates sirens from alarm-rule match.
