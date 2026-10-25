---
id: D758
title: A camera status block carries only counters something feeds; a stall is read from frames delivered to the detector
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/addon-pipeline-orchestrator/src/camera-status-service.ts
  - packages/addon-pipeline-orchestrator/src/camera-status/**
  - packages/addon-admin-ui/src/components/pipeline/cameras/**
---

## Context

Pipeline → Cameras showed "Decoder on hub has written 0 frames to the
shared-memory plane while detection is active — the decode path is stalled" on
every camera that was detecting, and the roster counted all of them as having
issues. On the live hub the same cameras ran at 7–8 fps of detection.

The decoder block of `CameraStatus` served `sessionCount`, `formats` and four
shared-memory ring counters (`framesWritten`, `getFrameHits`,
`getFrameMisses`, `budgetMb`). `camera-status-service.ts` hard-coded all of
them to 0 / `[]`: the shared-memory frame plane was retired (frames live in RAM
in the `RetainedFrameStore`), and no decoder method is node-addressable, so
nothing fed them. The UI then raised `decoder-black-hole` from
`framesWritten === 0`, and rendered Sessions / SHM frames / SHM reads / SHM
budget rows that read 0 forever. Unknown was rendered as 0, and 0 as a fault
(the inversion D315 and D393 forbid).

## Decision

A status block carries a counter only when something on today's frame path
feeds it. The decoder block is `{ nodeId }` — where decode runs, co-located with
the detection node by construction — and nothing else. Whether frames flow is
read from `detection.actualFps`, the frames actually delivered to and processed
by the detector (runner `getCameraMetrics`). That counter already backs the
`detection-black-hole` rule (phase `active` and 0 fps), which is now the only
stall rule. Its "unknown" is preserved: when the metrics read fails the phase is
not `active`, so no alert is raised from a missing number.

## Alternatives rejected

- **Keep the fields and mark them unknown.** A field no code path can ever fill
  is not unknown, it is dead; keeping it invites the next surface to read it.
- **Base the decoder stall on the broker's per-profile `decodeFps`
  (`outFps`).** It also reads 0 on every live camera today: decoding moved out
  of the broker into the session decode workers. It is the same trap one block
  over.
- **A per-camera "frames decoded" counter from the frame plane.** None is
  exposed per camera today; `actualFps` plus `droppedFrames` is what the runner
  reports. Adding one is a runner change with no failure it would catch that
  `detection-black-hole` misses.

## Consequences

- The cap output shape changed (fields removed). The admin UI and the
  orchestrator ship together; the viewer never read the decoder block.
- The broker block's `outFps` still serves a stale `decodeFps` (0 on every
  camera, rendered as "26→0fps"). It raises no alert, and is left for its own
  change.

## Enforcement

`compose-camera-status.spec.ts` and `camera-status-cap.spec.ts` pin the decoder
block to exactly `{ nodeId }`; `camera-card-model.spec.ts` and
`cameras-overview.spec.tsx` pin that an active camera with frames reaching the
detector shows no issue and no shared-memory rows, and that a stall is the
detection black-hole.
