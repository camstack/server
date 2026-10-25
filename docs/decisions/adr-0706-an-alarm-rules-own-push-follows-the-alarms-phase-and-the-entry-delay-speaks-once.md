---
id: D706
title: An alarm rule's own push follows the alarm's phase — the entry delay speaks once, an intrusion is titled by where
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-push-policy.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-close-pass.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-window-buffer.ts
  - packages/types/src/notification/alarm-settings.ts
  - packages/addon-admin-ui/src/pages/system/alarm-mode-card.tsx
---

## Context

On 2026-10-05 at 14:10 the hub was armed Away (exit and entry delay 30 s, re-arm 10 s
after a trigger). One person walking in produced **eleven pushes in 54 seconds**:

- "watched again" for a bypassed door;
- the door rule's own push;
- the entry-delay notification;
- three person-rule pushes during the delay;
- ALARM;
- one more person push;
- re-armed;
- and, 14 s later, a person push and a new entry delay.

Every alarm rule gated on `armed_*` presses the panel (D701) **and** sends its own push. D126
only merges the rule's push into the ALARM row while that push is still pending. With an entry
delay, the push left 30 s earlier, so nothing was merged. D705 put the delay's matches on
the ALARM mosaic, but their own pushes still went out. The door that rejoined the watch was
announced twice: once as "watched again", and once as the rule that started the delay.

The operator decided the policy on 2026-10-06.

We first tried to supersede the pushes at the moment the entry delay was announced, as D126
does. It cannot work: the drain takes a row within seconds, long before the
`alarm-pending` row is evaluated. Only a decision made when the rule matches is reliable.

## Decision

**The rule's own push follows the alarm's phase at the match.** The panel classifies each
match (`classifyRuleMatch`) BEFORE the match presses it, using the same reads as `trigger`.
`alarm-push-policy.ts` turns that phase into a verdict:

| phase of the match | its own push |
| --- | --- |
| starts the entry delay, or is the subject that started it | **not sent**: the entry-delay row speaks for it |
| entry delay running, mode `notifyDuringEntryDelay` off (default) | **not sent**: it is a D705 tile of ALARM |
| entry delay running, mode switch on | sent, **intrusion title** |
| triggered | sent, **intrusion title**, on the rule's own grouping |
| entry delay 0 (fires at once) | unchanged (D126 combines) |

- **Intrusion push.** This is the rule's own outbox row, with `payload.alarmIntrusion`
  frozen on it. Its title is `alarm.intrusion.title` ("Intrusion — Hallway piano terra"),
  naming the device LOCATIONS, or the device name when a device has no location. The rule's
  name and its authored title are replaced. The body is the ordinary detection sentence. The
  push is never merged into an alarm row.
- **Grouped rules.** A grouped rule (D692) applies the same verdict per member at the close.
  A suppressed member is dropped with a named fate, logged on the member's OWN camera.
- **Window keying during an alarm phase.** While the panel is in its entry delay or has
  triggered, an alarm rule's grouped window is keyed per RULE (`scope: 'rule'`), not per
  (rule, camera). Members from every camera share it. The same D692 window machinery is
  used; there is no second buffer.
  - The window is filed under the camera that opened it.
  - A member is found by its own camera and track.
  - The mosaic tiles every member on its own camera, at most 6 tiles.
  - The one push lists the distinct locations of its intrusion members, in arrival order:
    "Intrusion — Hallway piano terra, Hall".
  - Outside an alarm phase, and for every rule that is not an alarm rule, D692 keying
    (rule, camera) is unchanged.
- **Waived suppression.** A suppression is waived (WARN, push kept) when no enabled rule
  delivers the alarm row that would speak instead: `alarm-pending` for the starter,
  `alarm-triggered` for a match during the delay.
- **Entry-delay push.** It stays the one existing `alarm-pending` row, with its existing
  background Disarm button (D47).
- **ALARM body.** The ALARM body now names every location: `alarm.intrusion.body`, "Intrusion:
  Front door, Hallway, Hall", taken from the source plus the followers. The title is
  unchanged.
- **Re-armed title.** "Re-armed — <mode>" / "Riarmato — <mode>".
- **"Watched again".** It is sent only when the mode's `notifySensorRewatched` is on (off by
  default). It is never sent when that same opening starts the entry delay. The
  announcement is made after the event's evaluation, on the chain, so the panel can tell.
- **The two switches** are per mode, stored with the mode's delays (`modeDelays`). They have
  no global value: absent means off.
- **Stock re-arm.** The stock after-trigger re-arm becomes **30 s**
  (`NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC`, was 10 s under D701). This changes the seed only:
  a stored value is never rewritten.

## Consequences

- The 14:10 replay now gives 5 pushes by default:
  - entry delay;
  - ALARM with all three locations;
  - one intrusion;
  - re-armed;
  - the next entry delay.

  With `notifyDuringEntryDelay` it gives 8. With the switch and a 15 s grouping it gives 6,
  with ONE intrusion push for the three people the delay saw on two cameras. With a 15 s
  grouping and the default switch it gives 5.
- **The scope is decided at admission**, from the panel's state at that moment (the same
  mirror the rule gate reads). A starter admitted after its own press landed shares the rule
  window and is dropped there as the starter. A window that is open keeps the scope it
  opened with, even across a re-arm.
- **Fixed on the way.** The replay exposed two panel bugs:
  1. A press refused while `triggered` left its attribution note behind. The first press
     after the re-arm claimed it, so a new incident started under the previous subject.
     Every refusal outside `pending` now drops the note.
  2. An excluded sensor that is its own device carries no `sourceDeviceId`. The exclusion
     check read only that field, so such a contact could set the alarm off. The check now
     reads `sourceDeviceId ?? deviceId`.
- A suppressed push still pressed the panel and still runs its `onTrigger`: an actuation is
  never subject to the notification policy.
- The viewer does not need a change for correctness. It edits only the three delays, with
  per-field edits, so the switches survive a phone save. Until it gains them, the switches
  are admin-UI only.

## Enforcement

Tests, each revert-checked (removing the gate fails it):

- `__tests__/alarm-push-policy.spec.ts`: the 14:10 replay under default, `notifyDuringEntryDelay`,
  `notifyDuringEntryDelay` + 15 s grouping (one cross-camera push), default + grouping, and
  `notifySensorRewatched`. It also has one case per
  numbered behaviour and the waiver.
- `grouped/__tests__/grouped-window-buffer.spec.ts` § D706: rule-scope windows across
  cameras, the camera scope unchanged, and members found by their own camera.
- `alarm/__tests__/alarm-push-policy.spec.ts`: the pure verdicts, the real panel's
  classification, the stale-note and unowned-sensor fixes, "watched again", the stock 30 s,
  and the EN/IT words.
- `packages/types/src/notification/__tests__/alarm-notify-policy.spec.ts`: switches and
  edits.
- `packages/addon-admin-ui/src/pages/system/__tests__/alarm-notify-switches.spec.tsx`:
  admin-UI edits and labels.
