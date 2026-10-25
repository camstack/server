---
title: HomeKit export — what actually fails, and why the migration the operator asked for does not exist yet
last-verified: 2026-09-29
applies-to:
  - packages/addon-export-hap/src/accessory-publisher.ts
  - packages/addon-export-hap/src/hksv/build-recording.ts
  - packages/addon-export-hap/src/hksv/fragment-source.ts
  - packages/addon-export-hap/src/hksv/recording-delegate.ts
  - packages/addon-export-hap/src/hksv/recording-options.ts
  - packages/addon-export-hap/src/hksv/recording-source.ts
  - packages/addon-export-hap/src/mappers/camera-accessory.ts
  - packages/addon-export-hap/src/mappers/child-accessory.ts
  - packages/addon-export-hap/src/mappers/generic-accessory.ts
  - packages/addon-export-hap/src/mappers/kind.ts
  - packages/addon-export-hap/src/mappers/builders/camera-streams.ts
  - packages/addon-export-hap/src/mappers/builders/rtcp-receiver-report.ts
  - packages/addon-export-hap/src/mappers/builders/stream-bitrate.ts
  - packages/addon-export-hap/src/mappers/builders/stream-bitrate-probe.ts
  - packages/addon-export-hap/src/mappers/builders/stream-ffmpeg-args.ts
  - packages/addon-export-hap/src/mappers/builders/stream-telemetry.ts
  - packages/addon-matter-broker/src/matter-controller-impl.ts
  - packages/types/src/capabilities/webrtc-session.cap.ts
covers:
  - packages/addon-export-hap/src/**
  - packages/addon-matter-broker/src/**
---

# HomeKit export — diagnosis, and the investment question answered

> Status: proposed, 2026-08-05. Written for W2 of the parallel-workstream batch
> in [`../roadmap.md`](../roadmap.md).
>
> The brief was: *the stream does not work, and rather than repairing the current
> path, invest in the new HomeKit camera API.* This document does the diagnosis
> and then answers the investment question — **with the opposite conclusion to
> the one the brief assumed**, on evidence.
>
> Numbers are `[measured]` on the live hub on 2026-08-05 unless marked
> `[source]` (read from installed code) or `[undetermined]`.

> **STATUS, re-verified 2026-08-14 against `packages/addon-export-hap/src/`.**
> The header used to say *nothing here was deployed*. That has not been true
> since 2026-08-06, and this note is now a record of a repair that happened
> rather than a proposal.
>
> **BUILT — the repair recommendation of §3 was taken, and it worked.** R1
> through R6 all shipped (§3.0–§3.0.7); §3.0.6 records live view rendering.
> Everything §3 names is in the tree today:
> `mappers/builders/rtcp-receiver-report.ts`, `stream-bitrate-probe.ts`,
> `stream-ffmpeg-args.ts`, `stream-hwaccel*.ts`, `stream-telemetry.ts`.
>
> **BUILT — HKSV, which §1.7 and §5 describe as withdrawn.** The withdrawal
> ([D50](../decisions/adr-0050.md)) held only until the missing piece existed. A
> live fMP4 fragment plane was built ([D80](../decisions/adr-0080.md)), then the
> permanent prebuffer plus a real delegate and an advertisement that means it
> ([D84](../decisions/adr-0084.md)). `packages/addon-export-hap/src/hksv/` now
> holds `recording-delegate.ts`, `recording-source.ts`, `fragment-source.ts`,
> `build-recording.ts` and `recording-options.ts`; `mappers/camera-accessory.ts`
> passes `recording` to the `CameraController` again, and since 2026-08-08 it is
> ON unless the operator turns it off. §1.7's diagnosis of the STUB stands —
> what is dead is the stub, not the service.
>
> **BUILT — the exporter is no longer camera-only (2026-08-13).** `pickMapperKind`
> returned `'camera'` for every device it was asked about and the Export tab was
> hard-gated on `isCameraDevice`, so 30 of 31 device types were invisible to
> HomeKit while reaching Home Assistant and Alexa. `mappers/kind.ts` now picks
> the accessory shape from the type and a capability→service table decides what
> it publishes: switches, lights, locks, contact/motion/occupancy/smoke/CO/leak
> sensors, temperature, humidity, illuminance and battery
> (`mappers/generic-accessory.ts`, `mappers/builders/generic/`). A device
> carrying no mapped capability is REFUSED rather than published.
> **Since 2026-09-13 `alarm-panel` joins them** — `Service.SecuritySystem`
> (`mappers/builders/generic/security-system.ts`), added to
> `HAP_EXPORTABLE_DEVICE_TYPES` once the two blockers the table could not
> honour were honoured explicitly: HomeKit is offered only the arm modes the
> panel accepts, and a panel that requires a PIN refuses the write out loud
> rather than pretending to arm. `cover`, `climate`, `fan`, `valve`,
> `humidifier`, `water-heater`, `button` and `media-player` remain deliberately
> absent.
>
> **NOT built, unchanged.** §4's Matter export addon. The trigger is still
> unfired: Apple has shipped no Matter camera support. Do not start.
>
> **Still open.** The `[undetermined]` items in §5 that no shipped work touched:
> why the audio leg is never probed, and whether the 2.6–2.8 s frame gaps on
> `mid`/`high` are a broker or a camera fault. §1.9's `as unknown as` casts
> stand at **27** on 2026-09-23 (they moved with the new service, not against
> it), of which **three** are in production code — one each in
> `mappers/child-accessory.ts`, `accessory-publisher.ts` and
> `hksv/recording-delegate.ts`. The rest are in specs, which the no-casts lint
> does not read.
>
> **STATUS, 2026-09-23. §1.7's two "future spec" items are no longer future,
> and §5's HKSV picture is out of date.**
>
> - **The new camera service is DECLARED, per camera, and it NEGOTIATES.** §1.7
>   item 2 read it as a thing to consider; it shipped over 2026-09-16/17, on by
>   default, after a probe that first established iOS actually reads it. Setup
>   Endpoints and RTP Streaming Control drive the SAME engine the classic
>   service uses — a second copy would be two engines to keep in agreement —
>   and its start request carries a TIER IDENTIFIER rather than a whole
>   configuration, because the configuration was agreed when the tiers were
>   published. A tier we never published is `No Such Stream`, never something
>   improvised.
> - **HEVC passthrough exists, and the permission belongs to the SESSION.**
>   §1.7 item 1 and §3.0.6's "587 must transcode because iOS Home renders only
>   H.264" were true only of the CLASSIC SRTP path. `canPassThrough` now asks
>   which service negotiated this session; the same camera serves both. An
>   unknown codec is still refused on both — the permission is for H.265, not
>   for whatever a source turns out to be.
> - **HKSV is no longer only an export.** What HomeKit takes is teed to a copy
>   with its own disk, retention and camera set ([D550](../decisions/adr-0550-a-homekit-clip-is-ours-only-if-we-teed-what-we-sent-and-the-tee-may-never-touch-the-recording.md)),
>   those clips are a source in the clip browser registered by the addon that
>   teed them ([D571](../decisions/adr-0571-the-homekit-clip-source-is-registered-by-the-addon-that-teed-the-clips-so-there-is-no-hand-off-and-its-states-are-the-five-that-already-exist.md),
>   [D572](../decisions/adr-0572-a-clip-subject-carries-the-provider-the-catalog-window-and-nothing-the-operator-drew-and-a-source-that-holds-no-file-says-so-in-the-type.md)),
>   an H.265 camera records by re-encoding only where the operator paid for it
>   (D588), and HomeKit owns whether a camera records — this addon owns only
>   whether it CAN (D589).
> - **Unchanged by all of it:** §4's Matter addon is still not built and still
>   should not be started, and the two `[undetermined]` items above are still
>   open.

## The verdict in five lines

1. HomeKit **pairing, HAP negotiation, SRTP keying and interface selection all
   work.** They have never been the problem.
2. **No live-view session has ever survived past ~31 s.** Six are on record; the
   longest is 31.1 s.
3. **The teardown is iOS-initiated, and that is unusual.** Neither our code nor
   `hap-nodejs` contains any watchdog that could be closing it — proven in §1.3.
4. **There is no "new HomeKit camera API" to invest in.** The delegate API has
   not changed since 2026-03-21. Matter cameras are the real successor, but
   **Apple has shipped no support and announced none at WWDC26.**
5. So the recommendation inverts: **repair, do not migrate** — and the repair is
   far smaller than a year of failed commits implies, because §1.4 names a
   defect nobody has tried yet.

## 1. What actually fails

### 1.1 Layer by layer

The value here is the **negative** results: layers that a year of commits kept
re-litigating are demonstrably fine.

| Layer | Verdict | How it was established |
| --- | --- | --- |
| mDNS + pairing | **works** | A paired controller at `::ffff:<hub-ip>` drives the accessory all day |
| Per-camera standalone accessories | **works, and IS deployed** | The deployed bundle contains `publishStandalone` — see §1.6, a prior note claiming otherwise is stale |
| HAP stream negotiation | **works** | `prepareStream` validates SRTP key/salt lengths and returns; `start` logs `stream started {transcode=false rtspUrl=101/mid audioCodec=opus}` |
| SRTP keying | **works** | No init, encrypt or decrypt failures in any session |
| Return-path interface selection | **works** | The container has exactly one non-internal IPv4 (`<hub-ip>/24`), same subnet as the controller, so `pickLocalInterfaceIp`'s subnet match cannot pick wrong |
| Media production | **runs** | 1000 video + 1500 audio packets forwarded in one 31 s session |
| RTP structural correctness | **correct** | Marker bit set exactly once per frame (185/185); SPS/PPS STAP-A per keyframe, so `-bsf:v dump_extra` works |
| **Video-leg RTCP, outbound** | ~~absent — never sent, once~~ **shipped, and not the fix** | §1.4, §3.0 |
| **Video-leg RTCP, inbound** | **iOS DOES probe us — the "never" was false** | §1.4.1 |
| Source frame rate vs what was promised | **mismatched** | §1.5 |
| **Volume vs the negotiated `max_bit_rate`** | **OVER — 421 kbps against 299, in ~163-packet bursts** | §3.0.3, §3.0.4 |
| iOS render | **fails, always** | §1.2 |
| HomeKit Secure Video | **contract-violating stub** | §1.7 |

### 1.2 The 30-second law

Every `stream started` in the log window, paired to its `ffmpeg exited` by
`sessionId`:

```
08-05 15:35:34  duration=   0.0s  code=255  74a8fad7
08-05 15:35:50  duration=   0.0s  code=255  74a8fad7     <- same session, restarted
08-05 15:35:50  duration=   4.0s  code=255  74a8fad7     <- and again
08-05 15:36:10  duration=  23.6s  code=255  2358288f
08-05 15:36:35  duration=  13.2s  code=255  0c6ec519
08-05 21:31:46  duration=  31.1s  code=255  5c75d293
```

**Nothing has ever sustained.** 31.1 s is the ceiling. This is the steady state,
not an intermittent fault to chase with a packet capture.

**iOS restarts inside a single session.** `74a8fad7` was started three times in
16 s. `handleStreamRequest('start')` kills any existing ffmpeg first, which is
why the first two read `0.0s`. A controller re-issuing `start` immediately is a
controller that is not getting a picture.

`code=255 signal=null` is ffmpeg's exit code after trapping `SIGTERM` — i.e. our
own `killFfmpeg`. The teardown is therefore HAP-initiated. Worth stating because
the log line says `ffmpeg exited abnormally` and invites the opposite reading.

### 1.3 The teardown is iOS's, and that rules out the usual explanation

In the two mainstream open-source HomeKit camera implementations, a ~30 s
teardown is almost always **the accessory's own idle watchdog**, armed at stream
start and reset only by inbound RTCP on the video return port. One logs
`HomeKit Streaming RTCP timed out. Terminating Streaming.` at exactly 30 000 ms;
the other applies a hard 30 000 ms floor to `rtcp_interval * 5`. When people
report "iOS drops my stream at 30 seconds", that is usually what they have found.

**That explanation does not apply here**, and this is checkable rather than
arguable:

- Our delegate has no such watchdog. The only timers in
  `packages/addon-export-hap/src/mappers/builders/camera-streams.ts` are the 1 s
  RTCP gate in `makeRtcpGate` and the 2 s `SIGKILL` fallback in `killFfmpeg`.
- `hap-nodejs` has none either. `RTPStreamManagement.js` in the installed
  2.1.7 contains **zero** occurrences of `setTimeout`, `Timeout` or `timeout`.

So nothing on our side can be closing the session. The `stop` request genuinely
comes from the controller. That is a meaningful narrowing: iOS is receiving our
SRTP and actively rejecting the stream, rather than us shooting it.

> **Still true on 2026-08-06, and now a rule.** R4 adopted the reference's
> Receiver-Report read and deliberately did **not** adopt the idle timeout that
> sits beside it — [D53](../decisions/adr-0053.md). The two measured sessions
> ran 9.8 s and 12.1 s; a 30 s watchdog could not have fired in either, so it
> would only add a way to kill a session. Do not reintroduce one without first
> showing a session it would have saved.

### 1.4 The named defect: the video leg has never sent a single RTCP Sender Report

This is the finding that changes the economics, and it is a one-line grep.

`SessionState` carries `audioOutSrtcp`. **There is no video equivalent.**
`sendAudioRtcpSr` is the only Sender-Report path in the file and it is called
only under `if (kind === 'audio')`. Across the whole session lifetime the video
leg emits RTP and nothing else.

Why that is likely to matter:

- HAP negotiates a **minimum RTCP interval per leg, video included** — it is
  `MIN_RTCP_INTERVAL` in both the video and audio RTP-parameter TLVs, and it
  surfaces on `VideoInfo.rtcp_interval` as well as `AudioInfo.rtcp_interval`. A
  controller does not negotiate a video RTCP interval for a leg it expects
  nothing on.
- Both reference implementations send video-leg SRs. One builds a per-leg sender
  driven by that leg's own `rtcp_interval` and fires an SR on the first packet;
  the other gets them free because ffmpeg's RTP muxer emits an SR on the first
  packet and then at least every 5 s on **every** output, video included.
- Without our SRs, iOS has no NTP↔RTP anchor for video. Its own receiver reports
  carry loss and jitter that are meaningless unless something anchors the clock.

The in-file comments show the audio SR was added precisely because *"iOS Home
will silently mute the speaker if it never receives an RTCP Sender Report"* — the
mechanism was understood, diagnosed and fixed for audio, and simply never
generalised to video.

**This is a hypothesis, not a proof.** `[undetermined]` I did not find a HAP
spec line stating video SRs are mandatory, and no public thread isolates their
absence as *the* cause of a teardown — largely because nobody ships without
them. But it is the only structural difference between this implementation and
every known-good one, it fits an iOS-initiated teardown, and it is cheap to test.

### 1.4.1 FALSIFIED 2026-08-06 — "iOS never probes our return port"

The belief that outlived every fix. It underpinned the interface-selection work,
the symmetric-port work and the 1 s gate, and it is **false for the video leg**.

Two sessions read off the live hub with the telemetry from §3.0.1:

```
videoRtcpReceived=21 / 34    audioRtcpReceived=0
videoGate=packet@577ms       audioGate=timeout@1001ms
```

The video gate opened on a **real controller packet** at 577 ms, not on its 1 s
fallback, and the controller kept sending RTCP for the rest of both sessions.
The return path, the interface pick and the advertised port are all correct.
Only the **audio** leg is never probed — and it is never probed in the sessions
where video is never rendered, so the two are not independent observations.

This is the finding that retired counting. A controller receiving perfect video
and refusing to render it sends the same *number* of RTCP packets as one
receiving garbage; the count cannot separate them, and both remaining families
of cause are consistent with every figure above. **What separates them is inside
those packets** — see §3.0.2, and [D53](../decisions/adr-0053.md).

### 1.5 HomeKit is steered onto a 10 fps stream

Running production's exact ffmpeg argument vector against the same restream on
the hub and parsing the emitted RTP headers:

| Profile | Resolution | RTP ts delta @ 90 kHz | Implied fps | Notes |
| --- | --- | --- | --- | --- |
| high | 3840×2160 | 3600 | **25** | one 2.8 s gap in 17.8 s |
| **mid** | **1280×720** | **9000** | **10** | one 2.6 s gap in 20.9 s |
| low | 640×360 | 3600 | **25** | clean |

The broker's own telemetry agrees independently — `webrtcSession.listStreams`
for device 101 reports `Mid … inputFps=10.11`, `Low … inputFps=25.26`,
`High … inputFps=25`. Two unrelated measurement paths, same answer, so this is
the camera's 720p substream, not an artefact of my extra pull.

The part that is ours: `buildCameraStreamingDelegate` advertises **every**
resolution at 30 fps, and `startFfmpegForSession` resolves `streamPreference:
'auto'` through `pickPreferredRtspEntry` using **iOS's negotiated target
resolution**. A controller asking for 1280×720 is steered onto the `mid` slot by
construction — the one slot that runs at 10 fps with multi-second gaps — while
`SelectedStreamConfiguration` promised 30.

`-c:v copy` means we cannot honour the negotiated frame rate *or* the negotiated
`max_bit_rate` even in principle. This is a known trap: one reference
implementation explicitly zeroes width/height/fps/bitrate whenever the video
codec is `copy`, precisely because it cannot satisfy the request, and users
report streams that never start at all under `copy` because each iOS device asks
for a different resolution.

> **The `max_bit_rate` half of that sentence turned out to be the live defect**,
> and R2 only addressed the frame-rate half. §3.0.3 measures the overshoot;
> [D54](../decisions/adr-0054.md) makes pass-through conditional on fitting.

### 1.6 A stale note, corrected

A prior session's note records the per-camera standalone-accessory refactor as
"committed, NOT deployed, needs a re-pair". **No longer true.** The deployed
bundle contains `publishStandalone` and the live logs show per-camera accessories
with their child services. The re-pair cost has already been paid — nobody should
plan around it.

Separately, the hub runs `addon-export-hap` **1.2.7** against repo 1.2.9, but the
last functional source change was 2026-06-12 and everything after is a lint sweep
and publish bumps. The deployed code is behaviourally current.

### 1.7 HKSV is not just a stub — it violates the delegate contract

> **Resolved 2026-08-06 by withdrawing the service** — [D50](../decisions/adr-0050.md).
> The diagnosis below stands and the stub is deleted. `recording` was withdrawn
> from the `CameraController` at that point; it is passed again since
> [D84](../decisions/adr-0084.md) — see the status banner at the top. What
> follows describes the stub, which is gone, not the delegate that replaced it.
>
> **2026-08-07 — the operator asked why the Home app offers no recording, and
> the question was answered properly.** The blocker is not the delegate: it is
> that no CamStack surface can produce a LIVE fMP4 fragment sequence. The
> recorder writes real fMP4 but is ~13 s behind live and encodes audio as
> `libopus` (HKSV requires AAC); the clip ring returns one base64 blob; and the
> ffmpeg primitive's `FfmpegSink` union has no `mp4` container at all. Full
> assessment, the four-phase plan and the reason nothing was shipped:
> [`2026-08-07-alexa-events-and-hksv-assessment.md`](2026-08-07-alexa-events-and-hksv-assessment.md).

`buildHksvStub` yields zero fragments, which its own docstring admits. The live
consequence, roughly every 60–90 s all day:

```
export-hap: HKSV stream requested — stub returns empty (no clip source yet) {streamId=1}
[HDS ...] Delegate finished streaming for 1 without setting RecordingPacket.isLast.
export-hap: HKSV stream closed {streamId=1 reason=3}
```

That middle line is `hap-nodejs` telling us we broke its contract. A recording
generator that returns **without** setting `isLast` leaves the recording stream
open indefinitely on the controller side; twelve seconds elapse between each
request and its close, so iOS waits out a timeout every time.

`recording` is **optional** in `CameraControllerOptions`. Omitting it removes the
`CameraRecordingManagement` and `CameraOperatingMode` services entirely. That is
the supported way to say "this camera does not record", and it is strictly better
than advertising HKSV and then violating its contract.

`[undetermined]` Whether the broken recording delegate also degrades **live**
view. The two paths are separate services with no coupling in `hap-nodejs`
source, and a maintained third-party plugin documents them as independent — but
advertising HKSV does add the `CameraOperatingMode` service carrying
`HomeKitCameraActive`, which is a plausible coupling nobody has tested. Since
removing the stub is desirable on its own merits, this resolves itself.

### 1.8 A hazard I found and then disproved

Recorded so the next person does not "fix" it as though it were the cause.
ffmpeg's RTP muxer sends its RTCP to `port + 1`. `prepareStream` binds
`videoLoopUdp` and `audioLoopUdp` back-to-back with `bind(0)`. If the OS handed
out consecutive ports, the **video** leg's RTCP would land on the **audio**
loopback socket, be parsed as RTP, re-stamped and forwarded to iOS as an Opus
frame — corrupting the audio clock.

I reproduced the mechanism deliberately by pinning ports 45001/45002. Then I
measured the real allocator inside the container: **8 back-to-back `bind(0)`
calls produced 0 consecutive pairs.** Latent hazard, not the live fault.

### 1.9 Leftovers worth a broom

Residue of the kind `CLAUDE.md` asks to be deleted on sight, all under
`packages/addon-export-hap/src/`. Status as of 2026-08-06:

- ~~Three `process.stderr.write` debug probes in the hot path of
  `camera-streams.ts`~~ — **already gone** when this was re-checked on
  2026-08-06; the entry above was stale by the time it was written.
- ~~A stale docblock on `streamPreference`~~ — **corrected.** It now describes
  the resolution-targeted steering *and* points at the derivation that makes the
  advertisement match it (D51).
- ~~`eslint-disable` directives in `accessory-publisher.ts`~~ for a linter this
  repo replaced with oxlint + Biome on 2026-06-20 — **removed 2026-08-06.** They
  suppressed nothing.
- ~~`as unknown as` casts against the no-casts rule, several of them the same
  `ctx.api as unknown as DeviceManagerApi` shape~~ — the entry above predicted
  "unpicking that boundary is a refactor of the addon's API access". It was not.
  **Removed 2026-08-20**: `AddonApi` already satisfied `DeviceManagerApi`
  structurally, so the cast was an annotation nobody had written, and the two
  `Symbol.iterator as unknown as string` sites were only working around the fact
  that `Record<string, unknown>` does not index with a symbol —
  `Reflect.get(value, Symbol.iterator)` asks the same question honestly. Two
  production casts survive in this addon: `accessory-publisher.ts:108` wraps a
  `hap-nodejs` accessory, and `mappers/child-accessory.ts:105` is still the same
  `ctx.api as unknown as DeviceManagerListChildrenApi` shape — it is pinned debt
  in `scripts/ci-baseline.json` and the fix above is the recipe for it.

## 2. The investment question

### 2.1 CORRECTED 2026-08-06 — there IS a new HomeKit camera API

> **This section was wrong when written, and the error is instructive.** The
> investigation looked for the new API where a Node developer would look — in
> `hap-nodejs` releases, in npm, in the ecosystem packages — found nothing
> moving, and concluded nothing existed. Apple had published the specification
> as a **PDF on developer.apple.com**, two months earlier. No amount of reading
> the library would have surfaced it.
>
> **"HomeKit Secure Video Open Source Compatibility Guide", Developer Preview,
> 2026-06-03.** It complements HAP Specification R17 or later, and its title is
> the point: Apple wrote it *for* open-source implementations like this one.
>
> Two changes matter:
>
> 1. **HEVC is mandatory.** Verbatim: "The accessory must support High
>    Efficiency Video Coding (HEVC)." The Video Codec enumeration is now
>    `1 = H.264 (AVC)`, `2 = H.265 (HEVC)` — note the renumbering, the classic
>    profile's `VideoCodecType.H264` is **0**. Today `camera-streams.ts`
>    transcodes every HEVC source to H.264 (`needsTranscode`); under this spec
>    it can be passed through.
> 2. **Streaming moves to WebRTC.** A new
>    `camera-webrtc-stream-management` service (`00008033-…`) in which the
>    **accessory is the offerer**: the controller writes Solicit Offer, our
>    write-response carries the SDP offer and ICE candidates, the controller
>    writes back Provide Answer. Minimum **six simultaneous sessions**. This
>    maps onto the existing `webrtc-session` cap — which is the same conclusion
>    §2.2 reached for Matter, except this one is HomeKit and it is available now.
>
> Also new: Multi-Tier RTP Stream Management, Camera Motion Zones, Camera
> Buffer Management, Camera Key Management, Client Certificate Management.
> Normative bitrates (§2): 4K@24/30 4500/5000 kbps, 2K 2800/3000, 1080p@30
> 1700/1800, 720p@30 768/800, 360p/240p 180/190. Opus mandatory, 16 kHz capture
> mandatory and 24 kHz recommended, transmission always reported as 48 kHz.
>
> **No fork of `hap-nodejs` is needed.** `Service(displayName, UUID, subtype)`
> and `Characteristic(displayName, UUID, props)` both accept arbitrary UUIDs,
> and the library's TLV8 codec (`encode`, `decodeWithLists`) already implements
> the "Repeated" semantics the spec uses. The preview surface is therefore
> built *on* the library, in `packages/addon-export-hap/src/hksv-preview/`, <!-- drift-ok: the preview surface was DELETED 2026-08-13 (ecosystem export plan, T5) — 803 lines and 44 tests with zero production imports behind a flag that changed nothing. This paragraph records what was true when the diagnosis was written. -->
> behind the `hksvPreview` setting (default OFF — Developer Preview, no
> shipping controller known to negotiate it).
>
> The lesson for the next investigation: **a library that has not moved is not
> evidence that a specification has not moved.** Check the vendor's
> specification downloads, not just the ecosystem's package registry.

What follows was accurate about the LIBRARY, and remains so — it is why the
classic path had nothing to gain from an upgrade.

- `@homebridge/hap-nodejs` latest is **2.1.9** (2026-07-18); we run 2.1.6. The
  intervening releases are dependency bumps, CI, a `Name` characteristic
  validation fix and test-harness work. **No production camera code changed.**
- Per-file: `CameraController.ts` last changed 2026-03-21, `RecordingManagement.ts`
  2026-05-07, `RTPStreamManagement.ts` 2026-04-06 — all already in 2.1.6.
- The `2.2.0-beta` branch is Node 26 support and doc regeneration. No `src/`
  camera changes.
- `CameraStreamingDelegate`, `CameraRecordingDelegate`, `RecordingPacket`,
  `PrepareStreamRequest/Response` are unchanged. **Upgrading buys nothing.**

There is also no library helper that would remove our hand-rolled SRTP. The only
RTP code `hap-nodejs` ships is a legacy proxy whose own docblock says it is
"mostly no longer useful". The ecosystem's `camera-utils` package does **not**
encrypt either — its `srtp.ts` only base64-encodes key+salt so ffmpeg can do the
SRTP. It has had no release since 2024-11-03.

### 2.2 Matter cameras are the real successor — and Apple has not shipped them

This is the genuinely new API, and camstack is unusually well placed for it:

- **Matter 1.5 (2025-11-20)** introduced the camera model: live A/V over
  **WebRTC**, two-way audio, local and remote access via standard STUN/TURN,
  multi-stream, PTZ, detection and privacy zones. **1.5.1 (2026-03-31)** refined
  multi-stream, added HEIC snapshots and HLS/DASH recording. 1.6 is not a camera
  release.
- **matter.js 0.17.3 is already vendored in this repo** and already models the
  Matter 1.5.1 Camera device. Verified by reading the installed package: device
  types `camera`, `floodlight-camera`, `snapshot-camera`, `chime`; the generated
  `CameraDevice` cites `MatterSpecification.v151.Device § 16.1` and composes
  `CameraAvStreamManagement`, `WebRtcTransportProvider`,
  `WebRtcTransportRequestor`, `PushAvStreamTransport`,
  `CameraAvSettingsUserLevelManagement`, `ZoneManagement`, `OccupancySensing`.
- The command set maps almost 1:1 onto a cap camstack already owns
  (`packages/types/src/capabilities/webrtc-session.cap.ts`):

  | Matter command | `webrtc-session` method |
  | --- | --- |
  | `solicitOffer` | `createSession` (server-offer) |
  | `provideOffer` | `handleOffer` (client-offer) |
  | `provideAnswer` | `handleAnswer` |
  | `provideIceCandidates` | `addIceCandidate` / `getIceCandidates` |
  | `endSession` | `closeSession` |

**And none of it is actionable, because the controller does not exist.**

- As of 2026-08-05 there is **no evidence Apple supports Matter cameras in any
  shipping or announced OS.** Coverage of WWDC26 and iOS 27 notes that despite a
  camera-heavy release, Apple made **no** Matter camera announcement; cameras
  remain the notable category still absent from Apple's Matter support. iOS 27
  instead extends **HKSV** to 4K.
- The only shipping Matter camera controller is Samsung SmartThings
  (2025-12-19). The first Matter-certified camera reaches Apple Home through its
  **native HomeKit/HKSV** integration, not through Matter.
- matter.js's camera **server** behaviours are empty generated shells —
  `WebRtcTransportProviderServer` is a 12-line subclass with no command bodies.
  The only real logic is on the **requestor** (controller) side: matter.js can
  *consume* a Matter camera today, not *be* one.

So the migration the brief asked for would mean building a full Matter camera
server, in a repo whose Matter addon is a controller not a device, to be
commissioned by a controller Apple has not shipped. That is the wrong bet this
year.

## 3. Recommendation — repair, do not migrate

The brief's premise was that repairing is not worth it because the API moved on.
**The API did not move on, and the repair is cheaper than it looks**, because the
year of failed commits never tried the one thing every working implementation
does. Three changes, in order of expected value:

**R1 — Send RTCP Sender Reports on the video leg** (§1.4). **SHIPPED, AND IT DID
NOT FIX THE FAILURE — see §3.0.** A `videoOutSrtcp` now sits alongside
`audioOutSrtcp`, `sendAudioRtcpSr` is generalised to `sendRtcpSr(session, kind,
log)`, the forwarder tracks video packet/octet counts and the last video RTP
timestamp, and each leg fires an SR on its own first packet and then at its own
negotiated `rtcp_interval` (`request.video.rtcp_interval`, defaulting to 5 s).
It was the single highest-value change *to try*; it is no longer the leading
hypothesis.

**R2 — Stop steering HomeKit onto the 10 fps slot** (§1.5). **SHIPPED
2026-08-06.** Resolved by advertising honestly rather than by re-steering: each
advertised resolution now carries the real rate of the slot the picker resolves
it to. See [D51](../decisions/adr-0051.md).

**R3 — Remove the HKSV stub** (§1.7). **SHIPPED 2026-08-06.** `recording` is
omitted from the controller options; `CameraRecordingManagement` and
`CameraOperatingMode` are no longer published. See
[D50](../decisions/adr-0050.md). This removes the contract violation and the
all-day log loop. It does **not** answer whether the stub degraded live view —
it removes the possibility rather than testing it.

**R4 — Decode the controller's Receiver Reports** (§3.0.2). **COMMITTED
2026-08-06, not deployed.** Not a repair: an instrument. It is the only thing
that separates the two remaining families of cause, and it exists because
§1.4.1 falsified the assumption the previous rounds were aimed at. See
[D53](../decisions/adr-0053.md).

**R5 — Send a stream that FITS the negotiated rate** (§3.0.3). **COMMITTED
2026-08-06, not deployed.** R4 read, and the answer was `transmit-suspect`: we
were sending 421 kbps against a negotiated 299, in ~163-packet bursts. This is
the first repair aimed at *how much* we send rather than what. See
[D54](../decisions/adr-0054.md).

### 3.0 R1 shipped, ran, and the teardown continued — the record

This is the fact that most needs to survive: **R1 is no longer unverified, and
it is not the fix.**

- R1 landed in, published as `addon-export-hap` **1.2.10**,
  and the addon was restarted at **02:02Z on 2026-08-06**.
- Ten hours later, at **11:52:15.652Z**, a session started on `101/mid`. The SR
  path executed with **zero errors across 6 662 debug lines**.
- ffmpeg exited at **11:52:39.100Z** — `code=255 signal=null`, i.e. ffmpeg
  trapping the `SIGTERM` from our own `killFfmpeg`, which runs **only** on the
  controller's `stop`. Duration ~23.4 s.
- **The pass condition in §3.1 (a single session exceeding 31 s) was not met.**

One sample, so this does not *disprove* §1.4 — it disproves the expectation that
§1.4 alone was sufficient. Do not re-implement R1; do not assume it is broken
either. It is now instrumented instead: `export-hap: first VIDEO RTCP Sender
Report sent` fires once per session per leg and proves the SR left the process,
which is exactly what the original write-up had to assume.

`hksvPreview` was **never deployed** (1.2.11 never shipped), so it played no part
in this failure. It remains additive, under `src/hksv-preview/`, default OFF.

### 3.0.1 The instrumentation that replaced the guessing

Shipped 2026-08-06 alongside R2/R3, because §3.1's own advice was "if sessions
still cap at ~31 s after R1, the next step is instrumentation, not more blind
fixes". All at `info` (Loki carries `info+` only) and tagged `deviceId`.

| Line | Answers |
| --- | --- |
| `export-hap: stream session summary` | **The one to grep.** Duration, who asked for the teardown, ffmpeg's exit, negotiated resolution/fps/bitrate, the slot dialled and the rate we promised for it, packets forwarded per leg, RTCP SRs sent per leg, RTCP/RTP **received** per leg, each leg's gate outcome, `mediaStarved`, every named drop — and, since the R4 round, `videoLossVerdict` / `audioLossVerdict` plus the full `videoReceiverReports` / `audioReceiverReports` roll-ups (§3.0.2) |
| `export-hap: stream negotiated` | The full negotiated parameter set at `start` — width/height/fps/max_bit_rate/mtu, both payload types and SSRCs, both `rtcp_interval`s, audio sample rate and packet time. None of this was recorded before |
| `export-hap: RTCP gate opened on a REAL controller packet` vs `… on the 1s FALLBACK — controller never probed` | Whether `makeRtcpGate` resolved on an actual inbound packet or timed out. These mean opposite things and were previously indistinguishable |
| `export-hap: first inbound RTCP from controller` | Settles §5's open `[undetermined]`: does iOS's RTCP reach our return ports at all. Permanent per-leg counters back it. **Answered: yes, on video** — §1.4.1 |
| `export-hap: FIRST RTCP Receiver Report from controller — iOS is receiving and reporting` | Once per leg per session. That it fires at all is the proof iOS is engaged with the media, not merely with the port |
| `export-hap: controller receiver report` | The same block, throttled to 5 s per leg thereafter, so a session leaves a running record of what iOS thinks without becoming one |
| `export-hap: inbound RTCP could not be read` | `warn`, throttled. A decrypt or parse fault — which must never look like the controller having said nothing |
| `export-hap: first VIDEO RTCP Sender Report sent` | R1 actually executing, per session |
| `export-hap: negotiated fps does NOT match the slot we are about to dial` | The R2 divergence, if it ever recurs |
| `export-hap: stream heartbeat` (5 s) | A live session that stopped producing media, while it is still alive. **Logs only** — it never tears anything down; see §1.3 before adding one that does |
| `export-hap: advertised video profile derived` | What we advertised and whether each rate was `measured`, `published` or `assumed` |

Every early return on the streaming path now books a **named** drop reason
(`upstream-pt-mismatch`, `no-srtp-session`, `upstream-no-talk-session`, …) that
surfaces in the heartbeat and the summary. Previously a session that forwarded
nothing said nothing about why.

### 3.0.2 R4 — read the Receiver Reports, because counting has stopped paying

Committed 2026-08-06, **not deployed**. See [D53](../decisions/adr-0053.md).

§3.0.1 answered "did the controller talk to us". §1.4.1 says yes, on the video
leg, 21–34 times per session. That is where counting runs out: a controller
receiving perfect video and refusing to render it sends the same *number* of
RTCP packets as one receiving garbage.

Inside each Receiver Report, iOS states what it received. Those fields split the
remaining causes into two **disjoint** families:

| Reading | Family | Where to look next |
| --- | --- | --- |
| `videoLossVerdict: transmit-suspect` — the controller reports real loss (worst fraction lost ≥ 5 %) | the packets arrive damaged or unusable | SRTP framing, packetisation, MTU, sequence numbers. Nothing past the wire matters |
| `videoLossVerdict: decode-suspect` — loss ≈ 0 across the session | iOS received it intact and rendered nothing | parameter sets, H.264 profile/level, RTP timestamps, marker/pacing |
| `videoLossVerdict: no-reports` | still unknown | check `videoReceiverReports.unreadable`: > 0 means we could not read what it said (decrypt/parse), 0 means it truly said nothing |

`videoReceiverReports` / `audioReceiverReports` carry the raw numbers behind the
verdict — `reportsParsed`, `blocksParsed`, `unreadable`, last **and** worst
fraction lost, last and max cumulative packets lost, last and max jitter, last
extended highest sequence. Last and worst are kept apart on purpose: a slow
first key frame reliably produces one lossy report, and a summary showing only
the last figure would hide a session that was lossy throughout, or vice versa.

Implementation: `packages/addon-export-hap/src/mappers/builders/rtcp-receiver-report.ts`
(pure parse + immutable tally, unit-tested against hand-built RFC 3550 §6.4
buffers and cross-checked against an independent serialiser),
decrypted through a per-leg inbound SRTCP context in
`packages/addon-export-hap/src/mappers/builders/camera-streams.ts`.

**No idle watchdog was added, deliberately** — see §1.3, and the Consequences of
[D53](../decisions/adr-0053.md). The reference implementation resets a 30 s
session timer on each inbound RTCP and kills the stream when it lapses; the two
sessions measured here ran 9.8 s and 12.1 s, so such a timer could not have
fired in either. It would add a way to kill a session and no diagnostic value.

**R4 cannot be verified from this repo.** It needs a controller: deploy, open
the camera in Home, then read one `export-hap: stream session summary`.

### 3.0.3 R4 ANSWERED — `transmit-suspect`, and what that rules out

The reading, off the live hub minutes after R4 was deployed:

```
durationMs=19270  negotiatedResolution=1280x720  negotiatedFps=30
negotiatedMaxBitrateKbps=299  mtu=1378
selectedProfile=mid  selectedBrokerId=101/mid  transcode=false
videoPacketsForwarded=737  videoRtcpSrSent=32  videoRtcpReceived=62
videoReceiverReports={reportsParsed:62, blocksParsed:62, unreadable:0,
  lastFractionLostPct:0, worstFractionLostPct:51.2,
  lastCumulativePacketsLost:450, maxCumulativePacketsLost:450,
  lastJitter:29156, maxJitter:272324, lastExtendedHighestSequence:1821}
videoLossVerdict=transmit-suspect
```

62 reports, 62 blocks, **zero unreadable** — the measurement is sound, and it is
the controller's own arithmetic, not ours.

**What it establishes.** iOS lost **450 of 737 packets, 61 %**. The packets are
not arriving in a usable state. 737 × 1378 B over 19.27 s ≈ **421 kbps against a
negotiated 299** — with `-c:v copy` we could not have honoured that ceiling even
in principle. `maxJitter` 272324 at the 90 kHz clock is **3.03 seconds**, which
is a *distribution* fault, not a volume one. And `lastFractionLostPct = 0`
against a cumulative 450 says the loss is concentrated at the start and then
stops.

**What it rules out.** The `decode-suspect` family, entirely: parameter sets,
H.264 profile/level, slice structure, RTP timestamps and marker pacing are all
downstream of a packet that arrived, and 61 % of them did not. Nothing past the
wire is worth investigating until this number comes down. It also retires — for
now — the theory that R1's video-leg Sender Reports were necessary-but-
insufficient; 32 SRs went out and the leg still lost 61 %.

**What it does NOT establish.** 421 vs 299 is 1.4×, and a 1.4× overshoot does
not on its own explain 61 % loss on a LAN. The jitter says shape matters too,
and §3.0.4 measured the shape.

### 3.0.4 The overshoot and the burst are the SAME defect

`ffprobe` over 200 consecutive frames of the `101/mid` restream:

| | Count | Mean size | Share of bytes |
| --- | --- | --- | --- |
| Key frames | 5 | **224 287 B** | **98.2 %** |
| P-frames | 195 | 103 B | 1.8 % |

A 224 KB IDR at `mtu = 1378` is **~163 RTP packets emitted back to back inside
one 100 ms frame slot** — an instantaneous rate around 18 Mbps. Five of them per
20 s is 448 kbps, which is the 421 kbps measured on the wire. So this slot is
*almost entirely key frame*: the volume problem and the burst problem are one
phenomenon, and either would have produced the reported loss pattern on its own.

Two consequences worth carrying forward:

- **A rate-capped transcode addresses both.** Re-encoding the same source at
  269 kbps produced an I-frame of **22 328 B** — a 10× smaller burst — because
  the one-second VBV window forces x264 to size the key frame to fit. That is
  why R5 adds no separate pacer.
- **The better fix is camera-side.** A substream that is 98 % key-frame bytes is
  a GOP/bitrate misconfiguration (101's `ext` runs GOP 40 at 10 fps, 2048 kbps
  VBR). Correcting it would let pass-through win and cost the hub nothing.

### 3.0.5 R5 — what shipped

`packages/addon-export-hap/src/mappers/builders/stream-bitrate.ts` (pure) plus
`stream-bitrate-probe.ts` (the cap reads). Per session:

1. Resolve each profile slot's rate. The authority is the camera's **configured**
   encoder bitrate from `streamParams.getStatus`, mapped onto the slot through
   its cam-stream's resolution and frame rate. The broker's measured
   `bitrateKbps` is kept alongside it but may only ever *disprove* a fit — it is
   a lower bound, and live it reported `mid = 9 kbps` for the slot that had just
   sent 421.
2. Copy only a slot whose rate is known to fit the ceiling less 10 % headroom.
   Unknown is not a fit.
3. Otherwise transcode at that budget, with a one-second `-bufsize`, `-r` clamped
   to what the source actually produces — **unless the operator switched
   transcoding off** (`ExportDeviceSettings.allowTranscode`, added 2026-09-13;
   absent means allowed). Then the session is REFUSED at this decision point
   with a named reason rather than re-encoded behind the operator's back, and
   the WARN names the slot and codec that would have had to be re-encoded.
   HomeKit's constraint differs from Alexa's here: HAP has already negotiated a
   resolution and profile with the controller by the time we decide, so the
   refusal ends a session that was already promised — which is the honest
   outcome, since a refusal the operator chose must not look like a fault
   ([D62](../decisions/adr-0062.md)).

New per-session line: `export-hap: stream bitrate fit resolved`, carrying the
decision, its reason, the budget and every candidate's verdict. The summary gains
`fitReason`, `slotPublishedKbps`, `slotMeasuredKbps`, `encodeBudgetKbps`,
`deliveredFps` and `fitNotes`.

Encode cost, measured against the live restreams: **720p@10 ≈ 7.6 % of one core**
(Apple silicon, `ultrafast`), pass-through 0.9 %; **4K→1080p@25 ≈ 77 % of one
core**, decode-dominated. On today's fleet every HomeKit session transcodes,
because both exposed cameras configure every slot at ≥ 1024 kbps against a
negotiated 299. See [D54](../decisions/adr-0054.md).

**R5 cannot be verified from this repo either.** Same pass condition, one
observation: a session summary that no longer reads
`videoLossVerdict=transmit-suspect`.

### 3.0.6 R6 — hardware DECODE on the transcode path

Committed 2026-08-06, not deployed at the time of writing. See
[D66](../decisions/adr-0066.md).

Live view renders now. The remaining complaint is that the ONE camera that must
transcode (587, H.265 — iOS Home renders only H.264 on the SRTP path) takes a
long time to start, and the join burst is not the cause: its prime line reads
`source=keyframe-only packets=1 spanMs=0 withheld=0`. What is left is the
transcode, and `buildVideoEncodeArgs` had **no decoder-side flag at all**. An
independent measurement put a 4K→1080p transcode at **77 % of one core,
dominated by decode**, on a hub already at 70-95 % main-thread.

The backend is read from the decoder addon's own per-node probe
(`decoder.getInfo` → `hwaccel` / `probedBestHwaccel@<node>`, `nodePin`-ed to the
local node) — the same value `AgentLoadService` reads. It is never guessed:
unreadable, unprobed or unrecognised all decode in software with a named reason
on `export-hap: video decode path resolved`. `ctx.kernel.hwaccel.resolve()` is
deliberately NOT a fallback — on an Intel host its `preferred[0]` is `qsv`, and
the decoder's ranking puts `vaapi` first *on this exact hardware* because qsv
children exit `code=171` producing no frames.

If a hardware child dies inside a 4 s init window having forwarded no video and
without a controller stop, the identical vector respawns once without the decode
flags, at `warn` with `tags: { deviceId }`.

**Encode stays on x264.** §3.0.5's `-g` and the `dump_extra` inlining were two of
the four causes fixed tonight, and `h264_qsv`/`h264_vaapi` carry their own rate
control, reject `-profile:v baseline`, and emit parameter sets on their own
schedule. There is no hardware here to prove they still hold.

The ffmpeg argument vector moved out of `camera-streams.ts` into
`stream-ffmpeg-args.ts` for one reason: `-hwaccel` is an **input** option, ffmpeg
accepts it after `-i` without error and then decodes in software anyway, and that
position is now a unit test rather than a hope. `-g` and `-bsf:v dump_extra` are
asserted there too.

**R6 cannot be verified from this repo.** One observation decides it: an H.265
session logging `video decode path resolved — HARDWARE`, and a first picture
sooner than today's.

### 3.0.7 The accessory published two switches nobody could name

Not a streaming defect, and it had been fixed once already — into a different
defect. `ConfiguredName` is not in `Service.Switch`'s required-or-optional list
(five service types carry it, none of them a switch), so hap-nodejs rejected the
characteristic on every accessory build and iOS had nothing to render. The label
now goes on `Name`, and is derived from the device. Six PTZ services shared the
bug unreported. [D65](../decisions/adr-0065.md).

### 3.1 How R1 was to be verified — the pass condition, unchanged

Kept verbatim because the pass condition still stands and §3.0 shows it was not
met. R1 typechecked and the addon's tests passed, but
**the existing suite does not cover the RTCP path at all, so green means
nothing here** — and I deliberately did not add a test that would only appear to.

The reason is a real seam problem rather than laziness: the loopback sockets
ffmpeg writes to are bound with `bind(0)` inside `prepareStream` and their ports
are never exposed, so there is no way to inject a plain RTP packet into the
forward path from outside the module. The options were to add a test-only
accessor to production code, or to spawn a real ffmpeg in the unit suite. The
first is the shortcut-path-that-only-exists-in-tests that `CLAUDE.md` forbids;
the second is not a unit test. So the honest state is: **implemented, reasoned,
unproven.**

Verification is a deploy plus one observation, and it is cheap:

1. `camstack deploy packages/addon-export-hap`, then open the camera in Home.
2. On the hub, watch the controller's video port for inbound RTCP —
   `docker exec CamStack sh -c "tcpdump -n -i any udp and host <controller-ip>"`
   — and confirm SRs now leave on the video leg as well as the audio leg.
3. Re-run the §1.2 session-duration query. The pass condition is a single
   session exceeding 31 s.

Until step 3 shows a session past 31 s, §1.4 remains a hypothesis and this
document's own §5 still applies.

Then re-measure §1.2. If sessions still cap at ~31 s after R1, the next step is
instrumentation, not more blind fixes: log whether `makeRtcpGate` resolved on a
real inbound packet or on its 1 s fallback, and log the negotiated
`width/height/fps/max_bit_rate` at `start` — none of which is recorded today,
which is why a year of work had to guess.

> That is exactly what happened, and the instrumentation is now in — §3.0.1. The
> next session should not repeat the measurement by hand: deploy, open the
> camera in Home, then read one `export-hap: stream session summary`.

**Do not upgrade `hap-nodejs` expecting a camera fix** (§2.1).

Also worth considering, if R1–R3 do not settle it: the whole ecosystem lets
**ffmpeg** emit SRTP directly rather than hand-rolling it in JS, which yields
conformant per-leg Sender Reports for free. The documented tradeoff is that
ffmpeg cannot RTP/RTCP-mux on one port, which makes two-way audio and precise
port control harder — that is exactly why the JS-side sender was written here in
the first place, so this is a real fork in the road rather than an obvious win.

## 4. The Matter plan, shelved with a trigger

Keep this. The analysis in §2.2 is sound and the ingredients are in the repo; it
is the *controller* that is missing. **Trigger: Apple announces or ships Matter
camera support.** Until then, do not start.

When it fires, the shape is a new addon — a Matter **device**, not a controller,
sitting beside the existing exporters and declaring `device-export` so the Export
tab, the expose toggle, the reconcile-on-`DeviceProvisioned` machinery and the
`streamPreference` picker all come free. The `ServerNode` bootstrap can be read
off `packages/addon-matter-broker/src/matter-controller-impl.ts`.
<!-- drift-ok: the export-matter addon is a planned package that does not exist yet -->

Phases: (0) stand up a bare `CameraDevice` endpoint with nothing behind it and
confirm Apple Home commissions it; (1) addon shell via the `add-addon` skill;
(2) live view only — implement `WebRtcTransportProvider`'s five commands over
`webrtc-session`, populate `CameraAvStreamManagement` from
`cameraStreams.getProfileRtspEntries`; (3) the free surface —
`OccupancySensing` from `motion-detection`, snapshot, PTZ, `ZoneManagement` from
`motion-zones`, `Chime`/`FloodlightCamera` from children; (4)
`PushAvStreamTransport` against the recorder's byte-range read path — the piece
HKSV never got, and the reason the Matter path is worth more than a transport
swap, because it is fed by a store camstack already has.

## 5. What is still unknown

- **RESOLVED, NEGATIVELY** — ~~Whether missing video-leg RTCP is *the* cause~~.
  R1 shipped, ran for ten hours and the session still died at ~23 s (§3.0). It
  was not sufficient. One sample; it may still be *necessary*.
- **MOOT** — ~~Whether the HKSV stub degraded live view~~. R3 removed the
  service rather than testing the coupling, so it could not be answered then,
  and D84 has since re-advertised `recording` with a real delegate rather than a
  stub. The question that remains is not about the stub: it is whether a
  recording delegate that *works* costs live view anything, and that is
  measurable on any session summary.
- **NARROWED to the transmit family** — ~~What actually causes the teardown~~.
  R4 answered `videoLossVerdict=transmit-suspect`: 61 % packet loss, reported by
  the controller, zero unreadable reports (§3.0.3). The whole `decode-suspect`
  branch — parameter sets, level, slice structure, timestamps, marker pacing — is
  closed until the loss comes down, because it concerns packets that arrived.
  What remains open is whether **volume + burst shape alone** explain 61 %: R5
  removes both (§3.0.4, §3.0.5) and one live session decides. If the verdict is
  still `transmit-suspect` after R5, the next suspects are SRTP framing and MTU,
  in that order — not anything above the wire.
- `[undetermined]` **Why the AUDIO leg is never probed** while the video leg is
  (`audioRtcpReceived=0`, `audioGate=timeout@1001ms`, in both sessions). It may
  simply be that iOS does not commit to the audio leg until it has rendered
  video, in which case it is a symptom rather than a second fault. Nothing here
  distinguishes those yet.
- `[undetermined]` **Whether the 2.6–2.8 s frame gaps on `mid` and `high` are a
  broker fault or a camera fault.** `low` showed none. Outside HomeKit's scope
  but it affects every consumer, and deserves its own look. §3.0.4 adds a
  candidate: `mid` is 98 % key-frame bytes, so a "gap" may simply be the receiver
  stalling behind a 224 KB IDR burst rather than a missing frame.
- **RESOLVED, POSITIVELY** — ~~Whether iOS's RTCP reaches our video return port
  at all~~. It does: 21 and 34 packets across two sessions, gate opening on a
  real packet at 577 ms (§1.4.1). The belief that it did not was load-bearing
  for a year of fixes.

## References

Load-bearing external sources, for the claims in §2 that cannot be checked from
this repo:

- hap-nodejs releases and per-file history — `https://github.com/homebridge/HAP-NodeJS/releases`
- Matter 1.5 camera introduction (CSA, 2025-11-20) — `https://csa-iot.org/newsroom/matter-1-5-introduces-cameras-closures-and-enhanced-energy-management-capabilities/`
- Matter 1.5.1 (CSA, 2026-03-31) — `https://csa-iot.org/newsroom/matter-1-5-1-enhancing-camera-performance-and-expanding-device-flexibility/`
- Apple absence, post-WWDC26 — `https://homekitnews.com/2026/06/09/apple-intelligence-and-4k-recording-come-to-the-home-app/`
- Apple absence, first Matter camera — `https://appleinsider.com/articles/26/03/17/the-first-matter-camera-has-arrived-but-apple-users-wont-notice`
- matter.js — `https://github.com/project-chip/matter.js`
- HKSV wire-format reference — `https://github.com/Supereg/secure-video-specification`
