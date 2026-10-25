---
id: D897
title: A notification picture is one mode, rendered once from the clean frame of the moment
status: accepted
date: 2026-10-21
supersedes:
applies-to:
  - packages/types/src/notification/media-image.ts
  - packages/addon-post-analysis/src/notification-center/notification-image.ts
  - packages/addon-post-analysis/src/notification-center/tracks-at-instant.ts
  - packages/addon-post-analysis/src/notification-center/media-guard.ts
---

## Context

A rule stated its picture as three fields — `attach` (`best` / `best-matching`
/ `keyFrame` / `none`), `frame` (`cropped` / `full` / `boxed`) and `zoneCrop` —
and each fed a ladder that picked a STORED kind. `best` walked subject crops and
ended in the boxed `firstFrame`, so one rule shipped a crop on one event and a
boxed scene on the next depending on what had landed; boxes were burnt only at
WRITE time and only around the track's own box; `zoneCrop` forced the clean
ladder and silently dropped `frame`. A sensor rule ignored its stored choice for
a fixed snapshot (2026-10-01), a sound's still, a linked camera's extra still and
a mosaic tile each had their own idea of the picture, and the combined alarm row
froze the SYSTEM rule's zones (none) instead of the source rule's, so its PLACE
filter never ran.

Kept: picking the frame by MOMENT then PLACE (D225, D223) and the D654 clean twin.
Rejected: a fourth `frame` value (`scene-boxes`) on top of the triple — it would
have kept two fields that can disagree, and a third ladder.

## Decision

A rule's picture is ONE field, `media.image`: `scene-boxes` | `crop` | `clean` |
`none`, plus `showTriggerZone`. Every still — every rule kind, a linked camera's
extra still, a mosaic tile — goes through one stage, `notificationImage`, which
starts from the CLEAN source frame of the moment (`cleanSourcePreference`:
keyFrame → sceneFrame → lastSceneFrame, after MOMENT and PLACE) and renders by
mode: `scene-boxes` draws the subject thick in the accent colour and every other
track visible on that camera at that instant thin, captioned "class NN%", from
their normalised trail boxes AT the source frame's timestamp (never the track
envelope); `crop` cuts the subject's box out of that frame; `showTriggerZone`
outlines the firing zone on a scene mode and is refused on save on a rule whose
trigger is not a zone. A mode that cannot be honoured ships `clean` and names the
reason once per record. The render is memoised per record + subject + mode + zone
flag + camera for 15 minutes, so N targets and retries render once. The "tracks
at an instant" read is an internal dependency of the Notification Center (it runs
in the pipeline-analytics process that owns the track store), not a capability:
it has one consumer.

## Consequences

- Stored rules map on load (`normalizeNcMediaPolicy`, a read projection) and on
  every save: best / best-matching / default / `cropped` → `crop`; `full`,
  `keyFrame` → `clean`; `boxed` → `scene-boxes`; `zoneCrop` → `clean` +
  `showTriggerZone` (only on a zone rule); `none` → `none`. A sensor rule written
  before D897 maps to `clean` whatever it stored, because that is what it
  shipped. GIF / clip / rolls / profile are carried untouched — so a sensor rule
  that STORED a gif or clip before the 2026-10-01 ruling now cuts it.
- `best-matching` is gone: a crop is rendered from the scene around the subject's
  box, not picked from `faceCrop` / `plateCrop`. A record that holds only stored
  crops and no scene frame ships text-only.
- An outbox row freezes `mediaImage` / `mediaShowTriggerZone`; a row written
  before D897 is read through the same mapping (`payloadImageMode`).
- The boxed timeline tiles (`firstFrame` / `lastFrame` / `snapshot`) are still
  written: the event detail panel, the debug track analysis, the thumbnail
  resolver and the track audit read them. The notification reaches one only for
  a track that holds no clean frame, and ships it as stored.
- The legacy triple stays in the schema as deprecated INPUT until the viewer
  editor writes `image`; the hub folds it on save.

## Enforcement

`media-image.spec.ts` (types: the mapping, marked fixture),
`media-policy-save.spec.ts` (the save guard on the cap route and the load
projection, marked fixture), `notification-image.spec.ts` (sampled pixels of
every mode, subject vs other styles, captions, memo, fallback reasons) and
`dispatcher-notification-image.spec.ts` (every mode starts from the clean frame,
a sensor renders from its linked camera, one render for three targets).
