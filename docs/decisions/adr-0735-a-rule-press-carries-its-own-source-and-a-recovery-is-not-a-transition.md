---
id: D735
title: A rule press carries its own source and an anonymous rule press is refused; a recovery to the same value is not a transition; "ignored" is told only for a real move
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-transitions.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-port.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-exclusions.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-push-policy.ts
  - packages/addon-provider-homeassistant/src/ha-change-stamp.ts
  - packages/addon-provider-homeassistant/src/devices/ha-binary-sensor-device.ts
  - packages/types/src/notification/alarm-settings.ts
---

## Context

2026-10-07 02:32Z, a false alarm. Night was armed with four contacts open and
excluded (4171 porta porch, 3243 finestra porch, 4138 finestra studio, 3293
cameretta Carol). Zigbee2MQTT restarted and the four came back
`unavailable → on`. HA hands a recovery a fresh `last_changed`, the HA provider
wrote it into the slice, and the post-analysis sensor gate — its memory empty
since the 23:16Z hub restart — read "first sighting, active, fresh stamp" as four
openings. The rule "Allarme notte — sensori e serrature" matched all four within
~60 ms.

Each match pressed the panel through an awaited `ctx.api` actuation (3–27 ms).
The SOURCE of the press — which sensor, which rule — could not ride the cap
(`alarm-panel.trigger` takes a device id; a Home Assistant panel provides the
same cap), so D126 parked it in ONE slot on the panel (`NcAlarmAttribution.note`)
just before the call, for the cap's `trigger` to read when it landed. Two matches
1 ms apart (4138, then 3293) overwrote the slot; one press read nothing,
computed `source = undefined`, skipped the exclusion check — which only runs when
a source names a sensor, so a missing source FAILED OPEN — and triggered. The
alarm row had no source and no "Intrusion: <places>" body. The same four matches
also pushed the rule's own "Contact on porta porch" rows, and the panel's
"Ignored: it was open when armed" was sent for a contact that had not moved.

Alternatives weighed:

- **A queue instead of a slot.** Orders presses, but still hands a source across
  an await to whoever reads next; a press that fails before landing desynchronises
  it. Rejected: the source must not be parked at all.
- **Fix the recovery edge in the gate.** The gate cannot see the outage (the
  provider drops `unavailable`) and, with empty memory, cannot tell a recovery
  `on` with a fresh stamp from an opening. Rejected as the primary fix; the
  provider owns the device fact (D224).
- **Keep "ignored" as it was and only add a switch.** The four "Ignorato" pushes
  were about contacts that never moved; a switch alone would still send them to
  anyone who turned it on.

## Decision

1. **A rule press carries its own source, synchronously.** A press of THIS node's
   panel by a rule is `NcAlarmPanelDevice.triggerFromRule(source)` — called
   in-process by `autoTriggerAlarmPanel` and by the actuation seam
   (`actuateWithAttribution`) — and never goes through the cap. There is no slot,
   no note and no TTL. The cap's `trigger` is the manual/external press and
   carries no source by construction.
2. **Fail closed on a missing source.** A press of the local panel from the
   actuation seam with no source (an activation binding, a button-run sequence)
   is REFUSED, with an ERROR line, while the current arm excludes any sensor.
3. **A match of an excluded sensor sends no rule push.** `classifyRuleMatch`
   answers `excluded`; the verdict is `suppress` with reason
   `alarm-sensor-excluded`, never waived.
4. **A recovery to the value already held is not a transition.** The provider
   decides the change stamp (`ha-change-stamp.ts`): the same value as the last
   KNOWN value keeps the previous stamp (the slice is rewritten identical, so no
   consumer sees an event); a recovery from `unavailable`/`unknown` with nothing
   known before it is stamped `1` (known value, unknown change time — never a
   fresh edge) and logged; only a real change takes HA's `last_changed`.
5. **"Ignored" is told only for a real move.** The `alarm-sensor-bypass`
   "ignored" row is sent only when the excluded sensor's reading is an `open`
   whose own change time is after the arm while its exclusion is still in phase
   `open` (`NcAlarmExclusions.takeMoved`), and only when the armed mode's
   `notifySensorIgnored` switch is on (default OFF, beside
   `notifySensorRewatched`). A re-sync, a recovery or a duplicate is a line,
   never a push; once per sensor per arm still holds.

## Consequences

- The combined notification (D126) and its followers (D705) are unchanged in
  shape; only the hand-over moved from a slot to a parameter. D126's "note before
  the actuation" mechanism is retired.
- A rule press of the local panel no longer depends on an actuator being wired.
- A button-run sequence that presses the local panel's trigger fails while the
  arm excludes something; a person's trigger from the UI is unaffected.
- The provider fix is live only after `addon-provider-homeassistant` is deployed;
  other providers that reset their stamp on recovery are still exposed (Homematic
  already stamps replays `1`). Lock and cover keep their stamp only for outages
  this process saw: their constructors still seed a cold slice.
- "Ignored" pushes effectively stop: under the two-phase lift a sensor that is
  seen closing and opening is re-armed, not ignored, so a real move while still
  excluded means the close was missed.

## Enforcement

Specs, each revert-checked:
`notification-center/__tests__/alarm-rule-press-attribution.spec.ts` (the four
back-to-back matches with a deferred actuator stay `armed_night`, four
"ignored", zero `alarm-triggered`; on the slot design it TRIGGERS with no source;
the anonymous seam press is refused; "ignored" only for a real move with the
switch on), `alarm/__tests__/alarm-push-policy.spec.ts` (the `excluded` verdict),
`alarm/__tests__/alarm-arm-refusal.spec.ts` (re-sync / recovery never announced,
the switch, the duplicate), and
`addon-provider-homeassistant/src/devices/__tests__/ha-recovery-change-stamp.spec.ts`
(the exact 02:32 sequence keeps the 18:05 stamp and is no edge for a consumer
started at the hub restart). No guard script.
