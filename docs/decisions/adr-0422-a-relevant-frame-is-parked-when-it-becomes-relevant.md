---
id: D422
title: A relevant frame is PARKED at the instant it becomes relevant — nothing reaches back for pixels
status: accepted
date: 2026-09-09
supersedes: D419, D420
applies-to:
  - packages/addon-pipeline/src/session-decode/parked-frame-store.ts
  - packages/addon-pipeline/src/pipeline-runner/track-frame-park.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/parked-frame-client.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-park.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/key-frame-persist.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts
---

## Context

A track's media — its `keyFrame`, its boxed `thumbnail`, its best face crop — is
resolved by handle, LATE. The hub decides "this frame is this track's best",
then asks the node that decoded it to cut the pixels. The design's own note in
`retained-frame-store.ts` states the window it was built for: **150–500 ms** end
to end, covering inference, the cross-process event hop, tracking, and the tRPC
round trip back.

Nothing enforced that window, and two paths grew past it. `TrackDetailDispatcher`
re-dispatches on a ~1 Hz tick with `maxPerTrack` unbounded for anything that is
not `trigger:'once'`; and since D397 a COASTED frame — correctly — no longer
refreshes a track's frame association, so a track that stops being matched keeps
its last matched handle **frozen and ageing for the rest of its life** while the
tick keeps asking about it. `persistKeyFrames` and `offerGroupShot` are also the
only two capture sites that omit `staleAfterMs`.

The node therefore had to keep full-resolution surfaces alive long enough to
answer a pathological ask: a 160 MB per-node retained budget and a 4 096-entry
crop registry that sat pinned at `4096/4096`.

**What was tried first, and what it cost.** D419 bounded the lease at ten
seconds, on the belief that a p90 ask lands at 4.3 s. That figure came from
sizing prose in `@camstack/types` `pipeline/native-lease.ts`, not from a
measurement of this path. Deployed 2026-09-09 ~14:00 it took the fleet's
`keyFrame` presence from **99.5% to 76.6%** and produced tracks with **zero
media in 11.8%** of cases, against 0.0% before (628 tracks, 32 cameras). It also
hid its own damage: the honest `native crop refused` line counted **79** while
the same event, logged as `native crop miss reason=no-registry-entry` after the
sweep dropped the entry, counted **20 980** — a factor of 265. D420 fixed the
accounting; the bound was moved to the worker's 30 s tile TTL to stop the
bleeding. Neither addressed the actual question, which the operator asked
plainly: *"non si capisce perché dopo 10 secondi ancora un media è necessario
per una traccia, per cosa esattamente?"* [it is not clear why after 10 seconds a media is still needed for a track, for what exactly?]

He is right. Nothing legitimate needs a 30-second-old surface. A lease long
enough to serve a retry loop is a lease sized by the bug.

## Decision

**A frame that matters to a track is captured at the instant it is judged to
matter, not fetched afterwards.** When the hub's `BestDetectionTracker` — the
single canonical "best per track" policy — concludes that a frame is a track's
best (or its first, or its last), it issues a PARK for that `(deviceId,
trackId, kind)` against the node that owns the handle, while the handle is
young. The node encodes once, from pixels it already holds, and keeps a small
bounded per-track parcel. Every later consumer retrieves by `(deviceId,
trackId, kind)` — a lookup that cannot miss on age, because the pixels were
copied before they could expire.

Consequently the retained store and the crop registry go back to serving only
the window they were designed for: a handle is live for the enrichment horizon
and no longer. No consumer holds a handle across a coast, a retry, or a track's
lifetime.

## Consequences

- **The age bound stops being a policy question.** D419 and D420 exist only
  because a lease had to outlive a request; once nothing asks late, the lease is
  the enrichment horizon and a miss past it is a real defect rather than a
  tuning knob. Both records are superseded.
- **Memory moves from full-res surfaces to encoded parcels.** Today: 160 MB of
  RGB per node plus up to 4 096 registry entries, sized so a late ask can still
  win. After: live tracks × at most three JPEGs. This must be bounded per device
  and per node, and the bound must be stated where it is spent, not inferred.
- **A park is idempotent per `(trackId, kind)` and replaces on improvement.** A
  better detection parks over the previous parcel; the ranking decision stays
  where it already lives, in `BestDetectionTracker`, and this record adds no
  second opinion about what "best" means (D62's rule about a second authority
  applies here too).
- **A park can fail, and a failure is not silent.** If the handle is already
  gone at park time, that IS the defect the 150–500 ms window exists to prevent,
  and it is logged with `tags: { deviceId }` and the measured age — never
  swallowed, never retried into a loop.
- **The dispatcher's unbounded retry stops being able to lose media.** It is
  still unbounded and still worth fixing, but a retry now reads a parcel that
  exists rather than racing a surface that is being swept.
- **What must remain true elsewhere:** D52 still holds — the runner is the only
  place a detail crop rectangle is derived, so a park carries a full frame or a
  rectangle the runner cuts, never a pre-cut tile the caller decided. D9/D18
  still hold — a park is one compressed encode at a decision point, never a
  frame-rate stream.

## What was built (2026-09-09)

- **The order.** `pipelineRunner.parkTrackFrame({ deviceId, trackId, kind,
  handle, bbox, maxWidth?, timestamp })`, `getParkedTrackFrame({ deviceId,
  trackId, kind })` and `releaseParkedTrackFrames({ deviceId, trackId })` on
  the runner cap; `kind` is `keyFrame` (the whole frame at the native cap) or
  `thumbnail` (the best-shot 16:9 central-square window). The runner resolves
  through the SAME native-lease path `getNativeCrop` uses, encodes one JPEG,
  and keeps it in `ParkedFrameStore` (`session-decode/parked-frame-store.ts`).
  `trackId` is opaque to the runner.
- **Where the order is issued.** `buildSnapshotTargets` in
  `pipeline-analytics/index.ts`, on the frame `TrackResidentState.observeBestFrame`
  accepts (`BestDetectionTracker`, `BEST_FRAME_POLICY`) — both parcels,
  replacing. A RETRY (the bounded keyFrame catch-up, the per-frame thumbnail
  re-fire) parks the CURRENT frame only for a kind that has no parcel: it
  fills a refused park, it never replaces a ranked one. The semantic winner
  and the face/plate hierarchy fill go through the same `issueParkOrders`.
- **Who reads by track.** `persistTrackKeyFrame` (stores the parcel verbatim,
  derives `keyFrameSmall` from the same bytes — one encode, two outputs, as
  before), `EventMediaDispatcher.cropSubjectVariants` (the thumbnail pair from
  the parked slab and the layout the hub kept beside it), and the detail
  dispatcher's second rung (`captureParkedFrame`: the parked key frame as
  `frameJpeg`, the subject box scaled into the parcel's pixels, the runner
  still cutting — enriched ONCE per parcel per step, so a coasting track does
  not re-embed the same image every second). `getFullFrameJpegBase64` and
  `captureFullFrameBase64`, the by-handle rung, are deleted.
- **What still asks by handle, inside the horizon, on purpose.** The per-frame
  media batch's ≤640 resolve and the 960 boxed timeline tiles
  (`firstFrame`/`snapshot`/`lastFrame`), the event `faceCrop`/`plateCrop`
  display children, the confirmation gate's crop, the detail dispatcher's
  first rung (`frameHandle`) and its last (`cropJpeg`), the face/plate
  recognisers' enrichment crops, and the summary group shot
  (`offerGroupShot` — a summary is not a track; a `summary:<id>` park is the
  obvious next step and is not done here). All of these run in the same
  frame's synchronous window or within one tick of it.
- **Cost, stated where it is spent.** `PARKED_FRAME_BUDGET_MB` 64 per node,
  `PARKED_FRAMES_PER_DEVICE_MAX` 48 per camera (24 tracks × 2 kinds),
  `PARKED_FRAME_MAX_AGE_MS` 10 min as the backstop for a lost release. A 4K
  key frame JPEG measures ~1.5–2.5 MB (the scene tile's own sizing), a
  thumbnail slab ~60–120 KB, so 64 MB is ≥ 24 concurrent 4K key frames plus
  their thumbnails — above the 12-session peak measured on this cluster at
  two tracks each. The hub keeps a mirror (node, instant, subject box,
  layout) per parcel, bounded at 4 096 tracks. The 160 MB retained store and
  the 4 096-entry registry are NOT lowered in this change: lowering
  `NATIVE_CROP_LEASE_MAX_AGE_MS` is the last step, after the park is measured
  live.
- **Deploy order.** `addon-pipeline` (every node) BEFORE
  `addon-post-analysis`: a hub that parks against a runner without the method
  logs `track frame park impossible … (version skew)` once per camera per
  minute and writes no key frame or best shot until the runners catch up. The
  cap change also travels in `@camstack/types`, so the server train must
  carry it (D16).

## Enforcement

`scripts/check-parked-frame-no-handle-fallback.ts` (in CI): the by-handle cap
`getNativeCrop` is invoked only from `runtime/native-frame-transport.ts`; the
track-keyed files (`parked-frame-client.ts`, `key-frame-persist.ts`,
`track-park.ts`) name no by-handle fetch and do not import the transport; the
retired rungs (`captureFullFrameBase64`, `getFullFrameJpegBase64`) stay
retired; `EventMediaDispatcherDeps.getParkedSubjectSlab` stays REQUIRED (an
optional dep is where the `else` would grow back); `parked-frame-store.ts`
never names `FrameHandle`.

Tests, each run red before the change and red again with the fix removed:
`packages/addon-pipeline/src/session-decode/__tests__/parked-frame-store.spec.ts`
(the key, the replace, the out-of-order park, both bounds, the release, the
age ceiling),
`packages/addon-pipeline/src/pipeline-runner/__tests__/track-frame-park.spec.ts`
and `packages/addon-pipeline/src/pipeline-runner/__tests__/parked-frame-cap.spec.ts`
(a 30 099 ms handle is refused without asking the worker, and the line
carries `deviceId` + age),
`packages/addon-post-analysis/src/pipeline-analytics/runtime/__tests__/parked-frame-client.spec.ts`
(pinned to the handle's node, coalesced in flight, refusal logged not
retried, retrieval pinned to the park's node, offline node never dispatched),
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/track-park.spec.ts`,
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/key-frame-persist.spec.ts`,
`packages/addon-post-analysis/src/pipeline-analytics/services/__tests__/event-media-dispatcher.spec.ts`
(a missing parcel never reaches for a handle),
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/detail-frame-jpeg-fallback.spec.ts`
(the parcel rung, once per parcel per step), and the booted
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/key-frame-retry-e2e.spec.ts`
(the park fires on the decision, the write reads by track, the refused park
is retried on LATER frames, bounded, nothing is dispatched at an offline
node).

The fleet number: the `keyframe_presence` ops tool (`packages/mcp-dev/src/ops/censuses.ts`; it replaced `keyframe-presence.mjs`, D835) — per-camera
`keyFrame` / zero-media presence over a window from `listTracks` +
`debug.analyze`, the measurement that caught D419. Run it before and after a
deploy that touches this path; 99.5 % is the number to keep.
