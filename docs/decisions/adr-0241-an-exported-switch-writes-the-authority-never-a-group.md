---
id: D241
title: An exported switch writes the authority the function already has, never a group
status: accepted
date: 2026-08-26
supersedes:
applies-to:
  - packages/addon-provider-homeassistant/src/ha-export/camera-functions.ts
  - packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts
---

## Context

D62 already forbids a second switch that can disagree with the authority that
owns a function. D113 already withdraws the aggregate switch group that used to
be the ONE coherent panel over eight per-camera functions, phase by phase, so
each function goes back to its own component's option.

`ha-export` — the Home Assistant push — was the last caller of the deprecated
`getCameraSwitches` / `setCameraSwitch` pair inside this repo. It read the
group for its state, read it again for its announce, and wrote through it for
commands, which meant every Home Assistant toggle was, structurally, a SECOND
group sitting downstream of the first: D62's failure shape, reached through an
exporter rather than a UI. The pair could not be deleted (phase 4 of D113)
while this remained true, because two of its eight rows —
`device-audio` and `broker-audio` — have no other writer in the product at all;
deleting the shim under an exporter still calling it would have made a camera's
microphone and its audio distribution permanently unmutable from the one place
that still muted them.

The fix was not "route Home Assistant's commands through the admin-ui's
hooks" — those are React hooks, not a server-callable surface — it was to give
the exporter the SAME kind of pure derivation the admin-ui panel already has
(`CameraFunctionSwitches.tsx`) and the same direct-to-authority write the other
successor surfaces already have, so `ha-export` stops being a caller of the
group and becomes one more surface that writes straight through.

## Decision

**Every switch this export renders is derived from, and written straight onto,
the authority that already owns the function — never a group, and never a
compatibility shim.** `camera-functions.ts` derives all eight functions' state
purely from eight authority reads (`deviceDisabled`, bindings, bindable caps,
recording config, notification mutes, the `privacy-mask` slice, broker audio
mute); `camera-function-writes.ts` sends each accepted write to exactly one
method on exactly one cap. A function whose authority did not answer renders
`available: false` and REFUSES a write rather than approximating one.

This generalises D62 to a surface outside this repo's own UI: the rule was
never "the admin UI must not build a second knob", it was "no consumer of an
authority may build a second knob" — and an exporter that renders a control in
someone else's product is exactly such a consumer.

## Consequences

The next exporter that renders a per-camera control (HomeKit, Alexa, or a
future one) has a model to copy and a guard that already knows how to check
it: read the authority, derive `available`/`enabled` purely, write straight
through, never re-open the retired group to get a coherent panel "for free".
Reaching for `CAMERA_SWITCH_CATALOG` / `deriveCameraSwitches` /
`getCameraSwitches` / `setCameraSwitch` from a NEW surface is a regression to
the surface D113 is actively withdrawing, not a shortcut.

`broker-audio` carries a routing obligation the others do not: the
stream-broker cap is a per-node singleton, so its write is refused outright
(never sent unrouted) when the caller cannot name the camera's source node.

`ha-export` leaving the deprecated pair's caller list means D113's phase-4
ledger (`scripts/check-switch-successor-surfaces.ts`) is now EMPTY inside this
repo — the pair is retained only for shipped viewers (v1.0.305) this repo
cannot redistribute, and its deletion is a decision for whenever those viewers
are no longer supported, not a decision this record makes.

## Enforcement

`scripts/check-switch-successor-surfaces.ts` — extended with eight rows
pointing at `camera-function-writes.ts` (Task A of the 2026-08-26 export
plan), one per authority write, verified by name (`deviceManager.setDisabled.mutate`,
`deviceManager.setWrapperActive.mutate` ×2, `recording.setDeviceConfig.mutate`,
`notificationRules.setDeviceMuted.mutate`, `privacyMask.setMask.mutate`,
`privacyMask.setAudioEnabled.mutate`, `streamBroker.setDeviceAudioMute.mutate`).
The same guard also fails the build the day anything in this repo calls
`getCameraSwitches` / `setCameraSwitch` again outside the shim itself.
`packages/addon-provider-homeassistant/src/ha-export/__tests__/camera-functions.spec.ts`
covers the pure derivation and the write dispatch directly, including the
refusal paths (an unanswered authority, an unrouted `broker-audio` write).
