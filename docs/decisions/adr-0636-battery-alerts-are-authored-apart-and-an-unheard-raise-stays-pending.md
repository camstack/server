---
id: D636
title: Battery and consumable alerts are authored apart, excluded by device, and never recorded as heard when no rule heard them
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/alerts/device-alerts.ts
  - packages/addon-post-analysis/src/notification-center/alerts/alert-episode.ts
  - packages/addon-post-analysis/src/notification-center/alerts/alert-store.ts
  - packages/addon-post-analysis/src/notification-center/device-prune-runner.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/addon-admin-ui/src/pages/system/device-picker-model.ts
  - packages/addon-admin-ui/src/pages/system/DevicePicker.tsx
  - packages/addon-admin-ui/src/pages/system/alarm-nonblocking.helpers.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-events.ts
  - scripts/check-device-selection-in-sync.ts
  - scripts/check-nc-mirrors-in-sync.ts
---

## Context

For two weeks the operator received no battery or consumable alert, while the
producer worked: the thermometer 3615 sat at 0 % with its episode at reminder
r45, and the vacuum 4385 had two consumables at 13 %. The only rule carrying
those kinds was the generic "Eventi di sistema", and it carried them under
`deviceTypes: ['camera']` — a filter authored for liveness. Every battery on
the hub belongs to a sensor, a container, a vacuum or a mower, so every event
was refused by the rule's own filter; the only trace was an INFO line.

Three more things made it worse than a mis-set filter:

- the episode was stamped `lastNotifiedAt = now` whether or not any rule
  matched, so fixing the rule would have delivered the open episode only at its
  next reminder (≤ 12 h), and with reminders off never;
- `NC_CONDITION_CATALOG` lacked `device-battery-low/normal` (only the admin's
  own list had them) and nothing compared the two;
- `NcDeviceAlerts.forget` had no caller and cleared only the RAM battery
  reading — the alert rows of a deleted device lived forever, and the subject
  parser read `consumable:<id>:<key>` as "no device" (last segment), so those
  rows carried no `deviceId` column and their log lines no `deviceId` tag.

Alternatives weighed and rejected: scoping battery/consumable kinds to
`deviceIds` only in `systemEventFilterApplies` (a semantic change to a shared
predicate, invisible to the operator who set the filter); a stored
"section" field on the rule (a second authority over what the kinds already
say); re-evaluating an undelivered episode on every tick (hundreds of slice
writes an hour, forever, for an alert nobody wants).

## Decision

1. **A system rule whose kinds are ALL battery/consumable is a battery rule.**
   The viewer lists and creates it in its own section ("Batteria e
   consumabili"); the generic System section no longer offers the four kinds
   (a rule already carrying one still shows it where it lives). On the hub it
   is an ordinary `system-event` rule — the section is derived from the kinds,
   never stored.
2. **Both editors WARN when a battery/consumable kind meets `deviceTypes`.**
3. **`systemEvent.excludeDeviceIds`**: include first, then exclude; same kind
   family as `deviceIds`; never fails closed; a consumable subject is excluded
   by its device id; the exclusion is named (`excludedBySystemEventFilter`).
4. **A raise no rule matched stays PENDING** (`alerting`, `lastNotifiedAt: 0`)
   and is re-offered — same record id — on the reload tick when the rule set
   changed since its last offer, OR once per re-notify interval (hourly when
   reminders are off): a raise refused only by a rule's SCHEDULE must be heard
   when the window opens, and the rules do not change when it does. A
   reminder or a recovery is never re-offered, and a pending episode that
   recovers says nothing (there was nothing to recover from).
5. **A deleted device's alert rows go with it** through the D633 prune path:
   the second read must agree, the reconcile looks at alert devices no rule
   names, and the subject's device is its SECOND segment.
6. **Every notification device selection is ONE smart picker** — chips, a
   debounced search, (type, room) groups collapsed past a size with select-all
   / clear, a bounded render — whose decisions (`device-picker-model.ts`) are
   byte-identical in the admin UI and the viewer.
7. **The alarm's non-blocking picker offers EVERY opening of the household**,
   marking one no rule of the mode covers ("never blocks"). Which devices are
   openings is ONE targeted, ids-only read — `deviceManager.listDeviceIdsByCaps`
   (`contact`, `cover`, `lock-control`), resolved server-side with
   `getBindings`' resolver — and the viewer's battery section offers only the
   devices `listDeviceIdsByCaps(['battery','consumables'])` answers. Names come
   from the targeted `listAll({ deviceIds })`. (The first cut read the whole
   fleet and `getBindingsBatch` over ~900 ids in five calls; review I2.)

## Consequences

- The viewer's battery section is superseded by the device-events family (D637).
- An operator who fixes a rule hears an open episode within one reload tick.
  An episode with no rule at all is offered once per rule change (and once per
  process start) — bounded by the number of open episodes.
- A crash between the optimistic stamp and the door's answer counts as heard
  (the pre-D636 behaviour); the outbox dedup (`<subject>:<since>`) keeps a
  re-offer from delivering twice to a rule that already delivered it.
- A mute or snooze change does not re-offer a pending raise; only a rule
  change does.
- The viewer's rule mirror carries `excludeDeviceIds` ahead of the published
  `@camstack/types`; `nc-rule-mirror-parity.spec.ts` names it in a
  self-expiring `AHEAD_OF_PUBLISHED` list that fails once the release carries
  it. The viewer must ship after the `@camstack/server` train.
- `listDeviceIdsByCaps` walks every device's bindings SERVER-side (the
  `getAllBindings` pass, ~0.5 s on this hub) and ships only ids. An older hub
  lacks it: both UIs say they could not check, never "no opening" (D315).
- **Ship note — old viewers strip `excludeDeviceIds`.** Until the viewer OTA
  lands, a phone on an older build parses a rule WITHOUT the key and, on
  save, re-sends `conditions` whole — the exclusion is silently dropped and the
  rule widens. Author exclusions on the admin UI (or the updated app) until
  the OTA is out.

## Enforcement

- Types: `notification-rules.cap.spec.ts` pins the catalog's system-event
  options to `NC_AUTHORABLE_SYSTEM_EVENT_KINDS`, and the family list.
- Engine: `system-event-exclude-devices.spec.ts`; the family scope keeps
  `scripts/check-nc-system-filter-scope.ts` green.
- Alerts: `device-alerts-undelivered.spec.ts` (unit) and
  `battery-alert-undelivered-center.spec.ts` (through the real centre);
  `device-prune-alerts.spec.ts` for the prune.
- Server read: `bindings-store.spec.ts` ("listDeviceIdsByCaps answers ONLY the
  ids bound to one of the caps"); method tier `protected`, pinned in
  `scripts/method-tier-baseline.json`. The viewer's
  `check-cap-query-names.mjs` names it in `AHEAD_OF_PUBLISHED` until the published
  types carry it (the entry fails once they do).
- Mirrors: `scripts/check-nc-mirrors-in-sync.ts` now compares the top-level
  keys of the system-event condition schema (cap vs viewer) — a missing key is
  a field a phone save strips; `scripts/check-device-selection-in-sync.ts`
  pins the picker model and its spec byte-identical.
- Picker scale: `device-picker-model.spec.ts` (both copies) and the two mount
  specs render 500 devices of one type and assert the DOM holds a bounded
  window (admin ≤ 60 rows per page, viewer ≤ 30).
