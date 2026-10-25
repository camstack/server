---
id: D529
title: A derived camera answers a camera's questions, and is created with analysis off
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-activity.ts
  - packages/system/src/builtins/camera-grid/grid-activity-mirror.ts
  - packages/system/src/builtins/camera-grid/grid-detection-mapping.ts
  - packages/types/src/interfaces/camera-switches.ts
---

## Context

The operator asked for the grid's tile in the viewer to light up when something
happens on the cameras it composes — *"solamente per permettere il rendering dei
layer sull'applicazione viewer"* [only to allow rendering the layers on the viewer application] — and then, explicitly: **no viewer change**,
and the grid itself must do it, *"per motion se almeno una ha motion, per
l'audio emette l'audio più alto"* [for motion if at least one has motion, for audio it emits the highest audio].

The app lights a camera from three bus categories filtered by `deviceId`:
`motion.on-motion-changed` (with `motion.getStatus` polled as a backstop),
`pipeline.audio-inference-result`, and `detection.result`. A grid is a
`DeviceType.Camera`. So there is nothing to invent — the grid has to answer
those three questions about its own device id.

What that costs is inheriting a camera's LISTENERS. Checked one by one before
shipping: the recorder's event capture, the HomeKit / Alexa / Home Assistant
exports are per-device and do nothing until an operator enables them for this
camera. The one with no gate of its own was `pipeline-analytics`, which would
have opened a motion EPISODE per forwarded event, duplicating rows the sources
already write. Its gate turned out to be the `pipeline-analytics` WRAPPER
BINDING — which is the operator's own answer: *"per queste camere la pipeline va
disattivata di default, lo stesso per le camere terminal"* [for these cameras the pipeline must be disabled by default, same for the terminal cameras].

## Decision

A derived camera (a grid, a Terminal camera) answers a camera's questions about
itself, derived from its sources and never from its own picture — analysing the
composite would be a second motion authority for cameras that already have one,
and a decode nobody pays today.

It is created with the analysis family switched OFF, by writing the authority
that already owns each function (the wrapper binding, D62), from ONE list:
`DERIVED_CAMERA_SILENCED_CAP_NAMES` in `@camstack/types`. Applied at creation
only, so an operator who turns analysis back on wins permanently.

Motion is the OR of the sources; the audio level is the loudest CURRENT reading;
a detection's box is carried through the cell geometry onto the canvas.

## Consequences

**A dropped clear must not light a grid for ever.** Bus events are telemetry
(D8/D11) and a grid runs no phase machine, so it has no falling edge of its own.
Each source's motion is remembered with its time and expires on
`MOTION_CLOSE_AFTER_MS` — imported, never re-spelled, because a second number
here would disagree with the system's one answer about exactly these cameras.
This is D49's shape: state refreshed off the event path, not a gate that re-reads
something fallible in order to decide.

**Only the EDGE is emitted.** `motion.on-motion-changed` is a transition; a
four-camera grid re-announcing "still moving" on every source's every push would
carry four times a camera's traffic for one fact.

**Detection carries boxes whether or not anyone wanted them** — it is the same
event the viewer draws the overlay from. A source's own pixel box would be drawn
against the composed canvas at confidently wrong coordinates, so every box goes
through `mapDetectionToCanvas`: one source can appear in several cells (so one
detection lands more than once, or not at all), a cell shows only part of its
source, and a subject straddling the crop edge is clipped rather than dropped. A
`refinedBbox` and a `mask` are measured against the source frame and have no
meaning on the canvas, so they are dropped rather than carried wrong.

**A grid never forwards its own events back into itself.** One grid used as a
cell of another is a shape this addon permits, and without the guard the pair
would echo for ever.

**The two silencing lists are now one.** They had drifted: each named three caps
and neither named `pipeline-analytics`. Merging them is what exposed that the
Terminal's spec was asserting its own fake's setup against the list.

## Enforcement

`grid-activity.spec.ts` pins the OR, the edge-only emission, the canvas
re-addressing and the unknown-device answer; `grid-activity-mirror.spec.ts` pins
the expiry and the loudest-fresh rule; `grid-detection-mapping.spec.ts` pins the
multi-cell, clipped and dropped cases; `derived-camera-silenced` is asserted from
the shared constant in both silencing specs.
