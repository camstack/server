---
id: D516
title: The new HomeKit camera service is offered PER CAMERA, and on by default
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/addon-export-hap/src/hap-export.addon.ts
  - packages/addon-export-hap/src/mappers/camera-accessory.ts
  - packages/addon-export-hap/src/mappers/types.ts
  - packages/addon-export-hap/src/multi-tier/multi-tier-service.ts
  - packages/addon-export-hap/src/mappers/builders/stream-bitrate.ts
  - packages/addon-export-hap/src/mappers/builders/h264-idr.ts
  - packages/addon-export-hap/src/multi-tier/tiers-for-sensor.ts
  - packages/addon-export-hap/src/multi-tier/rtp-streaming-control.ts
  - packages/addon-export-hap/src/multi-tier/setup-endpoints.ts
  - packages/addon-export-hap/src/multi-tier/negotiation.ts
  - packages/addon-export-hap/src/multi-tier/camera-capabilities.ts
  - packages/addon-export-hap/src/multi-tier/audio-stream-tiers.ts
  - packages/addon-export-hap/src/multi-tier/native-codec.ts
  - packages/addon-export-hap/src/__tests__/multi-tier-default.spec.ts
---

## Context

Apple's HKSV Open Source Compatibility Guide (Developer Preview, 2026-06-03)
adds two camera services alongside the classic one: `0x8031` (multi-tier RTP)
and `0x8033` (WebRTC). Both carry a `VideoCodecType` where `2` means H.265 —
the reason the operator asked for this at all: the kitchen camera is native
HEVC and we transcode it to H.264 to satisfy the classic service.

The previous release shipped the service as a global, off-by-default
**experiment** (`webrtcProbe`), to answer one question: does a controller engage
a third-party accessory there at all? Measured on the hub, 2026-09-16:

| time | what iOS did |
| --- | --- |
| 22:53:21 | read the characteristics of `0x8031` |
| 22:53:23 | opened the session on the CLASSIC service |

It engages, evaluates, and falls back. It does not ignore the service. That is
the whole justification for the default flipping: a controller that reads the
new service and declines is a controller we can eventually satisfy, and it costs
the accessory nothing while we cannot.

## Decision

**The switch is per camera, not global, and absent means ON.**

`resolveMultiTierService(settings)` returns `settings?.multiTierService !== false`
— the same shape as `resolveHksvRecording`, and deliberately not `=== true`.
Every camera exposed before this release has no such key, and the fleet must
move as one: a default of `=== true` would leave the feature dark everywhere
and make the operator's switch a per-camera opt-in for something we believe is
right for all of them.

Per camera rather than global because the decision is a property of the STREAM,
not of the bridge. A camera whose only profile is H.264 gains nothing from the
service and a camera that is native HEVC gains everything; the tiers we can
truthfully declare (`tiersForSensor`) already differ per camera, so the switch
belongs next to them. The global `webrtcProbe` field and its settings-schema
entry are removed rather than kept as a master switch — two authorities for one
fact is the shape D62 exists to prevent.

**It stores nothing new.** It lives in `ExportDeviceSettings`, the same record
that already owns `hksvRecording` and the exposure itself. D62's rule holds: the
authority that owned "how this camera is published to HomeKit" is the one being
written.

**The accessory still declares only what it can answer.** `0x8031` carries
`SupportedVideoStreamTiers` (`0x8043`) and `StreamingEnabled: false`, and
nothing else — a TLV8 characteristic answered with `''` is invalid, and the Home
app reads them in one batch, so one unanswerable characteristic poisons the
read. `tiersForSensor()` never emits HIGHEST: a tier we declare is a tier we
promise.

## What reading the guide changed, the next day

The measurement above was interpreted as "it engages and declines". Reading
§ 4.5 closes it differently:

> *"the presence of this service and characteristic with versions as specified
> in this document is required to signify that this camera supports the camera
> functionality described in this specification."*

`Camera Capabilities` (0x8010) is the handshake, and we had never sent it. iOS
was not weighing our tiers and rejecting them — it had no reason to believe the
accessory spoke the specification the tiers belong to. The two-second fallback
is what a controller does with a camera that never made the claim.

§ 3.6 also lists **eight** required characteristics on the streaming service. We
declared two. The service was not a minimal-but-valid offering; it was an
incomplete one, and the conclusion drawn from its silence was unsupported.

So the accessory now declares all three services together — Camera Capabilities
with `Version = "17.99"`, Camera Global Operating Mode (whose switches are the
operands of `Status Active`), and the streaming service with all eight — and
`canServeStream()` is `false` until the negotiation adapter exists. That is not
a half-built accessory: § 3.6 defines the state (*"Status Active must be set to
false if Streaming Enabled on this service is false"*, *"the accessory must
reject any request to start a stream if Status Active is set to false"*), and
both negotiating characteristics answer with the specification's own explicit
refusal rather than with nothing. A characteristic that answers nothing is what
put the kitchen camera on "loading".

The codec is DERIVED from the camera's largest published stream rather than
assumed, because claiming H.265 on an H.264 camera offers a stream we can only
produce with the transcode this service exists to remove.

## The negotiation, and the permission it unlocks

`Setup Endpoints` and `RTP Streaming Control` (0x8045) now drive the **same
engine** the classic service uses. hap-nodejs's own handlers
(`handleSetupEndpoints`, `_handleSelectedStreamConfigurationWrite`) are all
`private`, so the library's engine cannot be borrowed — but the formats can be
transcribed from it, and ours can be reached. A second engine would be two to
keep in agreement, which is the shape this repo has paid for before.

**The new control is not a variation of the classic one.** The classic
`Selected RTP Stream Configuration` carries the whole selected configuration in
its start — codec, profile, level, resolution, bitrate. `RTP Streaming Control`
carries a **tier identifier**, because the configuration was agreed when we
published `Supported Video Stream Tiers`. So the adapter maps an identifier back
to a tier WE published, and one we never published is `No Such Stream`:
improvising a geometry there would serve a stream the controller did not ask for
and it would look like it worked.

**The permission belongs to the session.** `canPassThrough` refused H.265
because *"iOS Home renders only H.264 over the classic HAP SRTP path"* — true,
and true only of that path. The same camera serves both services, so which one
negotiated decides what may be copied. An unknown codec stays refused on both:
the new service's permission is for H.265 specifically, not for whatever the
stream turns out to be.

This is the change that removes the transcode. Before it the kitchen camera's
4K HEVC was decoded and re-encoded to 720p H.264 to satisfy a service that
could not carry HEVC; the controller now asking for HEVC gets the bytes the
camera already produced.

**The key-frame counter learned HEVC** (RFC 7798's two-byte header, IRAP types
16–23, aggregation 48 / fragmentation 49). Nothing on the media path gates on
it — it is telemetry, and that is exactly why it matters: `videoKeyframes` and
`msToFirstKeyframe` are the numbers that proved D515's fix worked, and an HEVC
session streaming perfectly while reporting zero key frames has the same shape
as that bug.

### What is not proved by a test

The one line threading `session.negotiatedVia` into the selector
(`allowHevcPassthrough: session.negotiatedVia === 'multi-tier'`) has no unit
test: `camera-streams.ts` is a 2,561-line I/O module with no harness, and
standing one up is its own change. Neutralising the line to `false` leaves all
475 tests green, and that is recorded here rather than left to be discovered.
The rule it applies IS tested (`selectStreamForBudget`, both directions plus the
unknown-codec case); the wiring is verified live instead, on the log line that
reports `transcode` and the wire codec for a real session.

## Consequences

- **Turning it on or off RESTRUCTURES the accessory.** `addService` bumps `c#`
  and iOS re-reads the database. That was an argument for off-by-default while
  it was an experiment; now it is the cost of the release, paid once.
- The negotiation is not built. `Setup Endpoints` and `Selected RTP Stream
  Configuration` on the new service, and `StreamingEnabled: true`, are the next
  change — until then every controller falls back exactly as measured above, and
  the kitchen camera is still transcoded. The switch shipping first is
  deliberate: it is the piece an operator can turn off if the restructure
  misbehaves on their controller.
- The characteristic id differs by service — tiers are `0x8043` on multi-tier
  RTP and `0x8059` on WebRTC. We chose RTP because this addon already owns its
  SRTP path; a WebRTC service would mean a second transport for the same pixels.
