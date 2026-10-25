---
id: D178
title: An absent subject is photographed — by ONE shelf, gated where the absence is known
status: accepted
date: 2026-08-18
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/still-shelf.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
last-verified: 2026-10-03
---

## Context

Diagnosed live on 2026-08-18: the occupancy "posto libero" [free spot] notifications from
camera 102 (parking) ship text-only, twice a day, and the dispatcher says
exactly why —

```
no still could be resolved — this notification ships text-only
  recordKind=device-event policy=best frame=full owners=[]
```

`owners=[]` is not a media failure. It is the payload declaring that it froze no
media owner at all: a became-free edge has no member left to name
(`chooseOccupancyMediaOwner` returns `undefined` by construction), so the
attachment ladder has nothing to climb. The GIF cut from the clip ring worked
throughout, because `renderFootage` is given a camera and an instant.

This is the same fault D165 fixed for audio, one trigger later, and the same
sentence describes both: **the subject is an ABSENCE.** A sound that has stopped
owns no frame; a parking space owns no object precisely because the object left.

Two ways to fix it were available:

1. a twin module beside `audio-still.ts` for the occupancy edge, and
2. generalising `audio-still.ts` into one shelf both triggers use.

(1) was rejected. Everything in the audio shelf — the capture kicked off and
never awaited, the owner id minted synchronously so the outbox row can name it,
the per-camera reuse window, the TTL sized to the outbox retry horizon, the
downscale, the `tags: { deviceId }` lines — is trigger-independent. Only the GATE
differs, and the gate is not in the shelf: it is at the trigger site, where the
rules are. A twin would have been a second derivation of one mechanism, with two
TTLs to keep in step and two places for a snapshot-cap fix to land.

## Decision

**One still shelf** (`still-shelf.ts`, `NcStillShelf`, owner-id namespace
`nc-still:`) serves every trigger whose subject is an absence. The trigger rides
along as `NcStillTrigger` for the LOG NOUN only — it changes nothing about the
capture, and the reuse window stays per-camera and trigger-agnostic, because a
sound and an emptied zone ten seconds apart are two claims about one scene.

**The gate lives where the absence is known, and is exact.** For occupancy that
is `onOccupancyEdge`, and it photographs an edge only when BOTH hold:

- the edge names **no `mediaTrackId`**. A member track is a picture OF the
  counted object; a photograph is only ever the stand-in for not having one. The
  gate is the absence itself, never the polarity — a became-occupied edge whose
  members are all parked (`stationary:`) owns nobody either and gets one too.
- some enabled `device-event` rule with `media.attach !== 'none'` **would
  actually fire on this edge** — decided by `matchesOccupancy`, the same
  predicate `evaluateRule` applies, exported rather than restated. The watcher
  commits BOTH polarities of every watched key, so a hub carrying only a
  became-occupied rule still produces free edges; photographing those would be a
  snapshot no notification can ever carry.

A shelf id is not a subject: `admitToGroup` declines any `isStillShelfId`
trackId — once, for every trigger the shelf serves, rather than as a growing list
of subject kinds.

## Consequences

- The dispatcher still has NO branch for any of this. A shelf id resolves through
  the same `getMediaForOwner('track', …)` seam the synthetic-media map uses.
- The owner-id namespace changed from `nc-audio-still:` to `nc-still:`. Nothing
  durable descends from either: the shelf is RAM, and a respawn already cost the
  picture on rows still queued. An outbox row that survives the upgrade names an
  id nothing resolves and ships text-only — which is what a respawn did before.
- A camera that will not answer costs the picture and never the notification:
  `the camera did not answer the <trigger> still — this notification ships
  text-only` (warn, `tags: { deviceId }`).
- A node with no snapshot cap wired keeps the old behaviour exactly — text-only,
  and `occupancy-media.spec.ts` still pins that state.
- The shelf now has two callers, so its ceilings (`MAX_CAPTURES`, the reuse
  window) are shared. They were sized for "every camera on the hub triggers once
  inside one TTL", which the addition does not change.

## Enforcement

`occupancy-media.spec.ts` and `audio-rule-media.spec.ts`, both against the LIVE
centre: the discriminating assertions are that the subject names an `nc-still:`
owner and that the frame never came out of `getMediaForOwner`. Three negative
controls pin the gate — an edge that owns a member track, an edge no enabled rule
matches, and a rule wanting no still all photograph NOTHING. Beyond that, review:
nothing mechanically stops a third trigger from growing a twin shelf.
