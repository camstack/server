---
id: D589
title: HomeKit owns whether a camera records; this addon owns whether it can
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-export-hap/src/hksv/recording-active.ts
  - packages/addon-export-hap/src/mappers/camera-accessory.ts
---

## Context

This addon carried a per-camera `hksvRecording` switch deciding whether the
accessory OFFERED HomeKit Secure Video. HomeKit carries its own: iOS asks
"Stream" or "Stream and Allow Recording" during setup, writes the answer to
`CameraRecordingManagement.Active`, and hap-nodejs persists it on the
accessory. The prebuffer only ever ran while THAT characteristic was on.

Two authorities over one function, which is D62's defect, and it cost exactly
what D62 says it costs — twice in one day:

- the switch defaulted ON (2026-08-08), so four cameras reported "recording" in
  our UI while their advertisement had been withheld. Nobody was recording
  anything;
- the default was flipped OFF (2026-09-21, operator's request), which turned
  101's stored value off while its accessory — built under the old default —
  kept teeing HomeKit clips. `videoclips.listSources`, reading the new value,
  reported that the camera had no HomeKit source at all. Nobody had touched
  anything.

The switch also bought nothing the second authority did not already provide:
advertising recording starts no process. The cost — a permanent ffmpeg per
camera — begins when HomeKit turns recording on, and only then.

## Decision

The per-camera recording preference is **deleted**, not deprecated: no stored
field, no settings key, no resolver. An accessory advertises recording whenever
`buildHksvRecording` can serve the camera, and that is a CAPABILITY gate — a
fact about the camera (a copyable slot, or a transcode the operator allowed per
D588), never an opinion about it. Offering a toggle backed by nothing stays
forbidden, and a withheld camera still says why.

Where the addon needs to know whether HomeKit is recording, it READS the
characteristic off the published accessory at call time
(`readHomekitRecordingActive`). No mirror, no cache, no callback that can be
missed. The settings page keeps a row for it — reporting, with the cost of the
permanent prebuffer still written on it — because D62's other half is that an
off switch is REPORTED off, never made to look like a broken camera.

`null` is a third answer and is preserved end to end: a camera whose accessory
carries no recording service was never OFFERED it, which is not the same as an
operator declining it in Home. The clip source drops a camera's row only on a
real `false` (D315, D393).

## Consequences

Every capable camera rebuilds once to acquire the advertisement — a detach, a
re-attach and a `c#` bump, visible in HomeKit — and "Allow recording" then
appears on all of them in the Home app. The operator's original intent survives
that: exporting a camera still does not record it, because HomeKit asks.

Measured the moment 1.2.138 booted: **HomeKit remembered.** 101, whose
recording our flip had orphaned, advertised again and iOS resumed it by itself
within seconds (`recording active changed: true`, prebuffer running, copy
branch). Nobody touched the Home app. That is the whole argument for this
record — the state was never ours, and the only thing our switch had achieved
was hiding it.

The blast radius is also smaller than it first looks, and the earlier framing
of it was wrong: a camera must be EXPORTED to HomeKit before any of this
applies, and six of this fleet's 32 cameras are (112, 104, 107, 101, 108, 106).
One of them is H.265.

**What is now unguarded is the H.265 half of the fleet, once exported.** With D588, a camera
with no copyable slot records by re-encoding, and `allowTranscode` ships ON, so
for those 14 cameras the only thing between the hub and a permanent encoder is
the toggle in the Home app. The advertisement log names the branch and the
resolved decoder, and `allowTranscode` remains the per-camera CPU lever — but
nothing refuses on the operator's behalf any more, and that is the trade this
record is making.

The recordability token loses `rec:off`. Whether HomeKit records does not
change the accessory's shape, and a rebuild is about shape.

## Enforcement

`src/__tests__/hksv-authority.spec.ts` pins that no recording preference ships
and that `describeHksvCamera` reports HomeKit's answer, including the `null`
case. `src/hksv/__tests__/recording-active.spec.ts` pins the read itself
against real hap-nodejs accessories.
`mappers/__tests__/camera-accessory-recording.spec.ts` now asserts withdrawal
for a camera that CANNOT be served rather than one that was switched off.
