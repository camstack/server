---
id: D528
title: A grid publishes one composition and reads each source at its cheapest stream
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-profiles.ts
  - packages/system/src/builtins/camera-grid/grid-stream-descriptor.ts
  - packages/system/src/builtins/camera-grid/grid-stream-relay.ts
---

## Context

A grid published one composition per profile: its `high` composed the sources'
`high`, its `low` their `low`. The mapping was defended as "the only one with no
policy in it", and that was true of the mapping. It was not true of the SHAPE.

A composition is on demand and lives only while it has consumers. So every step
of a viewer's ADAPTIVE destroyed one composition and built another: N sources
re-acquired, every key frame waited for again, one ffmpeg killed and one
spawned, and — because ffmpeg gives each input pts 0 at its own first frame — a
fresh random tile skew drawn each time. The hub's log for 2026-09-18 has `mid`
acquired at 13:03:18 and `low` at 13:03:28: one grid, ten seconds, two full
rebuilds, because a phone walked down a rung. The operator reported the result
as a grid that "works quite badly", and the pacing bug that shared the report
was only half of it.

The operator asked for the shape directly: *"limitiamolo ad 1 come output, come
input prende il più basso da tutte le camere"* [let's limit it to 1 as output, as input it takes the lowest from all the cameras].

## Decision

A grid publishes ONE stream — `grid`, hinted `high`, at the canvas the operator
laid out — and reads each source at the cheapest profile THAT source serves,
chosen per source rather than as a profile all of them must share.

The output hint is stated, never inferred: a device publishing a single stream
with no hint is ranked by pixel count into `mid`, the slot no storage class
selects on its own and scrub never reads. That is the Dreame robot bug, and a
composite is a single-stream device again.

The input is the cheapest stream because nothing about a composite needs a
source's `high`: a tile is a fraction of the canvas, so decoding a 4 MP stream
to draw a quarter of a 1080p picture is the most expensive way to produce the
worst one. Per SOURCE, because requiring a common profile is what let one
unassigned slot on one camera refuse a whole composition.

## Superseded in part

The INPUT half of this decision — "the cheapest stream that source serves" — was
wrong for a cell that fills much of the canvas, and made the live grid soft by
reading a 640x360 sub-stream into a 960x1080 tile. Replaced by
[D531](./adr-0531-a-cells-source-stream-is-sized-from-its-crop-and-the-streams-own-dimensions.md),
which computes it from the crop and the streams' dimensions instead of choosing
it. The single output, its stated hint and the relay path are unchanged.

## Consequences

The grid stops offering a choice a consumer can flip between, which is the
point: there is nothing for an adaptive to step onto, so a composition is built
once and kept. The fleet also stops paying 3x the decodes when two clients pick
differently.

`grid-mid` and `grid-low` disappear from the catalog and the broker sweeps them.
Any operator assignment pointing at them is dropped — the grid keeps the `grid`
id it always had, so the `high` assignment survives, which is why that id is
bare (D519).

The relay path loses its profile segment (`/grid/<id>.flv`). A broker still
holding the old url MISSES rather than being answered: one composition reachable
under two spellings would keep a shape this addon no longer publishes alive.

The scaled canvases are gone. They existed to make a `mid`/`low` composition
cheaper than the `high` one; with a single output there is nothing to be cheaper
than, and the canvas is the operator's own.

This does NOT fix the tile skew — it removes the case where the skew CHANGES
while the operator is watching. The skew itself is the spread in when each
source's first key frame arrives, it drifts over hours (0.5 s at 13:05, 3 s at
13:50 on the same pair), and nothing an ffmpeg flag can reach makes it zero:
with `-copyts` both restreams still report `pts_time:0`, so there is no common
timeline to align against. Zero requires a composition driven by an output
clock rather than by input PTS.

## Enforcement

`grid-profiles.spec.ts` pins the per-source choice and the refusals;
`grid-stream-descriptor.spec.ts` pins the single descriptor and its stated hint;
`grid-stream-relay.spec.ts` pins that the old two-segment path is refused.
