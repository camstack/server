---
id: D785
title: A retrain frame's day/night is its own chroma, then the sun at its capture time — never the selection time
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-lighting.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-export.ts
  - packages/addon-post-analysis/src/pipeline-analytics/scene/condition-resolver.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/__tests__/retrain-lighting.spec.ts
---

## Context

The cloud-training plan (P3) needs a day/night flag on every exported frame:
night recall is 5–15 points below day on this fleet, so a fine-tune is judged
on day and night separately. Three sources were available:

- **The camera's IR / day-night mode** (`day-night` cap). It reports the
  CONFIGURED mode, which is `auto` on almost every camera here, so it says
  nothing about a given frame. The scene monitor already rejected it for that
  reason (`sceneConditionContext` in pipeline-analytics).
- **The sun at the site's coordinates** (`system.getSiteLocation`). Right for
  ambient light, wrong for a covered porch or a floodlit drive.
- **The frame's own chroma** (`chromaSpread`, `scene/scene-crop.ts`). An IR
  frame is chromatically flat; this is a direct observation of the IR-cut,
  at any hour.

The retrain row also had only `copiedAt` — when the operator CLICKED, which
can be days after the camera saw the frame.

## Decision

**A retrain frame's lighting is resolved by the scene monitor's layered
resolver (`resolveConditionDetailed`): its own chroma first (flat ⇒ `ir`),
then the sun at the site's coordinates at its CAPTURE time, then the coarse UTC
clock — and the manifest says which layer answered (`source`).**

- `capturedAt` is the source media row's timestamp, recorded at copy time.
- `chromaSpread` is measured once from the copy's bytes at copy time and
  stored on the row; a failed measurement is absent, never `0` (which would
  read as IR).
- `night` is `night` or `ir`; twilight (`dawn`/`dusk`) counts as day, as the
  tracking tapes do. The `condition` is exported too, so a trainer can drop
  twilight.
- A frame with no capture time (a copy taken before this decision) is
  `lighting: null` — unknown — unless its chroma proves IR. It is never
  resolved at `copiedAt`.

## Consequences

- No new rule to keep in agreement: the scene monitor and the export share
  one resolver, which now also reports its layer.
- A hub with no site location falls to the UTC clock split, and the manifest
  says `source: 'clock'`, so the trainer can treat those flags as weak.
- The export plan stays index-only: nothing is decoded at export time.

## Enforcement

`retrain-lighting.spec.ts` (pixels beat the clock, sun by site and time,
clock without coordinates, unknown without a capture time),
`retrain-frame-metadata.spec.ts` (capture time and chroma recorded; a failed
measurement is absent) and `retrain-export-manifest.spec.ts` (the manifest
carries them).
