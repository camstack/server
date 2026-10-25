---
title: Two consumer surfaces that show nothing — HomeKit Secure Video and the Alexa camera event feed
date: 2026-08-07
status: assessed; Alexa phase 1 SHIPPED, HKSV NOT started (deliberately)
applies-to:
  - packages/addon-export-hap/src/**
  - packages/addon-export-alexa/src/**
---

# The operator's two questions, answered

> "On cameras exposed to HomeKit, the Home app offers no recording activation.
> In the Alexa app, camera events are not visible. Are these features that just
> need enabling, or missing capabilities?"

**Both are missing capabilities. Neither is a toggle.** They are missing to very
different depths, and that difference decides what was built today.

| | HomeKit recording (HKSV) | Alexa camera events |
| --- | --- | --- |
| Why it shows nothing | The accessory does not publish `CameraRecordingManagement` / `CameraOperatingMode` at all | The endpoint does not declare `Alexa.SmartVision.ObjectDetectionSensor` |
| Distance to working | **Large** — a live fMP4 fragment source does not exist anywhere in CamStack | **Medium** — one declaration, one new directive handler, one public image URL |
| Blocked on something outside this repo | No | **Yes** — an operator check on the skill's Permissions page |
| Shipped 2026-08-07 | Nothing. Design only. | The honesty fixes (§B4). The feed itself is phase 2. |

---

# Part A — HomeKit Secure Video

## A1. What the Home app is actually waiting for

The "recording" option appears when the accessory advertises the recording
service set. In `hap-nodejs` 2.1.7 (the pinned version) that is one thing: a
`recording` block on `CameraControllerOptions`.

```ts
new CameraController({
  delegate, streamingOptions, cameraStreamCount: 2,
  recording: { options: CameraRecordingOptions, delegate: CameraRecordingDelegate },
  sensors: { motion: Service | true },
})
```

Supplying it makes `RecordingManagement` construct three services —
`CameraRecordingManagement`, `CameraOperatingMode` and a `DataStreamManagement`
— and that is the whole of the advertisement.

`packages/addon-export-hap/src/mappers/camera-accessory.ts` omits it (the
block above the controller construction), on purpose, with the reason inline. **That omission is correct and must not be
casually reverted** — [D50](../decisions/adr-0050.md). A stub delegate shipped
here before: a `require-yield` generator that returned without ever yielding a
`RecordingPacket`, so `hap-nodejs` logged
`Delegate finished streaming for N without setting RecordingPacket.isLast` and
iOS waited out a ~12 s timeout every 20-60 s, on every camera with motion
detection, all day. **A camera that advertises recording and delivers nothing is
worse than one that advertises nothing**: the operator gets a toggle that turns
on and never produces a clip.

## A2. What is missing, precisely

`hap-nodejs` already owns the parts people assume are the hard ones. The HDS
DataStream transport, the `dataSend` framing, the configuration TLVs, the
`selectedConfiguration` hash and its persistence are all implemented
(`dist/lib/camera/RecordingManagement.js`, `handleDataSendOpen`). **Our side is
only the delegate and its media.** That is still five things:

1. **`CameraRecordingOptions`** — `prebufferLength` (the API documents a 4000 ms
   minimum; nothing asserts it at runtime),
   `mediaContainerConfiguration` (fragmented MP4 + fragment length), a video
   profile ladder and an audio profile. *Derivable today* from the broker's
   slots — `hksv-preview/tiers.ts` already does the equivalent derivation for
   the newer spec, and `stream-bitrate-probe.ts` already reads the per-slot
   configured rate ([D54](../decisions/adr-0054.md)).

2. **A `CameraRecordingDelegate`** — `updateRecordingActive`,
   `updateRecordingConfiguration`, `handleRecordingStreamRequest` (an
   `AsyncGenerator<RecordingPacket>`), `acknowledgeStream`,
   `closeRecordingStream`. *Straightforward once (3) exists.*

3. **A live fMP4 fragment source — THE GAP.** The generator must emit one
   initialisation packet (`ftyp` + `moov`) followed by media fragments
   (`moof` + `mdat`), each starting on a key frame, at roughly the negotiated
   fragment length, beginning ~4 s BEFORE the trigger and continuing until iOS
   closes the stream. **Nothing in CamStack can produce that.** See §A3.

4. **Motion-trigger wiring** — `EventTriggerOption.MOTION` is derived from
   `CameraControllerOptions.sensors.motion`, i.e. the controller must OWN the
   `MotionSensor` service. Today `mappers/builders/motion-sensor.ts` creates and
   owns its own. Handing it over is a **structural** accessory change: it moves
   the service under the controller and adds `StatusActive`, so `c#` bumps and
   every paired controller re-reads the database.

5. **State persistence** — `RecordingManagement.serialize/deserialize` needs the
   accessory's controller state to survive a restart, or iOS re-negotiates the
   configuration on every addon respawn.

## A3. The fragment source, measured against what exists

Three candidates. None of them is it, and the reasons are specific.

### The recorder — right format, ~13 s too late, wrong audio

`packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts` writes genuine fMP4:

```
-f segment -segment_time 10 -segment_format mp4
-segment_format_options movflags=+frag_keyframe+empty_moov+default_base_moof
```

and `recording.readGopBytes({deviceId, profile, startMs, epochMs})` returns
**`ftyp`+`moov` head plus exactly one `moof`+`mdat`** — structurally a
`RecordingPacket` already, proven on the scrub and recorded-playback paths
([D31](../decisions/adr-0031.md)). Two disqualifiers:

- **Only finalized segments are addressable, ~13 s behind live.** HKSV needs the
  four seconds *before* the trigger and then a live tail. A first fragment that
  arrives 13 s after the motion is past the window in which iOS is still asking.
- **Audio is `libopus`.** HKSV requires AAC-LC or AAC-ELD. Recorded segments
  cannot serve HKSV audio at all without a re-encode.

### The clip ring — right timeframe, wrong shape

`streamBroker.renderPreBufferClip({format:'mp4'})` already emits
`frag_keyframe+empty_moov` and covers the pre-trigger seconds
([D32](../decisions/adr-0032.md)). But it returns **one base64 blob over
tRPC**, not a fragment sequence; it is `-an`; it re-encodes with `libx264 -crf
28`; the ring is 25 s and **opportunistic** — a camera nobody is watching
accumulates nothing; and it is armed only for the cheapest assigned profile.

### The egress primitive — right ownership, no MP4 container

`streamBroker.acquireEgressTranscode` is the correct primitive: refcounted,
deduplicated, hwaccel-resolved, one argv builder
([D68](../decisions/adr-0068.md)). Its sink vocabulary
(`packages/types/src/ffmpeg/invocation.ts`, the `FfmpegSink` union) is:

```ts
| { kind: 'rtsp-listen'; url: string }
| { kind: 'stdout'; container: 'h264' | 'hevc' | 'mpegts' }
| { kind: 'rtp-outputs'; ... }
```

**`mp4` is not a member.** And the omission of `outputArgs` from
`EgressEncodeSchema` is deliberate and load-bearing — an opaque array is both
the extensibility mechanism and part of the sharing key, so adding a flag
silently forks the shared child. Extending it is therefore a schema + codegen
change, exactly as the cap's own docblock prescribes.

## A4. Judgement — ship nothing, and do not start a second unwired module

**Nothing was shipped for Part A.** The reasoning, stated so it can be argued
with:

1. **The blocker is not the delegate; it is a media surface that does not
   exist.** A delegate written today would have nothing to yield, which is
   precisely the shape D50 deleted.
2. **The economics are not free and have not been measured.** A permanent
   per-camera prebuffer transcode is the standard way to solve this. On the
   current fleet every HomeKit session already transcodes (D54: cameras
   configure ≥ 1024 kbps against a negotiated 299), a 4K→1080p transcode costs
   ~77 % of one core, and the hub runs at 70-95 % main-thread. **Continuous**
   per-camera encode is a capacity decision, not an implementation detail.
3. **A half-built HKSV cannot be hidden behind a flag.** The only flag that
   matters is whether `recording` is passed to the controller, and passing it is
   the entire user-visible change. There is no "phase 1 behind a disabled flag"
   for an advertisement.
4. **I declined to add a tested-but-unwired fMP4 fragmenter.** It was the
   obvious phase-1 deliverable and it is the wrong one: this addon *already*
   carries `src/hksv-preview/` — 44 tests, nothing wired, for a Developer
   Preview spec no shipping controller negotiates. `CLAUDE.md` names this
   failure directly: *a leftover that describes the right design is worse than
   nothing — it reads as verification.* A second such directory would make the
   addon look two-thirds finished when it is not started. The fragment-splitting
   rules are written down in §A5 instead; they are half a day's work the moment
   they have a caller.

**Answer to the operator: a missing capability, roughly a week of work, and it
should be scheduled deliberately or not at all.**

## A5. The phased plan

Each phase is independently useful and independently verifiable. **Nothing
becomes visible in the Home app until P4.**

**P1 — an fMP4 sink on the ffmpeg primitive. SHIPPED 2026-08-07** (inert — no
caller). `FfmpegSink` gained `{ kind: 'stdout'; container: 'mp4'; fragmentMs }`
emitting `-movflags +frag_keyframe+empty_moov+default_base_moof
-min_frag_duration <us> -f mp4 pipe:1`, and `FfmpegVideoEncodePlan` gained
`forceKeyFramesSeconds` (`-force_key_frames expr:gte(t,n_forced*<sec>)`).

Two things the plan above got wrong, both recorded in
[D80](../decisions/adr-0080.md):
- **`-frag_duration` is the wrong flag** and is now forbidden on this sink. It
  cuts at a wall-clock boundary whether or not a key frame has arrived, so a
  late IDR produces a fragment opening on a delta frame — accepted by the muxer,
  rejected by HKSV, invisible to an argv test. `-min_frag_duration` can only
  DELAY a cut, so the boundary stays a key frame.
- **No cap change and no codegen were needed.** `fragmentMs` did NOT go on
  `EgressTranscodeRequestSchema`: phase 1-4 consumers are in-process and hold a
  live plane object, so the transport is reached through
  `EgressTranscodeManager.acquireFragments` and `egressTransportFromRequest` can
  never name it. That defers the `@camstack/system` train to whenever a consumer
  first needs to run off-node.

The child rides the existing manager machinery unchanged — exact-match sharing
(with the transport AND the fragment length in the key), refcount, release
grace, software retry, liveness removal.

**P2 — the box splitter. SHIPPED 2026-08-07** (inert — no caller).
`Fmp4BoxSplitter` is pure and streaming: 8-byte header, `size == 1` ⇒ 64-bit
`largesize`, `size == 0` ⇒ **refused** (an unbounded box never closes, so no
later fragment could ever be emitted). `ftyp`+`moov` is unit 0, then each
`moof`+`mdat` pair; a fragment is emitted the moment its `mdat` closes, not when
the next `moof` arrives, because the latter costs a whole fragment length of
latency. Memory is bounded to one in-progress unit and faults rather than grows.

**The dual-use seam is `Fmp4FragmentPlane`, not a callback** — roadmap 4b's
requirement made structural. N independent subscriptions over one splitter, the
initialisation segment retained so a subscriber attaching mid-stream can decode
what follows, backpressure through an async generator, `isLast` computed at
delivery, and a subscriber that falls behind **closed** rather than gapped (a
gapped fMP4 is corrupt, not short). Verified against real ffmpeg output as well
as crafted boxes.

Still true, and still the point: **nothing consumes any of this.** Phase 4
supplies the HKSV delegate, roadmap 4b half 2 the clip source.

**P3 — the prebuffer. SHIPPED 2026-08-07** (built, not deployed —
[D84](../decisions/adr-0084.md)). The measurement §A4.2 demanded, on camera 101's
live restream: a permanent fMP4 child costs **0.7 % of one core / 30 MB** on
`-c:v copy` at 720p and **89.9 % / 577 MB** transcoding 4K→1080p. 128×, so the
complete option was taken and the cheap one is unnecessary — but only on the copy
branch, and `pickRecordingSource` refuses any camera that would need an encoder.
The ring lives on `Fmp4FragmentPlane`, bounded by time AND bytes (a 4 s fragment
is 145 KB at 720p and 3.6 MB at 4K), measured on arrival, replayed to a
subscriber that opts in.

The same measurement found a live defect in P1: `-min_frag_duration` at exactly
`fragmentMs` **doubles** every fragment whenever the camera's key-frame grid
equals it. Emitted at 90 % now.

**P4 — the delegate and the advertisement, together. SHIPPED 2026-08-07**
(built, not deployed — [D84](../decisions/adr-0084.md)). `sensors.motion` moves
to the controller, `recording` is passed, and both come from ONE function that
returns them together or returns `null` with a logged reason. The per-camera
`hksvRecording` switch is off by default. `updateRecordingConfiguration` is
persisted by hap-nodejs' own `ControllerStorage`, which `Accessory.publish`
already wires — nothing was added for it.

Verification is one iPhone and it is the operator's: the Home app offers "Stream
and Allow Recording", a motion event produces a clip in the Activity tab, and the
log carries **no** `without setting RecordingPacket.isLast`. The exact checklist
is in the session handover.

**Preconditions to check before P4 is worth doing at all:** HKSV requires an
iCloud+ plan (50 GB = 1 camera, 200 GB = 5, 2 TB+ = unlimited) and a resident
home hub. The operator already sees the option with another product, so this is
presumably satisfied — but confirm it before spending the week.

## A6. Traps carried forward

- **A rebuilt accessory needs the addon restarted** to be picked up. Structure
  changes bump `c#`; value changes do not. Both P4 changes (a moved service, a
  new service set) are structural.
- **The export fingerprint does not rebuild on binding changes** — known, and it
  will bite P4 because `sensors.motion` is derived from a binding.
- **iOS caches aggressively.** A camera that has ever been paired without
  `recording` may need to be removed from the Home and re-added before the
  option appears.
- **`@camstack/types` resolves to its BUILT dist from `addon-pipeline`.** A test
  that builds an argv with `buildFfmpegArgs` and runs it against real ffmpeg
  reads the STALE dist on an unbuilt tree, silently produces the pre-P1 sink
  args, and fails with ffmpeg's `muxer does not support non seekable output` —
  a message that names nothing useful. The splitter spec asserts the movflags
  are present before spawning, with the real cause in the message.

## A7. What P1/P2 changed about phases 3 and 4

Written now, while the shape is fresh. No code.

> **Superseded by the P3/P4 entries above and by [D84](../decisions/adr-0084.md).**
> Two of the assumptions below turned out to be wrong and are recorded here
> rather than deleted: the transport is NOT reachable in-process by phase 4's
> consumer (`addon-export-hap` is its own runner, so the splitter/plane/child
> moved into `@camstack/types`), and the capacity question is settled by
> measurement rather than by choosing the cheap option.

**P3's cheap option is now cheaper than it looks.** `Fmp4FragmentPlane` already
retains the initialisation segment, so "no prebuffer" costs a consumer nothing
structurally: it subscribes, receives `ftyp`+`moov` immediately, and gets
fragments from the moment it attached. The clip simply starts at the trigger.

**The complete option has an obvious shape and one real question.** A rolling
ring of the last N fragments per plane is a few lines — `Fmp4FragmentPlane`
already holds per-subscriber queues, and the ring would sit beside `retainedInit`
and be replayed to a new subscriber before live fragments. The question it does
not answer is the capacity one from §A4.2, which P1 did **not** settle: a
prebuffer means the ffmpeg child runs whether or not anything is watching, and
that is a permanent per-camera transcode. `acquireFragments` refcounts, so today
the child lives exactly as long as a consumer holds it — the prebuffer is
precisely the decision to stop that being true.

**Measure this before choosing, on the real fleet:** one `acquireFragments` at
the HKSV-negotiated parameters on ONE camera, left running, against the hub's
main-thread utilisation. D67 records that a 4K→1080p transcode costs ~77 % of a
core here and the hub sits at 70-95 %. If that holds, a fleet-wide prebuffer is
not affordable and the honest answer is per-camera opt-in with no prebuffer
first.

**P4 needs three things P1/P2 do not provide**, and none of them is media:
1. `CameraRecordingOptions` derived from the broker's slots — the fragment
   length HKSV negotiates becomes `acquireFragments({ fragmentMs })`, and the
   handle's `fragmentLengthEnforced` tells the delegate whether it can promise
   that length or is riding the source GOP.
2. The delegate's `AsyncGenerator<RecordingPacket>` wrapping
   `subscription.packets()` — a near-direct map, including `isLast`. It MUST
   refuse to open an HDS stream when `subscription.delivered === 0`, and it must
   treat `closedReason === 'slow-consumer'` as a truncated clip rather than a
   complete one.
3. The structural accessory change (§A2.4-5) and the advertisement, which are
   the entire user-visible surface and are still gated on all of the above.

---

# Part B — the Alexa camera event feed

## B1. What is advertised today

`buildParentCameraEndpoint` (`packages/addon-export-alexa/src/endpoints/builder.ts`)
declares, for a camera: `Alexa`, `Alexa.CameraStreamController`,
`Alexa.RTCSessionController`, plus `Alexa.MotionSensor` when the camera has the
`motion` cap, `Alexa.BatteryLevelSensor`, the PTZ controllers, and
`Alexa.DoorbellEventSource` on doorbells.

**`Alexa.MotionSensor` is a STATE interface.** It drives routines and the
account-wide Activity list. It has no event history of its own and no media.
There is no per-camera Events box without a second interface.

## B2. The gap, named

`Alexa.SmartVision.ObjectDetectionSensor` is the interface that populates the
per-camera Events box. It is **declared in the code and commented out of the
endpoint** (`builder.ts`, inside `if (input.hasMotion)`), while the gateway
**was posting `ObjectDetection` events to it anyway**.

Measured on the live hub, 2026-08-07, a 692-second window:

```
223 alexa lwa-gateway: smartvision person posted      endpointId=104 status=202
219 alexa lwa-gateway: motion NOT_DETECTED posted     endpointId=104 status=202
218 alexa lwa-gateway: motion DETECTED posted         endpointId=104 status=202
108 … the same three, endpointId=587
  5 … the same three, endpointId=101
```

Every SmartVision post returned **202**. None of them could be delivered: Alexa
keeps its own copy of each endpoint's capability list, the Event Gateway
validates only the envelope, and an event aimed at an interface the endpoint
never declared is accepted and discarded. This is
[D76](../decisions/adr-0076.md) exactly — *an accepted POST and a returned
void are not evidence of delivery* — and it is the whole explanation for "the
log says it posted, the app shows nothing".

## B3. What a working feed needs (and what it does NOT)

From Amazon's own documentation:

- **`Alexa.MediaMetadata` is DEAD.** Amazon deprecated it on **2023-03-15**. The
  hypothesis that clips-in-the-feed should be wired through it, to the NC clip
  ring, is **wrong and must not be built**. Recording that here because it is
  the natural first guess.
- **Images ride on the event itself.** `ObjectDetection` carries optional
  `frameImageUri` (the wide frame) and `croppedImageUri` (the close-up): JPEG or
  PNG, ≥ 360 px on the short side, ~60 KB, URI valid ~10 minutes, fetched by
  Amazon's cloud — so it must be **publicly reachable**, not a hub-local URL.
  `buildSmartVisionObjectDetectionEvent` already accepts both fields and the
  call site passes **neither**.
- **History retrieval is `Alexa.DataController`.** Instance
  `Camera.SmartVisionData`, `targetCapability.name` =
  `Alexa.SmartVision.ObjectDetectionSensor`, `supportedAccess`
  `["BY_TIMESTAMP_RANGE"]`. Amazon: *"When the customer opens the Alexa app to
  review the detection event, Alexa uses the `Alexa.DataController` interface to
  retrieve the event data."* There is no such handler in this addon.
- **A `person`-on-every-motion event is a lie.** The current call site hardcodes
  `imageNetClass: 'person'` on every motion rising edge — including all 223 of
  104's flaps. The pipeline already produces real classifications; the feed
  should carry those.

## B4. What shipped today

Three changes, all inside `addon-export-alexa`, none of them advertising
anything new.

1. **`ObjectDetection` is gated on the declared interface.**
   `LwaEventGateway.postObjectDetection` reads the exported signature and drops
   the event when the endpoint does not declare
   `Alexa.SmartVision.ObjectDetectionSensor`. The drop is logged — first
   occurrence per endpoint, then every hundredth, with the running count — so it
   is neither silent nor a flood. This removes ~1 guaranteed-discarded POST per
   second per flapping camera from a rate-limited gateway, and it stops the log
   asserting a delivery that never happened.

   The doorbell path, fixed earlier the same day, only *warns* in the equivalent
   situation. That asymmetry is intentional: `Alexa.DoorbellEventSource` **is**
   built for a doorbell, so a missing one means stale discovery and posting is a
   bet worth taking. SmartVision is absent by construction, so the bet is a
   certain loss.

2. **A falling-edge hold on motion** (`motion-clear-hold.ts`). The rising edge
   posts immediately; `NOT_DETECTED` is released only after the source has been
   quiet for 5 s — the same `RESET_DEBOUNCE_MS` the HAP motion builder already
   uses. It replaces the old `lastMotionState` map rather than sitting beside
   it. On the measured 104 trace this collapses 218 DETECTED + 219 NOT_DETECTED
   into one DETECTED and one delayed clear.

3. **The parked declaration corrected, and two false comments deleted.** The
   constant declared `retrievable: true` over `objectDetectionClasses`, which
   obliges the endpoint to answer `Alexa/ReportState` with that property —
   `handlers/report-state.ts` never has. An endpoint that under-answers
   ReportState is a plausible cause of the whole-endpoint rejection recorded the
   last time this was enabled. `properties` is now omitted, matching Amazon's
   own example. The docblock claiming *"each entry carries a JPEG / PNG snapshot
   URL"* was never true and is gone.

## B5. Phase 2 — the feed itself

**Operator first, because it may be a hard blocker:** open the skill in the
Amazon Developer Console → Permissions, and confirm whether
`Alexa.SmartVision.ObjectDetectionSensor` / `SnapshotProvider` are available and
enabled. Amazon's public documentation states no approval gate for this
interface, but this repo has a recorded observation of Alexa rejecting the
**entire** endpoint — camera plus every floodlight/siren/PIR child, all
"unavailable" — when it was declared previously. Those two facts disagree, and
§B4.3 offers a candidate explanation (the ReportState obligation) that would
mean it can now be declared safely. **Re-enable on ONE camera first and watch
that camera's children, not the whole fleet.**

Then, in order:

- **P2a — publicly fetchable event images.** Reuse the ingress-token machinery
  the notification path already has; a short-lived signed URL on the public hub
  origin, 10-minute expiry, pointing at the track's existing best crop and its
  frame. This is the piece that makes the feed look like a feed.
- **P2b — real classes.** Drive `imageNetClass` from the pipeline's detection,
  not from the motion edge. `person` and `package` are the only accepted values;
  everything else must be dropped rather than coerced.
- **P2c — `Alexa.DataController` / `Camera.SmartVisionData`.** A directive
  handler answering `BY_TIMESTAMP_RANGE` over the tracks the pipeline already
  stores, plus delete. Without it the app can show new events but not review
  history.
- **P2d — declare the interfaces** and re-push discovery. Only after P2a-P2c:
  the rule that produced §B4.1 is the same one here — do not advertise an
  interface that cannot serve its retrieval calls.

## B6. The 104 flapping — verdict

**Not the export addon.** The gateway's dedupe was transition-only and working
exactly as documented; it was faithfully relaying real alternations. Verified at
the source by polling `motion.getStatus` on 104 directly:

```
17:55:01 detected=True   lastDetectedAt=…095050  autoClearAfterMs=3000
17:55:03 detected=False  lastDetectedAt=…095050
17:55:09 detected=True   lastDetectedAt=…108349
17:55:16 detected=False  lastDetectedAt=…108349
```

The provider re-triggers every ~1.8 s against a 3 s auto-clear, so the device's
own motion state genuinely oscillates. 587 shows the same at about half the
rate; 101 is normal (5 events in 11.5 minutes).

**This is a separate item and it belongs to the motion provider / pipeline, not
here.** The export-side hold (§B4.2) bounds the damage to Amazon's gateway,
which is this addon's own business; it does not fix the camera. Worth noting
that `addon-export-hap` has carried an equivalent 5 s debounce all along, which
is why the same 104 chatter has never been visible in HomeKit — the asymmetry,
not the chatter, is what was new.
