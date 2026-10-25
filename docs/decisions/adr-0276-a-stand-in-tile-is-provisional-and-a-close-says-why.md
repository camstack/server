---
id: D276
title: A best-shot stand-in is PROVISIONAL, a semantic promotion carries only the subject box, and a close without a native tile says why on the row
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/semantic-promotion.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/preview-upgrade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-close.ts
  - packages/addon-post-analysis/src/pipeline-analytics/copy-face-crop-preview.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
---

## Context

The operator's report, verbatim: *"tante detections con best shot la targa, ma
manca l'auto! E ancora facce senza la persona… bisogna capire MOLTO
attentamente dove perdiamo le immagini."* [many detections with the plate as best shot, but the car is missing! And again faces without the person… we need to understand VERY carefully where we lose the images.] Audited per track on 2026-08-28
(18 tracks inspected, images pulled and looked at), it was two defects, not
one:

**The plate-as-best-shot was a wrong BOX, not lost pixels.** The
attribution-time semantic promotion (D-semantic-bestshot, 2026-08-21) fed the
plate DETAIL box into the ranking instead of the subject box — the pure helper
`bboxForSemanticPromotion` returned `d.bbox` for `plate`/`face` while
`SemanticRecognitionFrame.bbox` documents "SUBJECT (person / vehicle) bbox".
That poisoned `recordBestSeenBbox`, so the close-time keyFrame derive
(`track-close.ts:568` at diagnosis time) cut the PLATE out of a keyFrame that
held the whole car. Tracks c5c628f4, 98fc38ce, bac368e2 (dev 102) stored 4–9 KB
plate-only `thumbnail` rows while their keyFrames showed the entire vehicle.
The face path never had the bug — `face-recognizer.ts` `onSemanticMatch`
passes the body box — which is what proved the discipline, not the helper, was
the right unit.

**The face-as-best-shot was a stand-in that became permanent.** Under capture
starvation (`worker-lease-gone`, decode-worker I/O errors, a scheduler window
of `requested:100, started:15, droppedStale:70`), person tracks closed with no
thumbnail; `copyFaceCropIfTrackHasNoThumbnail` then installed the face crop as
the tile. Correct as a fallback — the operator accepts it: *"va bene mostrare
quei crop quando mancano migliori elementi"* — but nothing could ever replace
it: the close derive skipped any track that "already has a thumbnail", and on
413c69ff (dev 618) the keyFrame landed 8 s AFTER close from a still-running
queued exec, so a full-scene native frame of the person sat beside a 5 KB face
tile forever. And the only trace of WHY was a log line
(`track closed with no thumbnail`) that scrolled away.

What was tried first and rejected: making the close derive overwrite ANY
existing thumbnail (would clobber live-ranked and operator-era tiles), and a
byte-size heuristic for "is this a stand-in" (4–9 KB vs ≥148 KB separated the
defects cleanly in the audit, but size is a symptom — the real signal is where
the bytes came from).

## Decision

Three rules, one per loss:

1. **A semantic promotion carries only the SUBJECT box.** The composed frame
   is built in ONE place — `semanticFrameForDetailAttribution` — which takes
   the detail result's box and uses it for nothing. No call site may hand a
   detail box to `promoteSemanticRecognition`, `recordBestSeenBbox`, or a
   re-fired thumbnail capture.

2. **A `thumbnail` row states its provenance, and only a below-`native` row is
   ever auto-replaced.** `native` (live wide-square capture, keyFrame derive)
   > `raster` (sub-native subject crop: zero-media fallback, hierarchy display
   crop) > `standin` (the face-crop copy). A row with NULL provenance (every
   pre-column row) ranks `native` — an upgrade must never overwrite what it
   cannot classify. The close-time derive replaces a below-native tile; a
   track that still closes below native is registered in a bounded
   claim-once registry (`PendingPreviewUpgrades`, TTL 15 min / 512 entries)
   and the late-landing keyFrame exec redeems it exactly once
   (`runPreviewUpgrade`). Replacement is monotone in rank, so a tile is
   rewritten at most twice and never thrashes.

3. **A close that leaves anything but a native tile says why ON THE ROW.**
   `previewMissReason` (track store column + optional cap `Track` field) is
   composed from the derive's own miss branch, the tile that stood in, and
   the residents' accumulated capture-miss note (`keyframe:native-miss`,
   `thumbnail:overflow`, `keyframe:stale`, …) fed by the dispatcher, the
   key-frame persist path and the capture scheduler's drop notices. The late
   upgrade CLEARS it. Absent means "landed native or predates the column",
   never a negative.

**Repair of existing rows is forward-only, deliberately.** The poisoned
best-seen bboxes lived in RAM and are gone; stored plate-only thumbnails
cannot be told apart from legitimate small crops without the provenance this
record introduces; and re-deriving them would be a bulk pass over stored media
(D54 territory) against a hub already under load. The NULL-ranks-native rule
is the same choice stated in the store: old rows are left exactly as they are.

## Consequences

- Costs one TEXT column on the media index and one on the track rows (both
  added in place by `declareCollection`), one bounded in-RAM registry, and a
  provenance argument on every close-time thumbnail write.
- Forbids any consumer inventing its own "is this tile real" heuristic
  (byte-size included) — ask the provenance.
- The wire `Track.previewMissReason` is typed in
  `packages/types` and therefore reaches TYPED consumers only with a
  published `@camstack/server`; the value itself flows on addon redeploy (the
  cap router is a structural pass-through on output). The addon-local column
  and the D276 upgrade behaviour are live on `camstack deploy
  packages/addon-post-analysis` alone.
- The capture starvation itself (dead decode-worker leases on agent-a,
  70 % stale-drop windows) is NOT fixed here — it is made legible per track.
  The keyFrame retry bound is already persist-gated (D58-conformant); its tail
  (the exec that outlives the close) is exactly what the pending registry
  turns from a wasted write into the repair.

## Enforcement

- `semantic-promotion.spec.ts` pins the subject-box contract (plate detail box
  present and ignored); disarmed and re-armed during review (1 red).
- `track-close.spec.ts` pins: stand-in replaced by the derive, native and
  legacy-NULL tiles untouched, miss reason + pending upgrade recorded on a
  below-native close, nothing recorded on a native close (3 reds across the
  two disarms).
- `preview-upgrade.spec.ts` pins claim-once, TTL/cap bounds, and the
  never-over-native gate (1 red disarmed).
- `media-store.spec.ts` pins provenance round-trip and NULL-ranks-native
  (3 reds disarmed); `capture-scheduler.spec.ts` pins the drop notices and
  that a cancel is not one (2 reds disarmed);
  `track-store-preview-miss.spec.ts` pins the row round-trip, the clear, and
  patch-survival (2 reds disarmed).
- No standalone guard script: the contracts live behind typed seams
  (`MediaPutInput.provenance`, `TrackCloserDeps`), so a violation is a type
  error or a red spec, review only beyond that.
