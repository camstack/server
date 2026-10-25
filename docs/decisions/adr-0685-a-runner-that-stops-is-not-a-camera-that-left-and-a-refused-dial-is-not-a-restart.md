---
id: D685
title: A runner that stops is not a camera that left, and a dial the source refused is not a writer restart
status: accepted
date: 2026-09-30
supersedes:
applies-to:
  - packages/addon-provider-hikvision/src/hikvision-camera.ts
  - packages/addon-pipeline/src/recorder/addon/segment-writer.ts
  - packages/addon-pipeline/src/recorder/addon/dial-refusal.ts
  - packages/addon-pipeline/src/stream-broker/device-removal.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
covers:
  - packages/types/src/device/base-device-provider.ts
  - packages/addon-pipeline/src/stream-broker/addon.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-listen-server.ts
---

## Context

Every Hikvision runner restart cost every recording writer on the hub about six
ffmpeg restarts in 25 s. Measured on 2026-09-29, 21:12:34–21:13:00: 132 writer
exits, `exitCode=8`, stderr `method OPTIONS failed: 404 Not Found` from the
LOCAL restream — 11 cameras × 2 profiles × 6 re-dials. `restartsInWindow`
reached 7 against the writer's storm budget of 15 per hour, on cameras that
never went away.

The path, traced:

1. `BaseDeviceProvider.onShutdown` decommissions every device of a runner that
   is stopping, and decommission calls the device's `removeDevice()` — the same
   hook an operator's delete calls.
2. `HikvisionCamera.removeDevice()` retracted every stream it had published
   (`streamBroker.retractCameraStream`).
3. The broker tore those brokers down and `unregisterRestreamer`-ed their paths,
   so every recorder ffmpeg lost its session and every re-dial was answered
   `404` by `rtsp-listen-server.ts` until the new runner booted and the catalog
   reconcile re-published them.
4. The writer treated each refused dial as a stream that ended: a `WARN ffmpeg
   exited`, an `INFO restarting`, and a charge against the storm window. Three
   provider restarts inside an hour — a deploy and two crashes — and a healthy
   camera "gave up: restart storm".

A Hikvision stream is `pull-rtsp`: the broker dials the CAMERA. The provider is
not on the byte path, so its runner stopping changes nothing about the stream.
The retraction existed for removal, and removal already has an owner: the
device-manager emits `DeviceUnregistered` and the broker's `handleDeviceRemoved`
retracts the whole device, assignments included.

That makes the delete depend on ONE event, and events may be dropped (D8/D11).
The first draft of this record called the leftover harmless ("lazy: nothing
dials them") and review showed it is not: `high` is default-warm, its prebuffer
hold calls `checkDemand()` and dials the camera with no consumer at all, and the
clip ring is armed at broker creation. A deleted camera whose event was lost
would be pulled over RTSP until the broker restarted.

## Decision

A provider whose runner is not on a stream's byte path never retracts that
stream from `removeDevice()`: the hook also runs on a runner stop, and a stop is
not a removal. Removal is the broker's `DeviceUnregistered` path. And a recording
writer whose ffmpeg was refused at the RTSP handshake (`method
OPTIONS|DESCRIBE|SETUP|PLAY failed: <status>`) treats it as a deferred re-dial:
named on every occurrence with `tags: { deviceId }` (WARN on the first of a run,
INFO after), counted by the consecutive rapid breaker, and NOT charged to the
storm window, which exists for streams that run and keep ending. A refusal
never resets that breaker either, however long the source took to refuse.

Removal is backed by a reconcile, not by the event alone: the broker's 30 s
catalog poll, which already reads `deviceManager.listAll`, retracts and purges a
device whose streams are registered but which two successful listings at
least one poll interval (30 s) apart both omit — closer reads (the startup
pass's 1.5 s re-runs, overlapping polls) are one observation. A failed read or
an empty listing decides nothing, a device that reappears in between is
unmarked, and a mark whose device has no streams any more is dropped (D49). Every sweep is a WARN with
`tags: { deviceId }`.

A provider that is gone for good — its addon disabled, or its runner
terminally `failed` (D6) — leaves its cameras RECORDING: the broker dials the
camera, not the provider, and the device is still in the fleet listing. This
holds until the broker restarts, after which the catalog pull fails and the
streams are not re-published. To stop a camera, the operator disables the
CAMERA (`setDisabled`); the same poll releases a disabled camera's brokers
within one tick. There is no cheap, reliable "provider gone" fact to key an
automatic stop on: `listAll` serves persisted rows whatever the runner's state,
`addons.list` carries no runtime status, readiness is an event that may be
dropped, and a duration threshold would take a slow restart for a death — the
churn this record removes.

## Consequences

- A Hikvision runner restart no longer touches the brokers, so the writers keep
  recording through it.
- Reolink and Wyze still retract on teardown, deliberately: they SERVE the bytes
  (loopback rfc4571, P2P), their urls die with the runner. A restart of either
  still refuses the writer's re-dials for as long as it takes; that is now
  cheap — one WARN per writer, INFO per re-dial, and no storm budget spent.
- `addon-provider-rtsp` has the same shape as Hikvision (camera url, retract in
  `removeDevice`) and was not changed here.
- A dropped `DeviceUnregistered` costs at most two poll ticks (~60 s) of a
  deleted camera being dialled; then the departed-device sweep retracts and
  purges it. The same sweep also covers the case that predated this record: a
  camera deleted while its owning runner was down.
- The provider-gone behaviour above differs across a broker restart (recording
  before, dark after). Accepted: making it uniform needs a provider-liveness
  fact the system does not have.
- A source that never comes back is still bounded: ten consecutive refusals
  reach `MAX_RESTARTS`, the writer gives up and the controller's outer path
  re-acquires the stream.

## Enforcement

- `addon-provider-hikvision/src/__tests__/hikvision-teardown-keeps-streams.spec.ts`
  — `removeDevice()` must not call `retractCameraStream`.
- `addon-pipeline/src/recorder/addon/__tests__/segment-writer-dial-refused.spec.ts`
  — three provider restarts (21 terminations) inside an hour are not a storm;
  every refusal is named per camera; consecutive refusals still give up, also
  when each one takes longer than `STABLE_RUN_MS`.
- `addon-pipeline/src/stream-broker/__tests__/departed-device-sweep.spec.ts` —
  two agreeing reads sweep; one read, a reappearance, a failed or an empty
  read do not.
- `addon-pipeline/src/stream-broker/__tests__/device-removal-assignments.spec.ts`
  — the `DeviceUnregistered` registration (`subscribeDeviceRemoval`, the call
  `addon.ts` makes) retracts and purges on a real event. That `addon.ts` makes
  the call at all is review only.
- Nothing stops a new provider from retracting in `removeDevice()` again —
  review only.
