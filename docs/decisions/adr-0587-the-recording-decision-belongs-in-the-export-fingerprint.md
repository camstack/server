---
id: D587
title: A camera's HKSV recording decision lives in its export fingerprint
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-export-hap/src/hksv/recordability-token.ts
  - packages/addon-export-hap/src/hksv/recording-source.ts
---

## Context

A HomeKit accessory is built once. Whether it offers HKSV is decided during that
build — `pickRecordingSource` reads the camera's RTSP profiles and picks the
largest copyable slot at or below 1080p (D84) — and `computeExportFingerprint`
decides whether the accessory is ever rebuilt. That fingerprint covered
`{deviceId, deviceType, features}` and nothing else.

Two failures, both measured on this hub on 2026-09-21, and both the same shape:
**a decision the fingerprint does not describe survives its own reversal.**

*The withheld camera.* 107's accessory was built while its profiles were not yet
readable, so HKSV was refused with `no-enabled-stream` and the refusal recorded.
The profiles then arrived — three enabled H.264 slots, 3840×2160, 896×512,
640×360 — and nothing happened: the reconcile on `DeviceReady` computed the same
fingerprint and no-opped. 101, whose profiles were ready at build time, recorded
fine. The operator's question was the right one — *the RTSP profile should be
selected automatically by the plugin* — and it is; the picker was never the
defect. The defect was that its answer was made once, too early, and never
revisited.

*The switch that flipped underneath.* Making `hksvRecording` default to off
(same day) turned 101's switch off. An operator's explicit flip already rebuilds
the accessory, because `applyDeviceSettingsPatch` compares the old and new
values — but nobody flipped anything, so 101 kept teeing HomeKit clips from an
accessory built under the old default while `videoclips.listSources` reported no
HomeKit source at all. Clips were being written that every surface said did not
exist.

## Decision

The whole recording decision — **the switch, and the slot it resolves to** — is
part of a camera's export fingerprint, as one token appended to the device-shape
fingerprint: `rec:off`, `rec:none`, or `rec:<profile>`. The slot is named, not
merely its existence, because a clip inherits that slot's resolution and GOP, so
gaining a bigger copyable profile is a rebuild. `recordabilityToken` derives it
by calling `pickRecordingSource` — it never re-implements the rule — and the
refusal KIND is deliberately not in the token: every refusal means the same
thing to the accessory, and spelling out which one would rebuild a camera that
merely changed how it is unrecordable.

Profiles that could not be READ are not an answer. `null` means *do not move the
fingerprint*, and `withRecordabilityToken` carries the persisted token forward —
but only onto the base it was persisted against, since a device that also
changed shape has a rebuild of its own to answer for. A camera whose switch is
off is asked nothing at all.

## Consequences

Every camera accessory rebuilds once as the token appears — a detach, a
re-attach and a `c#` bump, visible in HomeKit. That is the cost of the decision
having been invisible until now, and it is paid once.

A transient read failure must never be folded into "cannot record": that would
republish a working accessory on every blip, which is the churn the fingerprint
exists to prevent. This is the same discipline `resolveExportFingerprint`
already applies to a not-yet-probed device, and the same rule as D393 — a
measurement that failed is not a zero.

Non-cameras carry no token, so nothing republishes a switch or a lock for a
question that does not apply to it.

## Enforcement

`packages/addon-export-hap/src/hksv/__tests__/recordability-token.spec.ts` —
including the carry-forward case, which was confirmed to go red when the fix is
removed. `src/__tests__/probed-gate.spec.ts` pins the composed fingerprint on
the real `computeExportFingerprint` path, so a token silently dropped fails
there rather than in HomeKit.

Live verification (2026-09-21, export-hap 1.2.136): 104, 592, 618 and 640
advertise, each with a slot picked automatically (`592/mid 896×512`,
`104/mid 1280×720`); 587 is withheld as `no-h264-stream`, an honest permanent
refusal; 101 stopped teeing. No `no-enabled-stream` remains on the fleet.
