---
id: D1057
title: A hosted camera row is the composer's; engines serve caps on it
status: accepted
date: 2026-11-16
supersedes:
applies-to:
  - scripts/check-engine-hosted-no-own-rows.ts
  - packages/types/src/composition/engine-hosted-blocks.ts
  - packages/types/src/composition/helpers/spec.ts
  - packages/system/src/builtins/composer/**
  - packages/system/src/builtins/camera-grid/**
  - packages/addon-terminal/src/terminal-camera-host.ts
  - packages/addon-admin-ui/src/components/composition-editor/EngineHostedBlockEditor.tsx
  - packages/addon-admin-ui/src/components/composition-editor/TerminalCameraPicker.tsx
---

## Context

A camera grid and a Terminal camera were each made on their own page (System
→ Camera grids, System → Terminal), and each engine declared its camera row
itself: the camera-grid builtin from its grid records, the Terminal addon from
its terminal instances. Every other derived device the operator builds is a
Build-your-self block whose row the composer declares. Two parallel ways to
make a derived camera meant two lists, two naming paths, two delete paths, and
a camera that existed before (or after) the thing it showed.

The first idea was to keep the engines as row owners and only list their
cameras in Build-your-self. That keeps the second list, and a block whose row
another addon owns cannot be renamed, moved or deleted through the block.

## Decision

A camera grid and a Terminal camera are core-block helper kinds (`grid`,
`terminal`, `EngineHostedHelperSpec`). The composer owns the row
`composed-<blockId>`, its name and its room, as for every block. The engine
(the camera-grid builtin, the Terminal addon) keeps no list of its own: each
pass it reads the blocks and the composer's rows, builds its device ON that row
through `loadContext`, and serves the camera caps there as a cross-addon
native. A read that did not answer changes nothing, and a hosted camera is
withdrawn only after two consecutive trusted reads agree its block is gone. An
engine never declares a camera row of its own (guard
`check-engine-hosted-no-own-rows`).

The admin UI follows: the helper picker offers Camera grid and Terminal camera,
a grid block mounts the grid layout editor on its camera, a Terminal camera
picks its Terminal (one Terminal, one camera: a taken one is shown disabled and
names its block), and the Camera grids page is removed. Deleting a Terminal
deletes its camera block, and the delete confirmation names that camera.

No migration: existing grid and Terminal cameras are not converted. The rows
the engines declared before are swept unconditionally, and the operator
recreates those cameras as blocks. Extending the migration engine to carry
them over is tracked in camstack/planning#584.

## Consequences

- An upgraded hub loses its old grid and Terminal cameras (and whatever
  referenced their device ids) until the operator recreates them; the
  changelog says so.
- A second engine-hosted kind reuses `engine-hosted-blocks.ts`
  (`selectEngineHostedBlocks`, `HostedWithdrawalGate`, `hostEngineDevice`)
  instead of declaring rows.
- The engine's block read is on its pass, so a new block's camera caps appear
  one pass after the block is saved; the grid editor says so while its camera
  is not there yet.

## Enforcement

Specs: the engine hosts and withdraws through the shared gate
(`engine-hosted-blocks.spec.ts`, `engine-hosted-device.spec.ts`, `terminal-camera-host.spec.ts`), the
picker disables a taken Terminal (`TerminalCameraPicker.spec.tsx`), and the
Terminal page reads its camera from the blocks (`Terminal.spec.tsx`).
`scripts/check-engine-hosted-no-own-rows.ts` refuses a row-creating call
(`new DeclaredDevices(`, `devices.create(`, `allocateDeviceId(`) in the
runtime source of the camera-grid builtin and the Terminal addon; it is
textual, so a row declared through another helper is still review only.
