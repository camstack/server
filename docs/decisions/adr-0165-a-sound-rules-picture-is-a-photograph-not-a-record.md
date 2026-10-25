---
id: D165
title: A sound rule's picture is a PHOTOGRAPH, taken at the match and held in RAM — never a record
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/still-shelf.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/types/src/notification/rule-kinds.ts
---

## Context

The operator's report, 2026-08-15: an audio rule shows `media: none` and cannot
be made to attach anything, while every other rule can ask for a snapshot, a GIF
and a clip.

Both halves of that were true, and only one of them was about audio.

**The GIF and the clip worked the whole time.** `renderFootage` is given a
CAMERA and an INSTANT — it has never read anything track-shaped — so a cut
around an audio confirmation has always been available. What made it
unreachable was the admin editor: `notification-rule-kinds.ts` declared the
`sound` kind `carriesMedia: false`, hid the whole media section, and
`buildRuleInput` then wrote `media: { attach: 'none' }` on every save. A correct
statement about the STILL had been generalised into a policy about all media,
and it took the footage with it. (The viewer never made that mistake: it gates
media on `delivery !== 'system-event'`, and a sound rule rides `immediate`, so
the app has been offering controls the hub was overwriting.)

**The still genuinely did not exist.** The attachment ladder resolves media by
OWNER, and every other trigger has one — an object or package event owns its
crops, a closed track its best shot, a doorbell press the marker track the same
press projected (D62 §8), an occupancy edge one of the objects it counted
(D-occupancy-media). A confirmed audio window owns nothing: nothing was boxed,
nothing was tracked, and nothing is persisted at all, deliberately — a window is
a claim about sound that has already stopped, which is why `event-intake.ts`
refuses to replay one after a crash.

The obvious fix was to copy the doorbell exactly: materialise a synthetic marker
track through `SyntheticTrackMaterializer` and let the notification name it.
**That was rejected**, and the reason is the whole record. A synthetic track is
a durable `Track`. Every confirmed window would write one, and it would then be
counted by the digest's `listTracks`, retained and swept by the retention pass,
drawn on the camera's timeline, and — worst — it would bypass the ceilings the
audio-marker feature exists to impose. `audio-marker-projector.ts` gates markers
on anomaly, motion-quiet, a cooldown, `maxPerHour` and `maxPerDay`, and ships
DISABLED so the operator can measure the rate before paying for a single row.
A notification rule that manufactured markers behind that switch would make an
operator-facing budget unenforceable.

## Decision

**An audio match's media owner is a PHOTOGRAPH, not a record.** At the
confirmation — both D157 modes, and the legacy `audio-*` class trigger — the
centre mints an owner id synchronously, starts a snapshot of the camera without
awaiting it, and holds the bytes in RAM on `NcStillShelf` under a TTL that
covers the outbox's retry horizon. The subject names that id on `trackId`, the
outbox freezes it exactly as it freezes a marker track, and the dispatcher
resolves it through the same `getMediaForOwner('track', …)` call every other
still comes out of. **There is no audio branch on the notification path**, and
nothing durable descends from a sound.

Three properties are load-bearing:

- **The capture starts before the evaluation.** A sound is transient; a still
  fetched after the cooldown verdict is of a scene the noise has left. It is
  never awaited — a notification about a scream must not wait on a camera.
- **The gate is the RULE's `media.attach`, never the trigger.** Photographing on
  every confirmed window for rules that ship text anyway would be a snapshot at
  whatever rate the sound happens to occur.
- **Two confirmations within ten seconds share one capture, under two owner
  ids.** Label mode has no re-arm timer at all (D157) and the cooldown is
  applied afterwards, so the reuse window is the only bound on the snapshot cap.
  Distinct ids keep two outbox rows from ever reading as one subject growing.

The picture is the whole downscaled scene (`keyFrameSmall` / `keyFrame` /
`fullFrame`, ≤960×540) and deliberately no `crop` or `thumbnail`: nothing was
boxed. The `sound` kind is therefore `carriesMedia: true` and
`carriesSubjectCrop: false` — it gets the attachment controls and not the two
that cut a region, because `frame: 'cropped'` would resolve nothing and
`zoneCrop` has no zone ids to use (a sound rule excludes `zones`).

## Consequences

- **A respawn loses whatever has not been attached yet.** The bytes are RAM and
  only RAM, so a restart costs the picture on rows still queued and nothing
  else — the same trade the group buffer makes. A durable owner would have cost
  a durable record, which is the thing this record refuses.
- **Grouping stays OFF for audio subjects**, explicitly rather than by accident.
  Before the shelf, `admitToGroup` declined every audio subject because it had
  no `trackId`; now it has one, and grouping it would group PHOTOGRAPHS.
- **A rule asking for `frame: 'cropped'` on a sound rule gets text.** Authorable
  only through the API or a stored legacy value — the editor no longer offers
  it — and it is reported by the dispatcher's ordinary
  `no still could be resolved` line.
- **`triggerCanCarryStill` is now "everything but `system-event`".** An
  infrastructure event is about no camera at all; there is nothing to
  photograph. The per-rule Test button consequently reports `live` or
  `unavailable` for a sound rule instead of `unattachable`.
- **`footage.attempted` stopped standing in for "we already waited".** The
  re-read after a render now falls back into the same bounded still-wait a
  footage-free rule gets, because `renderFootage` returns in milliseconds when
  the broker declines — and an audio still lands a beat after the match. Gate on
  whether the media LANDED, never on a proxy for elapsed time (D58).
- **No train.** Nothing here touches `packages/types`: `NcMediaPolicy` already
  carried every field, so a sound rule authored with `attach: 'best'` validates
  against the installed server closure today. `camstack deploy` of
  `addon-post-analysis` and `addon-admin-ui` is the whole delivery.

## Enforcement

`audio-rule-media.spec.ts` drives the real `NotificationCenter` end to end for
both D157 modes and the legacy trigger, and pins each decision above: that the
frame is resolved through the ordinary owner lookup (removing the `trackId`
spread turns three tests red), that a refusing camera costs the picture and not
the notification, that a rule with `attach: 'none'` photographs nothing, and
that the gif and the clip are cut around the match instant with the rule's own
roll. `dispatcher-still-rescue.spec.ts` pins the `attempted` correction in both
directions. `notification-rule-kinds.spec.ts` pins the editor's two flags
against the real condition catalog.
