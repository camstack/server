---
id: D544
title: The camera switch group is the one surface, on both clients
status: accepted
date: 2026-09-19
supersedes: D113
applies-to:
  - packages/addon-admin-ui/src/components/device/CameraFunctionSwitches.tsx
  - packages/addon-admin-ui/src/components/device/camera-switch-rows.ts
  - packages/addon-pipeline-orchestrator/src/camera-switch-service.ts
  - scripts/check-switch-successor-surfaces.ts
---

## Context

[D113](adr-0113.md) withdrew D62's aggregate switch group on the operator's
verdict of 2026-08-12: every function already had a settings page of its own,
so the group was a second place to look for something that was never missing
from the first. `getCameraSwitches` / `setCameraSwitch` were marked deprecated
and kept alive only for shipped viewers, with a phase-4 removal train pending.

What actually happened in the thirteen months since is the opposite of that
prediction, and the operator found it on 2026-09-19 without looking for it:

- **The viewer never left the group.** `CameraSwitchGroup` renders the whole
  catalog — nine rows, labels and cost lines straight off the wire — and it is
  the surface the operator uses daily.
- **The admin UI grew a hand-written list instead.** Four ids, re-derived
  locally from `getBindings` + `recording.getDeviceConfig`. The other five
  (`privacy-mask`, `device-audio`, `broker-audio`, `stream-broker`,
  `notifications`) had no representation on the device header at all.

So D113 did not produce "one surface per function". It produced **two
different surfaces that disagree about which functions exist**, which is the
shape of defect D62 and D113 both exist to prevent — reintroduced at the level
of the surface rather than the store. The operator's words on finding it: the
mask control is on the viewer and not in device details.

The deprecation also stopped being honest. A shim "kept alive only for shipped
viewers" that the shipped viewer is BUILT ON is not a shim; it is the API, and
calling it deprecated only stopped new code from using the good one.

## Decision

**The camera switch group is reinstated as THE per-camera function surface, and
both clients render the same one.** `pipelineOrchestrator.getCameraSwitches` /
`setCameraSwitch` are no longer deprecated: they are the composed read and the
composed write, and the admin UI's device details renders them as a single
multi-select rather than a row of independent per-function pills.

**What D62 and D113 both established is kept verbatim and is not weakened**:

- a switch **stores nothing** — `CameraSwitchService.applyWrite` dispatches on
  `CameraSwitch.authority` and writes the authority that already owns the
  function. That is why reinstating the group costs nothing in correctness:
  the group was never a store, only a composition.
- **an off function is REPORTED off** — `CameraStatus.switchedOff` stays
  composed straight from the authorities by `composeSwitchedOff`, never from
  this group. Nothing here touches that path.
- **unknown is never off** — a row the hub could not read is `available: false`
  and draws as unknown, never as "the operator turned this off".

**Neither client keeps a catalog.** Labels, cost lines, availability and order
all travel on the wire, so a switch the hub gains tomorrow renders tomorrow on
a client released today. Icons are decoration matched on the LABEL; an
id-keyed icon map is a catalog through the side door and is guarded against on
both clients.

## Consequences

- Phase 4 of D113 — deleting the pair, the catalog and the panels — is
  **cancelled**. `check-switch-successor-surfaces.ts` stops policing new
  callers of the pair and keeps the half that still holds: every switch writes
  its own authority.
- The per-function surfaces D113's phase 3 built are NOT removed. A camera's
  recording settings still edit `RecordingConfig.enabled`; the privacy-mask
  component still has its own zone editor. The group is the place to flip a
  function; those pages remain the place to configure it.
- The device header stops being a row of pills whose membership was a local
  decision. One control, every function the hub reports.
- `privacyMaskEnabled` on the Reolink driver form is deleted with this: it was
  a SECOND writer of the mask (`setMask`) against the cap's `setMaskZones`,
  reading a config copy rather than the camera. That is the "two knobs, one
  store nobody reads" defect by the letter, and it is what made the admin UI
  and the Reolink app disagree.

## Enforcement

`check-switch-successor-surfaces.ts`, rewritten to this decision: it still
asserts every retired switch's authority write, and no longer fails a new
caller of the pair. `camera-switch-rows.spec.ts` (admin UI) mirrors the
viewer's own guard — no source file branches on a switch id, and an
unrecognised row still renders a complete control.
