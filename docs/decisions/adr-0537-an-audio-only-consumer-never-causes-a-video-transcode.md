---
id: D537
title: An audio-only consumer never causes a video transcode
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/audio-stream-selection.ts
  - packages/addon-pipeline-orchestrator/src/audio-subscription-controller.ts
---

## Context

The audio analyser never had a stream of its own. `config.audioStreamId` is
typed, written `undefined` unconditionally, and read nowhere else — so audio
rode `motionStreamId`, the cam-stream backing the camera's MOTION profile. On
this fleet that is the `low` rung, and `low` is `derived:mid-to-low`: a stream
the broker MANUFACTURES with an ffmpeg transcode.

The broker counts audio subscribers as demand (`hasLiveIntent` reads
`audioChunkPlane.subscriberCount`), and the derived feeder is spawned and torn
down on exactly that edge. So a consumer that wanted nothing but audio held a
video transcode up for as long as it listened — permanently, on every camera
whose low rung is derived. It also delivered badly: camera 108's derived stream
produced zero audio chunks for four days, which is what `audio-track-probe.ts`
was written to catch.

Nothing chose this. Audio inherited the motion pipeline's rung, and the motion
pipeline's rung choice is legitimately its own.

## Decision

An audio-only consumer attaches to the lowest NATIVE rung — `low`, then `mid`,
then `high`, taking the first whose cam-stream is not `derived:*` — and never
to a rung the broker has to manufacture. An operator's explicit pick is still
obeyed verbatim, and reported when it is derived; that pick is a RUNG
(`auto | high | mid | low`, default `auto`), never a cam-stream id. When every rung is derived,
the analyser REFUSES with a named warning instead of silently spawning a
transcode: on this fleet `mid` is native, so the refusal is a statement about a
camera, not a default. The same selection arms the watchdog, so the stage that
recovers audio and the stage that consumes it can never disagree about which
stream they mean.

## Consequences

- The `derived:mid-to-low` feeder now dies when its last VIDEO consumer goes
  away. The release path was already correct; the audio subscriber was the
  thing holding it.
- A camera whose every rung is derived gets no audio analysis until an operator
  publishes a native one. That is deliberate: the alternative is paying a
  transcode nobody asked for.
- The operator picks a RUNG, not a stream. `audioStreamId` — typed, never
  written, read by nobody — is deleted; `audioStreamPick` (`auto | high | mid |
  low`, one `AudioStreamPickSchema` in `streaming-shared.ts`) replaces it,
  stored per camera and carried on `CameraDetectionConfig` AND
  `RunnerCameraConfig` so the subscription and the watchdog resolve the same
  stream. `auto` is the default and a real value: it IS the rule above, and an
  absent value reads as `auto`, so a camera nobody has configured is unchanged.
  A cam-stream id would have been the wrong knob — it is broker-internal and
  moves when a slot is reassigned, so a stored id silently stops meaning what
  the operator picked.
- A pick the camera cannot honour is REFUSED by name, never re-resolved:
  `pick-unassigned` (the camera no longer publishes that rung) and
  `pick-unresolvable` (the slot table could not be read). That is the third way
  audio can end up not running, and like the other two it is one WARN naming the
  camera and the stored value — silently falling back to `auto` would re-open
  "which stream is my audio on", the question this record exists to keep
  answerable.

## Enforcement

`audio-never-spawns-transcode.spec.ts` pins that the selection refuses a
derived rung, and `audio-stream-selection.spec.ts` pins the rule itself.
Review-only for new audio consumers.
