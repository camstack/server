---
id: D533
title: A tile comes back; only the encoder ends a composition
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-compositor-child.ts
  - packages/types/src/ffmpeg/process.ts
---

## Context

The operator tested the three rungs: `low` and `mid` were perfect, `auto`
appeared stuck. The hub log says what actually happened, at 19:25 on 2026-09-18:

```
tile "bedroom" crashed  code=0  ["error while decoding MB 27 55, bytestream -5"]
composition ended  reason="tile cell-1:crashed"  consumers=1
composition stopped — no consumers left
composition started  canvas=3840x2160      ← and round again
```

The `high` composition started perfectly — encoder live in the same second, both
tiles live in the same second. Then one tile's decoder exited with `code=0`: the
input ENDED, it did not crash. D530's policy ("any child exiting ends the
composition") tore the whole thing down, the consumer re-dialled, and the grid
served nothing but restarts. That loop is what the operator saw as a stuck rung.

Investigating it turned up a second, wider defect in the shared ffmpeg
primitive: a child that had gone LIVE and then died, with `maxRestarts: 0`, fell
into a branch that did **nothing at all** — no counter, no error, no callback.
Its owner learned about it only through `onExit`, which also fires for exits
that are about to be respawned, so an owner could not tell "gone for good" from
"back in a second" without duplicating the primitive's bookkeeping.

## Decision

`FfmpegProcess` gains `onGiveUp`, called exactly once when the wrapper has
stopped restarting and the child is gone for good — including the previously
silent case of a run-to-completion child dying after it went live. `onExit`
keeps its meaning: every exit, restartable or not.

A grid tile's decoder gets `maxRestarts: 5` and comes back on its own. While it
does, its cell holds the last frame it produced and every other cell carries on.
Only the ENCODER exiting ends the composition, first time, because nothing
downstream of it exists without it. A tile that exhausts its restarts ends the
composition too, with the tile named.

## Consequences

**A tile's half frame must be dropped when its decoder is replaced.** Raw video
has no framing: the feed cuts on a fixed length, so bytes from the new decoder
appended to a partial frame from the old one would be misaligned for ever, with
nothing to re-sync on — every frame after it sheared. `GridCompositor.resetTile`
drops the partial and KEEPS the newest whole frame, so the cell freezes rather
than blinking.

**A frozen cell is now possible, and that was the objection D530 raised** — the
operator could be looking at a camera that stopped, with nothing saying so. It
is the lesser fault: the alternative, measured, was a grid that served nothing
at all. The restart is logged per tile and bounded, so a source that is really
gone still ends the composition within seconds.

**`maxRestarts: 0` is no longer a silent death anywhere in the repo.** Any
caller using it now hears `onGiveUp` when its child ends.

## Enforcement

`ffmpeg-give-up.spec.ts` pins that `onGiveUp` stays silent while restarts remain,
fires once when they are exhausted, and fires for the run-to-completion child
that dies after going live; `grid-compositor.spec.ts` pins that a reset drops the
partial frame and keeps the picture.
