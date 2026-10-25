---
id: D929
title: A package candidate opens from the step's raw boxes on governor looks, and the minimum area is a fraction of the zone crop
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-look-sightings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-reference-area.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-look-drop-log.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts
---

## Context

On 2026-10-24, camera 101 showed a governor-paced `package-detection` look with
two boxes on a 3840×2160 frame: 126×124 (≈0.19% of the full frame) and 87×87
(≈0.09%). The step had cropped to the Uscio zone, then reprojected those boxes
into full-frame pixels, and the minimum-area floor still divided by the full
frame. Tracker v2 confirmed at `minHits` 3 but dropped the tracklet
after `maxMissedMs` 4000 while looks were ~5 s apart (`unconfirmed-spawn-lost`).
`PackageStillnessTracker` only received sightings built from **confirmed** package
tracks; raw boxes from the step could refresh an already promoted parcel but
could not **open** a candidate. The minimum area floor divided by the **full**
frame, so a normal parcel inside a zone crop failed gate 4 even when it was a
healthy fraction of what the step actually saw.

## Decision

On frames where `package-detection` **looked**, a package stillness candidate
opens from the step's **first-level kept** raw boxes (IoU association across
looks), not from tracker `minHits`. A raw box that overlaps a **person** does
not become a sighting. The **minimum** bbox area fraction is measured against
the union crop of enabled package-rule zones (same geometry as `crop-zone`
inference); the **maximum** area fraction stays a fraction of the **full** frame.
When there is no usable zone crop, the reference area is the full frame. Every
drop reason is logged once per streak with `tags: { deviceId }`.

## Consequences

- Production wiring in `runPackageStillness` must call `packageLookSightings` and
  pass device zones for `packageReferenceArea`.
- `PackageDropDetector` gate 4 MIN uses the same reference area; MAX unchanged.
- Tracker hit arithmetic, TTL, IoU, and absence logic are unchanged; only the
  sighting **source** on looked frames changed.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/__tests__/package-look-sightings.spec.ts` — governor-paced promotion, person overlap, floor drop, IoU enrichment, reference area.
- `scripts/check-package-promotion-satisfiable.ts` — `burstCount >= packageDropMinFrames` and `>= PACKAGE_STILLNESS_MIN_HITS`.
