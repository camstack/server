---
id: D1067
title: A crop is a derived camera, a one-cell composition on the camera grid engine, never a stream of its source
status: accepted
date: 2026-11-20
supersedes:
applies-to:
  - packages/types/src/composition/helpers/spec.ts
  - packages/types/src/composition/helpers/crop-geometry.ts
  - packages/types/src/composition/helpers/compile.ts
  - packages/system/src/builtins/camera-grid/grid-blocks.ts
  - packages/system/src/builtins/camera-grid/addon.ts
  - packages/system/src/builtins/camera-grid/grid-detection-mapping.ts
  - packages/system/src/builtins/camera-grid/__tests__/crop-camera.spec.ts
  - packages/addon-admin-ui/src/components/composition-editor/CropCameraEditor.tsx
  - packages/ui-library/src/composites/cap-settings/SourceCropCanvas.tsx
---

## Context

Operators want a section of a wide camera shown as its own camera: a 16:9 window on a 4K
source, followed by the detections that fall inside it. The first idea was a cropped stream
published on the source camera itself. That puts the crop next to the source's own profiles
(high, mid, low), so the source would carry a profile whose frame is not the sensor's frame and
every consumer that reads "the high profile of camera N" would silently get a crop. The
profiles of a source are a contract; a crop beside them breaks it. The operator revised the
plan on 2026-11-20: a crop is a new derived device, not a stream of the source.

The camera grid engine already had every hard part a crop needs: a cell reads a normalized
crop of its source (D519), each profile is derived from the crop at that profile's own pixels
without upscaling (D532, D534), detections of the source are mapped through the cell and clipped
at its edge (`mapDetectionToCanvas`), and it always re-encodes its output. Building a second
engine for one rectangle would have duplicated all of that.

## Decision

A crop camera is a helper kind `crop`, a sibling of `grid`, served by the same camera-grid
provider. A crop block compiles to a one-cell layout whose cell covers the whole canvas and
whose source rectangle is the crop; the grid's device path hosts it unchanged. The crop is
stored as the grid stores a cell's crop: a normalized rectangle on the source (D519). Pixels
exist only at runtime. The editor offers the ratio presets 16:9 (the default), 4:3, 1:1 and
Free; a preset locks the handles to that pixel aspect, and the canvas takes the crop's aspect
with no letterbox. Detections of the source are mapped back onto the crop through the grid
canvas mapping, so a box outside the crop is not drawn at its edge and a straddling box is
clipped to what the crop shows. The output is always re-encoded; a crop is never stream-copied
from its source. `saveGridLayout` refuses a crop block: a crop's rectangle is edited through its
own block, never as a grid layout.

The word is CROP in code, UI, docs and commit messages. "Zoom" is not used for this feature.

## Consequences

- A crop adds no profile to the source. The source keeps exactly the profiles its own
  provider declares, and the crop publishes its own (one-cell compositions offer all three
  profiles 1:1 with the source's matching profiles, and publish only the ones chosen).
- The engine that hosts a crop is the one that hosts a grid, so a fix to profile sizing,
  no-upscale or detection mapping lands for both kinds at once. Anything that needs a grid
  layout (cell editing, a layout save) must check the spec kind first; `saveGridLayout` does.
- A crop whose source does not resolve to a device names that source and composes nothing
  (`resolveGridCells` in `grid-blocks.ts`); it does not guess a substitute.
- Analysis of a hosted device is silenced the first time the engine hosts it, as for a grid
  (the per-device `analysisSilenced` flag). An operator who turns detection back on keeps it.

## Enforcement

- `packages/types/src/composition/helpers/__tests__/crop-geometry.spec.ts` covers the rectangle
  geometry: seeds, the ratio lock, move and resize inside the source, the minimum side.
- `packages/system/src/builtins/camera-grid/__tests__/crop-camera.spec.ts` covers the one-cell
  compile, the unresolved-source refusal, detections inside, outside and straddling the crop,
  and one-cell profile derivation with no upscale.
- `saveGridLayout` throws for a device whose hosted block is a crop
  (`packages/system/src/builtins/camera-grid/addon.ts`). That throw is the only enforcement of
  the layout-save refusal; there is no guard script.
- The rule that a crop is never a source stream has no guard. Review only.
