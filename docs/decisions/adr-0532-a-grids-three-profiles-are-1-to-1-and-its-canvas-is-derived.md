---
id: D532
title: A grid's three profiles are 1:1 with its sources, and its canvas is derived
status: accepted
date: 2026-09-18
supersedes: D528, D531
applies-to:
  - packages/system/src/builtins/camera-grid/grid-profiles.ts
  - packages/system/src/builtins/camera-grid/grid-canvas-derivation.ts
  - packages/types/src/capabilities/camera-grid-layout.cap.ts
  - packages/ui-library/src/composites/cap-settings/CameraGridLayoutEditor.tsx
---

## Context

Three shapes were tried in one day, and the operator's is the one that holds.

D519 published a single `high`. Then came one composition per profile over a
canvas the operator TYPED, which made every rung of a viewer's adaptive a full
rebuild — hub log, 2026-09-18: `mid` at 13:03:18, `low` at 13:03:28, one grid,
two rebuilds, because a phone walked down a rung. D528 collapsed it to ONE
output to stop the rebuilds, and took away the rung the adaptive stands on.
D531 then tried to pick each source's stream by SIZE, which restored sharpness
and quietly committed the hub to two 4 MP decodes whenever a cell was large.

Every one of those was working around the same thing: a resolution the operator
typed into a text field. That field silently decided both what the composite
cost and how sharp it was, and nothing in the editor said so.

The operator named the shape: *"i 3 profili possibili matchati 1:1, adaptive che
fa semplicemente il suo lavoro. Il profilo selezionato definisce il canvas e
questo dipende dalla composizione di tutti gli stream nella griglia per quello
specifico profilo."* [the 3 possible profiles matched 1:1, adaptive simply doing its job. The selected profile defines the canvas and this depends on the composition of all the streams in the grid for that specific profile.]

## Decision

A grid publishes one composition per profile, each made of the MATCHING profile
of every source — `low` from `low`, `high` from `high`. Nothing is chosen and
nothing is mapped, so a viewer's adaptive does its ordinary job without knowing
a grid is a grid.

The canvas is not authored. Each profile derives its own: a cell has
`sourceResolution x crop` REAL pixels behind it, showing them 1:1 neither
invents nor discards anything, so the cell should be exactly that many pixels —
and since the cell is a fraction `f` of the canvas, the canvas it implies is
`real / f`. Each cell proposes one and the LARGEST wins, so the hungriest cell
is served 1:1 and the others scale down by a hair, never up.

On the live grid — two cells, each half the canvas, each showing about half its
source — that gives `high` 3840x2160, `mid` 896x512, `low` 640x360. Three
streams, each 1:1 with what it is made of.

`width`/`height` leave the editor, the cap patch, the view and the persisted
row. What they are is REPORTED instead, per profile, because nothing else in the
system would ever say what the grid came out as.

## Consequences

**The rebuild objection is gone, and it was never the profiles' fault.** A rung
change used to mean a blank screen for as long as the slowest source took to
produce a key frame. With the composition driven by an output clock (D530) a
rebuild shows the picture at once and fills the cells in, so three matched
profiles cost what they are worth.

**The cost follows the rung actually being watched.** A phone sitting on `low`
composes 640x360 from 640x360 sources; the 4K decodes are paid only by someone
watching `high`.

**A profile is offered only when EVERY source serves it**, at a stated size. A
stream the broker lists with no resolution cannot size a canvas, and a canvas
guessed from one number and defaulted for the other is a picture nobody drew —
so it counts as not served, and is named.

**The editor draws at the DERIVED aspect**, read back from the offers. Before,
it drew at whatever two numbers had been typed, which is how a layout could look
right in the editor and wrong on screen.

**Rows written before this still carry `width`/`height`.** Zod drops unknown
keys, so they are ignored rather than migrated: nothing reads them, and a
migration that rewrote every row to delete two fields would be a write with no
reader.

## Enforcement

`grid-canvas-derivation.spec.ts` pins the arithmetic, the largest-proposal rule,
the gaps, the even dimensions and both clamps; `grid-profiles.spec.ts` pins the
per-profile canvases against the live cameras' real sizes and every refusal;
`grid-stream-descriptor.spec.ts` pins one descriptor per profile with its stated
hint; `grid-stream-relay.spec.ts` pins that a dial must name a profile.
