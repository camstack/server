---
id: D224
title: The freshness of a camera-native fact lives in its PROVIDER — a consumer never keeps a second copy
status: accepted
date: 2026-08-21
supersedes: D221
applies-to:
  - packages/types/src/device/runtime-state-helpers.ts
  - packages/addon-provider-hikvision/src/hikvision-camera.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-amcrest/src/amcrest-camera.ts
  - packages/addon-pipeline-orchestrator/src/switch-authorities.ts
---

## Context

[D221](./adr-0221-a-polled-list-never-dials-a-camera.md), earlier the same day,
took the two camera-native planes behind `CameraStatus.switchedOff` off the
request path by putting a stale-while-revalidate mirror in the CONSUMER
(`privacy-plane-mirror.ts`, in the orchestrator). It worked —
`getCameraStatuses` went from 1251–1322ms to 120–466ms — and it was the wrong
place.

**The mechanism it reimplemented already existed, one layer down.** Every
`privacy-mask` provider already served `getStatus` through
`createRuntimeStateBridge`: a per-cap slice of the device's runtime state, with a
staleness window, a miss cooldown for a camera that stops answering, and a wake
warm-up for battery cameras. What was wrong was one number. The bridge was
configured `staleMs: 10_000` — a window sized for a reading that moves on its
own — while a fleet-wide list polled it every **5 seconds**. The slice was
therefore stale on essentially every read, so the bridge dialled the camera on
essentially every read. The consumer-side mirror did not fix that; it hid it.

And a second cache over one fact is not merely redundant, it is WRONG here, in a
way the first version could not see:

- **Its invalidation was structurally incomplete.** D221 recorded that
  "`CameraSwitchService` … is the only such path on this server". It is not. The
  privacy-mask editor (`PrivacyMaskSettings.tsx`) writes `privacyMask.setMask` /
  `setAudioEnabled` **directly through the device proxy**, never through this
  server's switch service. So the one control an operator actually uses to change
  the fact could not invalidate the copy the badge read. The mirror was stale by
  design on the only write that mattered.
- **It hid an unbounded read.** With the badge served from the mirror, nobody
  noticed that Hikvision's `privacyMask.getOptions` — 20 of the 29 cameras on
  this fleet — made its own pair of ISAPI calls with **no cache at all**,
  re-dialling on every single invocation. Measured: 6330ms then 1494ms on the
  same camera, back to back. Nor that Reolink's `resolveCapOptions` opens no
  cooldown on a FAILED probe, so an unreachable camera was re-probed forever:
  device 3629, an offline battery Reolink, cost **23.1s on every `getOptions`
  call** while its `getStatus` sibling answered in 8ms, because the bridge had a
  miss cooldown and the options path did not.

Raising the mirror's refresh window was rejected: it makes the second authority
staler, not less of a second authority. Making the mask editor invalidate the
mirror too was rejected: it makes every future writer of that cap responsible for
a cache in another addon, which is the shape D62 forbids.

## Decision

**A fact that lives on a device is kept fresh in the addon that owns the device,
and nowhere else.** Consumers read through.

Concretely, for a cap on a polled path:

1. Its freshness window belongs to its READER, and it is named for why it is that
   long. A cap whose value changes only when an operator writes it — where the
   `set*` path already re-reads the camera into the slice, which is a stronger
   invalidation than any downstream mirror can offer — takes
   `OPERATOR_WRITTEN_STALE_MS` (10 minutes). Ten minutes bounds only the case we
   do not write: a change made in the vendor app. It never delays the operator's
   own change.
2. A stale-but-present slice is SERVED and revalidated behind the caller
   (`staleRead: 'serve-and-revalidate'`). A cold slice still awaits, so the first
   render is a real answer.
3. **A read never joins a refresh that is already in the air.** It is answered
   from the slice — including a cold, empty one, which reports UNKNOWN, which is
   the truth about a camera nobody has reached. This is the whole cost of an
   unreachable camera: without it, every poll landing inside device 3629's 23.1s
   give-up spent the caller's full 1.2s source budget waiting for an answer that
   was never coming.
4. Every OTHER read the same cap exposes gets the same discipline, or it becomes
   the leak. `getOptions` is a read: it is served from a persisted descriptor
   (Reolink's `capOptionsSnapshot`, Hikvision's `deviceCache.privacyMaskOptions`),
   a failed probe opens a cooldown, and an in-flight probe is not joined either.

## Consequences

- `privacy-plane-mirror.ts` is deleted, with its spec and its wiring.
  `readSwitchAuthorities` has no state of any kind: all eight authorities are
  read-through, and a change made at a camera by any writer, through any path, is
  visible on the very next poll.
- The two planes can be up to ten minutes stale **against a change we did not
  make**. Against a change made through this system they are never stale.
- A provider that puts a cap on a polled path now owns a real obligation: window,
  stale-read policy, cooldown, in-flight rule, on every read the cap exposes.
  That is more to get right in one place than the mirror was — and it is one
  place instead of one per consumer.
- Hikvision's `privacyMask.getOptions` REFUSES rather than answering with a
  fabricated descriptor when the camera has never replied. An unknown camera
  reads as unknown; it does not render controls.
- `HikvisionDeviceCacheSchema` gains `privacyMaskOptions`. It is written only
  when the value moves, so a refresh every ten minutes is not a SQLite commit
  every ten minutes.
- The Reolink privacy bridge is deliberately given NO logger, unlike the other
  two: its refresh is `sleepGatedRefresh`, so on a sleeping battery camera it is
  a designed no-op that the bridge cannot tell from a fault — measured at 4 false
  WARN lines per 5 minutes per healthy camera. Its real failures are reported by
  `resolveCapOptions`, with the firmware's own error and the same `deviceId` tag.

Measured on the live hub, 29 cameras, 60 polls at 5s, after:
`getCameraStatuses` **p50 117ms / p90 360ms / max 1257ms** (D221's mirror gave
p50 118ms — the same, without a second authority); privacy-mask reads across the
fleet **26985ms → 638ms** for a warm pass of 56 calls; orchestrator WARN lines
**16 per 5 minutes**, against 337 in one minute in the original incident and 89
per minute under D221.

The toggle test, the one a too-long window cannot pass: `setAudioEnabled`
written straight to the cap — the path the mirror could not see — moved the
polled badge from `switchedOff: []` to `["device-audio"]` and back **on the
first poll after each write**, at 127ms and 130ms.

## Enforcement

`packages/types/src/device/__tests__/runtime-state-helpers.spec.ts` pins the
bridge halves against the real helper: a stale read is served while it
revalidates, concurrent stale reads collapse to one refresh, a cold read still
awaits, a background failure never reaches the caller, twelve 5s polls at the
operator-written window cost ONE dial, an operator write is visible immediately,
a read never joins an in-flight refresh, and the awaiting default is unchanged.

`privacy-mask-read-discipline.spec.ts` in each of the three providers pins the
per-provider half structurally — window, stale-read policy, no dial from
`getOptions`, persisted descriptor, failed-probe cooldown, in-flight rule, and
that every write re-reads the camera.

`packages/addon-pipeline-orchestrator/src/__tests__/switch-authority-camera-probe.spec.ts`
pins what remains true in the consumer: a camera-side change is visible on the
very next poll, the cheap authorities stay live on all twelve, a stalled source
nulls only its own field, and a repeating fault leaves at most two lines with the
first carrying `tags.deviceId`.

No guard script. "Do not add a cache in front of a cap" is not mechanically
detectable from a diff; review is what catches it. What IS detectable — a cap on
a polled path configured with the 10s default — is caught by the three provider
specs, one per provider that owns such a cap.
