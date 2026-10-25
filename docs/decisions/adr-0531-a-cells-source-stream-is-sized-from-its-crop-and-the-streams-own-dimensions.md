---
id: D531
title: A cell's source stream is sized from its crop and the streams' own dimensions
status: accepted
date: 2026-09-18
supersedes: D528
applies-to:
  - packages/system/src/builtins/camera-grid/grid-profiles.ts
---

## Context

D528 read each source at "the cheapest stream that source serves", reasoning
that a tile is only a fraction of the canvas. That is right for a
thumbnail-sized cell and wrong for one that fills half of it.

On the live grid it read a 640x360 sub-stream into a 960x1080 tile — a 3x
vertical upscale — and the composite went soft. Before the collapse to a single
output the grid's `high` composed the sources' `high`, so this was a quality
regression introduced with D528 and not noticed until the picture was looked at.

The operator named the fix: the grid should work it out from the crop percentage
and the streams' own dimensions. The broker already reports the resolution of
every profile slot; the old rule read the profile name out of that answer and
threw the size away.

## Decision

A cell's source stream is COMPUTED, not chosen: a cell showing a fraction `c` of
a source's width inside a tile `w` pixels wide needs a source at least `w / c`
wide, and the same in the other axis. The cheapest stream that reaches it is the
one read.

It is per SOURCE and not per cell, because one dial is acquired per camera and
every cell of that camera reads it — so a camera in two cells is read at what
its HUNGRIEST cell needs.

Two fallbacks, both chosen so that a picture still happens:

- **Nothing covers it** → the largest stream available. Soft beats absent:
  refusing would take a whole grid down because one cell was drawn larger than
  its source can fill.
- **A stream states no size** → ordered as cheapest rather than discarded. An
  unmeasurable stream is still a stream.

## Consequences

The cost follows the operator's own layout, which is the right place for it to
follow. On the live grid — 1920x1080 canvas, two cells of 960x1080, each showing
about half its source's width — both sources now need ~1920x1080 behind them, so
both are read at `high` (3840x2160): two 4K decodes. That is what a sharp 1080p
composite costs, and it is what was being paid before D528.

The lever is the canvas. A smaller canvas asks for less of every source, and it
is a number the operator already owns in the layout.

`mid` on this fleet is 896x512, which is an awkward middle: with a half-width
crop it serves a tile of at most 448 px, so a composite is realistically `low`
for small cells and `high` for substantial ones.

## Enforcement

`grid-profiles.spec.ts` pins the small cell, the half-canvas cell, the
crop-magnified need, the hungriest-cell rule, and both fallbacks.
