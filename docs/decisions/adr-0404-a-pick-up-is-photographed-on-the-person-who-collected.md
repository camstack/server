---
id: D404
title: A pick-up is photographed on the person who collected it
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-collector-mirror.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
---

## Context

A `package-picked-up` notification exists to answer one question: **who took my
parcel**. It answered a different one.

The pick-up row is a standard `ObjectEvent`, and the notification's still ladder
resolves media by OWNER — `event:<eventId>` first, then `track:<trackId>`
(`dispatcher.ts` `resolveAttachment`). Nothing ever writes media under a pick-up
event id, so the picture always came from the row's `trackId`, and `onDeparted`
set that to `entry.sourceTrackId ?? entry.id` — the PARCEL's own stationary
track, carrying the parcel's bbox and the parcel's frames. The operator was sent
a photograph of the doormat the parcel used to sit on.

The obvious fix — look at the live tracks when the pick-up fires — does not
work, and that is the whole reason this record exists. A departure is not
observed, it is **concluded**: `PackageStillnessTracker` retires a promoted
candidate only after `PACKAGE_STILLNESS_TTL_MS` (5 minutes of OBSERVED time)
with no re-association, and on a session-dispatch camera that is longer again in
wall clock. By the time `onDeparted` runs the collector's track is closed, its
resident state dropped, and the frame is of a scene the pick-up has left. The
answer has to be recorded while it is still true.

Something already recorded half of it. The stillness path stamps
`lastNonPackageActivityAt` for any non-package track inside a configured
drop-off zone — the exact population a collector is drawn from, and the gate
that already decides a disappearance is a pick-up at all rather than the
detector losing the box. It kept only a timestamp, which answers "was somebody
around" and can never put a face on the notification.

## Decision

The pick-up row's media owner is the **collector**: `PackageCollectorMirror`
records, per camera, the non-package tracks seen inside a drop-off zone
(trackId, presence span, native key-frame media KEY — handles, never pixels),
and at departure `pickCollector` names the presence nearest the **parcel's last
sighting** (`entry.lastConfirmedAt`, never the departure timestamp). That
trackId becomes `ObjectEvent.trackId` on the pick-up row and its key frame the
row's `mediaKey`, so the picture resolves through the ordinary
`getMediaForOwner('track', …)` ladder — the same vehicle as the doorbell's
marker track and the occupancy edge's `mediaTrackId`, with **no package branch
on the notification path**.

Nearness beats quality, always: of two candidates, the one closer in time to the
pick-up instant wins even when the other has a longer, better-lit,
higher-confidence track. Nothing scores confidence or crop area. An exact tie
breaks toward the LATER presence — the one still there after the parcel went.

When nobody qualifies (nobody within `PACKAGE_COLLECTOR_MAX_SKEW_MS` = 30 s of
the last sighting, or no drop-off zone configured), the pick-up **still fires**,
degraded to the parcel's own owner, and both the producer and the detector log
that with `tags: { deviceId }`. The notification is never conditional on the
picture.

## Consequences

- The pick-up row's `trackId` no longer names the parcel, so the row cascades
  under the COLLECTOR's retention prune. That is the coupling that matches the
  media it points at, and the delivery↔pick-up pairing is unaffected: it runs
  on the deterministic `pa-pkg-<entryId>-{delivered,pickedup}` ids, never on a
  track.
- `PipelineAnalyticsPackagePickedUpPayload` gained an optional
  `collectorTrackId`, so a bus consumer can say who without re-deriving it.
- The mirror is RAM-only and bounded twice: `PACKAGE_COLLECTOR_RETENTION_MS`
  (10 min of frame time — double the departure latency it has to outlive) and
  `PACKAGE_COLLECTOR_MAX_PRESENCES` (32 per camera). It is dropped on unbind and
  on device removal alongside the rest of the package state.
- The skew bound is the honest limit of the claim. A collector 31 s from the
  last sighting is refused rather than guessed at — a picture of the wrong
  person is worse than a picture of the doormat, because only one of the two
  looks like an answer.
- `narrowToTriggerInstant` still scores stills against the ROW's timestamp,
  which is the conclusion instant and can be minutes after the collector's
  frames. Under `freshness: 'any'` that degrades to the ladder head with a
  logged offset, which is the collector's frame; under `trigger-only` it can
  empty. Moving the pick-up row's own timestamp back to the pick-up instant is a
  separate change and is deliberately not made here.

## Enforcement

`package-collector-mirror.spec.ts` pins the choice rule (nearest wins over
longer-lived, the tie-break, the skew refusal, both bounds) AND the production
reader `noteFrame` — the same function `runPackageStillness` calls, so the test
path cannot supply what production forgot to gather.
`package-drop-detector.spec.ts` pins that the row names the collector, that the
delivery row still names the parcel, that a pick-up with no collector still
fires with the parcel's owner, and that the degrade is logged with a `deviceId`
tag. Review only for the wiring line in `index.ts`.

## Amendment, 2026-09-29 — the pick-up's FOOTAGE is about the pick-up too ([D682](adr-0682-a-pick-ups-footage-is-cut-around-the-pick-up.md))

The last consequence above left the row's timing open, and the gif is where it
showed. The still resolves by owner and was right; the gif is cut by time
window, and the window was centred on the CONCLUSION — five minutes after the
parcel went — so every pick-up gif on 101 showed the empty doormat (283529 on
2026-09-29, 248735 on 2026-09-26).

The row's `timestamp` still means the conclusion. What changed is beside it:
the detector now hands `observedAt = collector?.observedAt ??
pickupInstantOf(entry)` with the persisted row, the notification subject carries
it, and the footage is anchored on it. Because that moment is always outside
the clip ring, a gif-only rule's gif is now cut from the recordings and follows
the alert under the same tag. See D682 for the full decision.
