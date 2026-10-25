---
id: D682
title: A pick-up's footage is cut around the pick-up, from the recordings when the ring has lost it
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-post-analysis/src/notification-center/recorded-gif.ts
  - packages/addon-post-analysis/src/notification-center/media-anchor.ts
  - packages/types/src/ffmpeg/gif-derive.ts
covers:
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/gif-from-mp4.ts
---

Amends [D404](adr-0404-a-pick-up-is-photographed-on-the-person-who-collected.md)
(its open point on the pick-up's timing).

## Context

Camera 101, rule "Consegna pacco (front door)" (`delivery=package-event`,
`media: { attach: best-matching, gif: true }`), 2026-09-29. The delivery
notification (event 283445, 16:22:02 CEST) was right: still and gif both around
the parcel landing. The pick-up (event 283529) was concluded at **16:27:05**
with `unseenForMs=300274` — the parcel was last seen at ~16:22:05 — and its gif
was cut from the ring over **16:27:00 → 16:27:11**: an empty doormat and a car
passing. The still was right because D404 picks it by OWNER (the collector's
track); the gif is picked by TIME WINDOW, and the window was the conclusion.
The same happened on 2026-09-26 (pick-up 248735). Every pick-up, every camera.

The cause is structural. `PackageStillnessTracker` concludes a departure only
after `PACKAGE_STILLNESS_TTL_MS` (5 min of unseen observed time), so the row's
`timestamp` is five minutes after the fact **by construction**.
`subjectFromPackageEvent` set no `observedAt`, so `mediaAnchor` centred the cut
on the conclusion — and silently, because the "anchored on the conclusion" line
fired only for occupancy. The true instant already existed
(`pickupInstantOf(entry)`, and the collector's own `observedAt`) and was used
only to choose the collector.

Anchoring correctly is not enough on its own. A window five minutes old is
outside every clip ring (≤ 60 s, `NC_CLIP_RETENTION_MAX_SEC`), and the recorded
follow-up served only a rule that asked for a VIDEO: a gif-only rule would have
traded a wrong gif for no gif at all. Growing the ring to five minutes was
rejected — it costs memory on every camera and the rules cap it at 60 s.

## Decision

**A pick-up's footage is about the pick-up.** The detector hands the moment it
happened beside the persisted row — `onPersisted(ev, 'picked-up', {
observedAt })`, with `observedAt = collector?.observedAt ??
pickupInstantOf(entry)` — and it rides `incomingFromPackageEvent` →
`subjectFromPackageEvent` → the outbox as `subject.observedAt`, the same field
the occupancy edge uses. The row's `timestamp` keeps its meaning (the
conclusion). A pick-up whose moment is unknown (a row re-read by the reconcile)
falls back to the conclusion **out loud**: `package pick-up footage anchored on
the conclusion — moment unknown`, `tags: { deviceId }`.

**A gif whose window the ring has lost is cut from the recordings and derived
from that cut.** The recorded follow-up now serves `mediaGif` as well as
`mediaClip`: ONE `recordingExport` cut (`recorded-clip.ts`, unchanged), the gif
derived from its bytes (`recorded-gif.ts`) with the SAME filter chain the
broker applies to a ring cut — which therefore moved to `@camstack/types`
(`ffmpeg/gif-derive.ts`), because two addons may not import each other and two
copies would be two gifs. Delivered as a follow-up with the same tag, gif first,
video second when asked for. A moment the recordings cannot serve ships **no**
gif, by named reason (`not-recorded` / `not-covered` / `cut-failed`, then
`stage-failed` / `derive-failed` for the derive) — never a gif of the wrong
time.

**The recorded gif is a pick-up's, and only a DATED pick-up's.** Every other
kind keeps the gif it had before (the ring's, or none) and says why it gets no
recorded one (`recorded gif follow-up: none`, `reason: not-a-pick-up`; a
missing derive says `no-derive`); a pick-up that fell back to its conclusion
gets NO recorded footage at all — no gif and no video (`recorded video
follow-up: none`), both `reason: moment-unknown` — because the recorded cut on
offer is then the doormat itself. Never footage from the wrong time.
Review of the first cut found both leaks: the branch did not check the kind, so
occupancy edges and restart-queued detections silently gained a recorder export
each, and a reconcile-read pick-up was cut around its conclusion from the
recordings — the exact gif this record removes.

## Consequences

- ~~A pick-up notification now arrives in two steps … A phone collapses the
  two by tag.~~ Wrong on Zentik, which honours no tag: the 2026-09-30 pick-up
  arrived as two messages. Superseded by
  [D686](adr-0686-a-notifier-is-one-shot.md): the recorded cut is awaited
  (30 s bound) and rides the one message.
- The recorded derive runs on the post-processing node, on the PINNED ffmpeg
  (`ctx.deps.ensureFfmpeg`, D540), one bounded child per follow-up (20 s,
  SIGKILL), from a temp file that is always removed.
- The gif of a recorded cut comes from the band `pickProfile` chose (the
  cheapest that covers the window, D435), not from the rule's `media.profile`
  — the same as the recorded video already did.
- Delivery gifs are untouched: a delivery is concluded as it happens, carries
  no `observedAt`, and its fallback is not news.
- The re-evaluation/reconcile paths re-read the persisted row, which did not
  store the pick-up instant; their pick-ups kept the conclusion anchor, logged,
  and got no recorded gif or video. [D684](adr-0684-a-pick-ups-instant-is-stored-on-its-row.md)
  stores it; only rows written before D684 still land here.
- The ring side is unchanged: a fallen-back pick-up re-read while the ring
  still holds its conclusion (a reconcile within seconds) is cut from the ring
  as before — logged by the unknown-moment line.
- `@camstack/types` gained `gifFilterComplex`, `gifFromMp4Args` (with an
  optional `input` path), `gifDeriveSpeed` and `ffmpegRate`; the broker's
  `gif-from-mp4.ts` and `prebuffer-clip.ts` re-export them unchanged.

## Enforcement

- `package-drop-detector.spec.ts` — lastConfirmedAt = T0, conclusion T0+300 s:
  the path detector → `incomingFromPackageEvent` → `mediaAnchor` answers
  `atMs === T0`, `source: 'observed'`; the collector's instant wins when named;
  the delivery carries none. Red with the subject change removed.
- `recorded-clip-follow-up.spec.ts` — a gif-only pick-up 300 s old: no ring
  cut, `cutRecordedClip` on the pick-up instant, the gif derived from that cut
  and sent as a follow-up; named refusals; the unknown-moment line; the
  delivery gif still from the ring around the event (regression). Red with the
  gif branch or the pick-up kind removed. A pick-up with no moment, 300 s after
  its conclusion, orders no cut and logs `moment-unknown` — for the gif and,
  when asked for, the video; a dated pick-up's video is still cut; an
  occupancy gif rule orders none and logs `not-a-pick-up`; a missing derive
  logs `no-derive` — each red with its gate removed.
- `recorded-gif.spec.ts` — the derive uses the broker's chain string, the
  pinned binary, the staged file, and names each miss; a staging write that
  fails part-way removes the partial temp file (`stageTempClip`), and a
  removal that fails is named on the tagged `stage-failed` line or logged
  (`recorded gif: could not remove the staged clip`).
