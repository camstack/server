---
id: D705
title: An alarm incident is one grouped window — the triggered notification tiles every trigger of its entry delay
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-transitions.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-incident-group.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-mosaic.ts
---

## Context

[D692](adr-0692-a-grouped-immediate-rule-waits-for-its-subjects-and-sends-once.md) gave a
grouped detection rule one message with a mosaic of every subject in its window. The
operator asked for the same on ALARM notifications (2026-10-06): "a mosaic of the triggers".

The combined alarm-triggered row ([D126](adr-0126.md), `notifications.md` § "The alarm SPEAKS") carried
the pictures of ONE match: the rule fire that started the entry delay. Every later match during
the delay pressed `alarm-panel.trigger`, the panel refused it (`pending` is already running),
and the note it left was neither used nor dropped. Those subjects reached the operator only as
their own detection pushes, and never in the alarm notification. The doc comment on
`noteRuleTrigger` said "last writer wins … the second one's pictures are the more recent".
The code did the opposite: the claim was frozen at the first accepted trigger.

## Decision

An alarm incident is a D692 grouped window, written onto the combined `alarm-triggered` row
as its `payload.group`. There is no second mosaic implementation and no new switch.

- **The window is the entry delay.** It opens at the source match and closes when the alarm triggers
  (`closeReason: 'deadline'`).
  - A match the panel refuses while `pending` becomes a FOLLOWER (`NcAlarmAttribution.follow`).
  - A match while `triggered` does not: that notification has already left. Rejected
    alternative: hold the alarm-triggered row for a grouping time. That delays the one notification that
    must not wait.
- **A member is a fire ref with a media owner.** That is a detection track, or a sensor's
  RAM photograph (linked-camera set or still shelf).
  - A sensor nobody photographs has no tile.
  - Fewer than two members means no group, and the row is byte-identical to D126.
- **Only an incident a rule started collects followers.** A manual trigger has no combined row,
  and a follower never becomes the source, so the sentence stays the source's.
- **Followers are bounded** at `NC_ALARM_INCIDENT_MAX_FOLLOWERS` (15). Members are
  deduplicated by subject. Every follower not kept is logged with its reason, tagged with its
  camera.
- **The dispatcher reads the group exactly as it reads a grouped detection row,** with two
  corrections in `groupedTileEntry` that apply to every grouped row:
  - a tile drops the row's `systemEvent`, so the object read uses the member's OWN generation
    and not the alarm source's (D694);
  - a member owned by a RAM photograph is tiled `full`, because the shelf holds no subject crop.
- **The sentence does not change.** The group subject text is gated off on a system-event row.
- **Supersede covers the followers too.** Each follower's still-pending detection row is
  withdrawn for the targets the alarm reached.

## Consequences

- Entry delay 0 means no followers and therefore no mosaic.
- The mosaic's footage anchor moves from the trigger instant to the window's opening (the
  source match). This is D692 §6.3, applied to the alarm.
- The hydration of notified tracks and the cooldown reseed read a row's group only on
  `object-event` rows. An alarm's group guards nothing.
- `{{detectionSummary}}` renders the incident's class composition on an alarm row. A sensor
  member counts as `event`.

## Enforcement

Tests, each with a revert check:

- `alarm-incident-followers.spec.ts` (real panel);
- `alarm-transitions.spec.ts` (attribution);
- `alarm-incident-group.spec.ts`;
- `grouped-mosaic.spec.ts` § D705 (tile generation, shelf frame, sentence);
- `alarm-notifications.spec.ts` § D705 (row group and follower supersede).
