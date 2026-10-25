---
title: Media and detection data planes
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/addon-pipeline/src/pipeline-runner/track-frame-park.ts
  - packages/addon-pipeline/src/pipeline-runner/native-crop-tier.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
  - packages/addon-pipeline/src/stream-broker/battery-wake-on-play.ts
  - packages/addon-pipeline/src/stream-broker/paced-rtp-replay.ts
  - packages/addon-pipeline/src/stream-broker/live-viewers.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/join-burst-bound.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/dead-decode-backends.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/lazy-dial-sources.ts
  - packages/addon-pipeline/src/stream-broker/__tests__/webrtc-join-burst-exemption.spec.ts
covers:
  - packages/addon-pipeline/src/pipeline-runner/**
  - packages/addon-pipeline/src/stream-broker/**
  - packages/types/src/audio/**
  - packages/addon-pipeline/src/detection-pipeline/**
last-verified: 2026-10-08
---

# Media and detection data planes

> The authoritative deep dive is
> [`docs/design/decode-path.md`](../design/decode-path.md) — **required reading**
> before touching `session-decode/**`, `pipeline-runner/**`, the decoder addon
> or the stream broker. Detector default decision:
> [`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).

## The one rule

Frame and pixel payloads never cross a process boundary at frame-rate
([D9](../decisions/adr-0009.md)). This is not a performance guideline; ignoring it
OOM'd hub-main and took down a whole node, because on the UDS plane a child↔child
call transits the hub-main parent router, which buffered every frame.

Permitted shapes for the decode→detect hop:

1. **In-process `frameRef`** — the `detection` co-location group
   (`pipeline-runner` + `detection-pipeline` + `motion-wasm`). The decode
   worker publishes a **process-local** `FrameRef`; the executor resolves
   **content-sized** JPEG views from `LocalFrameRegistry`. This is the
   shipped path, and the only one for a co-located executor (its rollback
   env, `CAMSTACK_DISABLE_LOCAL_FRAME_REF`, was removed on 2026-10-06).
2. **Compressed inline** — binary JPEG / RGB `contain` when the executor
   is not in the same process as the registry. A `frameRef` never crosses
   a node or process boundary.

Cross-process media is an event (telemetry) plus an **on-demand fetch of
compressed media by handle**: `pipelineRunner.getNativeCrop`, routed by
`handle.nodeId`. Detection retention is **on-demand** (pixel-free handle
until a detection; JPEG hydrate on late pull). A frame a TRACK will need
later is not fetched later: it is **parked** on the owning node the instant
the hub judges it the track's best (`pipelineRunner.parkTrackFrame`, one JPEG
under `(deviceId, trackId, kind)`, `session-decode/parked-frame-store.ts`,
bounded per camera and per node) and retrieved by that key
([D422](../decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
A buffered face's source frame (`face-src:` keys, D644, opt-in via
`keepSourceFrames`) is parked the same way but in its OWN partition
(16 MB per node, 4 per camera), so it can never evict a track's keyframe.
The by-handle fetch serves the enrichment horizon only.
`CAMSTACK_CONTINUOUS_RETAIN=1` restores write-on-admit. Post-analysis
resolves media over tRPC ([D18](../decisions/adr-0018.md)). Shared memory
is not a data plane.

**What answers that fetch changed on 2026-08-13, and the rule got stronger.** A
late native crop is normally served from a per-subject **tile** — one padded,
JPEG-encoded native crop cut per surviving detection, in the decode worker that
owns the pixels, at the instant the frame's `FrameResult` arrives — rather than
from a full native raster held on a timer (~60–120 KB against ~24.9 MB at 4K,
and nothing at all on a frame that detected nothing). The frame itself now lives
only from delivery until its result. Below that tier nothing is held: a caller
naming `(deviceId, epochMs)` gets a still **re-decoded from the recording**
(`locateSegment` + `readGopBytes` + one bounded ffmpeg), which is off every
delivery path by construction —
`scripts/check-recorded-still-off-delivery-path.ts` fails the build if the
notification centre or the capture scheduler imports it.

**The tile is per SUBJECT, and until 2026-08-27 that left the FULL-FRAME
consumers with no rung at all.** Containment is strict, so no subject tile can
answer bbox `{0,0,1,1}` — which is what the native `keyFrame`, the detail
plane's `frameJpeg` rung and the display-crop fallback ask for. Measured over
24 h: 23.3% of key-frame captures produced nothing, 95.7% of those because the
worker answered and no longer held the raster (`worker-lease-gone`) at a median
handle age of 367 ms; only 4.3% were an actually recycled handle. A **SCENE
tile** — one JPEG of the whole native frame, cut in the same synchronous read as
the subject tiles, on detection-bearing frames only, under its own
`nativeSceneBudgetMb` (48) so it can never evict a face tile — is what closes
it. The alternative, holding the RASTERS for the same window, is ~498 MB per
camera and ~6 GB at peak: the D9/D18 OOM. Details in
[`decode-path.md`](../design/decode-path.md#the-rungs-that-replaced-the-ttl-2026-08-1314). The wire contract is
unchanged; the source of the pixels is not. Full account in
[`decode-path.md`](../design/decode-path.md#the-rungs-that-replaced-the-ttl-2026-08-1314)
and [`2026-08-13-native-lease-two-tier-redesign.md`](../design/2026-08-13-native-lease-two-tier-redesign.md).

Shared memory is **not** a detection data plane. The legacy shared-poller
path (`useSessionDecode: false`) was **deleted** on 2026-07-16 — the setting
no longer exists in any source file, so session-decode is the only runner
path. There is **no** operator video-selector (`Decoder Backend` / ffmpeg
as a sink picker): runtime decode is always `nodeav`; persisted
`backend@<nodeId>` rows are unread. The broker decodes nothing: its
frame-handle plane (`subscribeFrames` / `pullFrameHandles` /
`unsubscribeFrames`, and the `decodeFps` / `decodedSubscribers` /
`decoderNodeId` stats it fed) had no caller and was removed
([D762](../decisions/adr-0762-the-stream-broker-has-no-frame-plane.md)).
The `decoder` cap decodes nothing either: its session surface (`createSession`,
`pushPacket`, `pullFrames`, `pullHandles`, `getFrame`, `getShmStats`,
`listActiveSessions`, …) lost its only caller with the broker's plane and was
removed, so the cap is `getInfo` + `reprobeHwaccel` — a node's decode-hwaccel
answer, read pinned to that node by the egress transcode, HomeKit and the load
view. `decoder-nodeav` is its only provider; the ffmpeg-subprocess
`decoder-ffmpeg` addon and the `@camstack/shm-ring` package were deleted
([D763](../decisions/adr-0763-the-decoder-cap-is-a-hwaccel-answer-and-shm-ring-and-decoder-ffmpeg-are-deleted.md)).
Neither is a host-external any more.

Hardware-aware object-detection defaults stay **320** (`yolov9m-320` /
`yolov9m-320-int8`). 640 is not the default — see
[`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).
The reference NVR Model Studio catalog is pinned to **resize 320**
([`2026-08-23-model-studio-external-catalog.md`](../design/2026-08-23-model-studio-external-catalog.md)).

## Streaming

`packages/addon-pipeline/src/stream-broker/` does RTSP read, pre-buffer, WebRTC and
RTSP restream.

**On-demand pull lifecycle.** Every PULL source — one where CamStack opens the
connection TO the camera — dials only when at least one consumer is attached. The
set is a single list, `isLazyDialSource` in
`stream-broker/stream-broker/lazy-dial-sources.ts`: `rtsp`, `rtmp`, `rfc4571`,
`flv` (since 2026-08-07) and `http` (since 2026-08-12). HTTP-FLV is the shape of
bug to expect here — the demand check already governed the RECONNECT path, so
only the FIRST dial escaped it, and a sleeping Reolink battery camera (device
640) took roughly 120 pointless ffmpeg dials a day, each failing 1–3 s later and
only THEN logging "no demand, broker suspended". `http` is the same failure class
one door along and it is the more expensive one: `pull-http` (MJPEG — the
terminal addon's glances relay) normalises to `type: 'http'` in
`buildSourceFromCamStream`, so an unwatched one cost a PERMANENT `libx264`
transcode (~12% of a core) rather than an idle socket. Deferring it is also the
cheapest re-dial in the set. A broker whose last consumer leaves **suspends**
after `SUSPEND_GRACE_MS`
(5 s) — it is not deleted; only `StreamBrokerManager.removeBroker` (retract, or the
catalog sweep) drops the record. A **derived** push feeder (`metadata.kind ===
'derived'`) starts the same way: idle until live intent, so the health sweep
reports `suspended` / `resumed` rather than `stale-timeout` on an empty
derived (same discard path as lazy-dial pulls). **A quiet stream is not
an outage on a battery camera** ([D883](../decisions/adr-0883-a-sleeping-battery-camera-is-not-a-stream-outage-and-an-outage-is-one-event-per-device.md)):
the health sweep reads the battery sleep mirror (`stream-health-policy.ts`), so a sleep
emits no `stream.offline` (an info log says why) and a plain wake no `stream.online`; a
demanded wake that delivered nothing (`wake-timeout`), a stream lost while awake
(`connection-error`) and silence past the battery window (`battery-unreachable`) are the
only battery outages. An outage is ONE event per device, not per profile
(`device-stream-outages.ts`). The `sourceProvider` closure re-derives URLs per
dial, which is what makes Reolink rfc4571 republishes work. An owning provider can
force a re-publish via `EventCategory.StreamBrokerOnRequestStreamSourceRefresh`.
**The catalog sweep retracts on two agreeing pulls, never one**
([D689](../decisions/adr-0689-a-stream-leaves-the-broker-when-two-catalog-pulls-agree-and-a-provider-restart-retracts-nothing.md)).
A pull that omits a provider stream only MARKS it; the retract needs a later
successful pull, at least one reconcile interval (30 s) after the mark, to
agree, and a pull that lists it again unmarks it. A failed pull and a pull that
answered nothing (`null`) decide nothing, and so does an answered `[]`:
providers answer it for "not mine" and "don't know yet" alike, so it neither
marks nor clears. A whole camera leaves through `DeviceUnregistered` and the
departed-device sweep (D685). And a
provider whose runner is not on a stream's byte path never retracts from
`removeDevice()` (rtsp, Hikvision): that hook also runs on a runner stop and a
rebuild.

A provider whose stream must be BUILT before it can be dialled (a sleeping
battery camera, a robot behind a cloud relay) lists it with the `lazy:rfc4571:`
sentinel and builds it on that event — the procedure, and the ways it was got
wrong, are in [`device-model.md`](./device-model.md#a-camera-whose-stream-is-built-on-demand-the-lazy-source-and-the-materialize-round-trip).

**A battery camera's brokers are AVAILABLE without being ACTIVE**
([D173](../decisions/adr-0173-a-battery-camera-is-woken-by-demand-only-and-asleep-is-not-gone.md)).
Two halves, and getting either wrong looks like the other:

- The `stream-catalog` cap now carries a `durability: 'restored'` runtime-state
  slice, so a camera's descriptors survive a restart. Before that they lived
  only in RAM: after a restart with the camera asleep the catalog build
  correctly refused to wake it, answered `[]`, the broker had no cam-stream to
  build from, and `handleOffer` answered the play button with a flat `No broker
  for stream` for as long as the camera slept — which on a battery camera is
  most of the day. The camera was fine; the process had forgotten what it
  offers. Only a SUCCESSFUL build writes the slice, so a refusal can never
  demote a good stored copy.
- `WebrtcSessionProvider.ensureBrokerAvailable` → `wakeBatteryDeviceOnPlay`
  (`stream-broker/battery-wake-on-play.ts`) is the wake. When resolution leaves
  no broker AND the device carries `DeviceFeature.BatteryOperated`, it calls
  `battery.wakeForStream`, waits a bounded window for the provider's
  `StreamParamsChanged` nudge, reconciles the catalog whether or not the nudge
  came (a ledger-restored catalog announces nothing), and retries **once**. The
  error it throws names the state — `sleeping`, `waking`, `unreachable` — and
  never `No broker for stream`, because that sentence is false for a healthy
  camera one wake away from streaming. This was the repo's ONLY live
  `wakeForStream` caller after the Alexa handler's dead
  `const hasBatteryCap = false` block was deleted.

The dial is the only thing that touches the camera. The catalog poll, the
occupancy recheck (now gated on a `BatteryOnStatusChanged`-fed mirror in
`pipeline-runner/index.ts`) and every settings read are served from restored
state.

**The join burst is PACED on both paths; only the RTSP restream is BOUNDED**
([D57](../decisions/adr-0057.md), [D58](../decisions/adr-0058.md)). A consumer
joining mid-GOP is replayed the broker's retained GOP so it renders without waiting
for the camera's next IDR. That replay goes through the one shared
`stream-broker/paced-rtp-replay.ts` — WebRTC and the RTSP restreamer both. The
`PrimeBurstBound` that withholds an over-wide burst applies to the RTSP restream
alone: **WebRTC always takes the last GOP**, because it terminates the media itself
rather than re-clocking it onward, and pacing is the whole of its protection. Both
paths read one shared surface, `StreamBroker.getRtpPreBuffer()`, and the bound sits
strictly BELOW that fork — bounding the ring instead of the consumer silently
starves WebRTC, which
`stream-broker/__tests__/webrtc-join-burst-exemption.spec.ts` exists to catch.
Four things follow, and each cost real time to learn:

- **The burst's span is what the far end measures as jitter.** A consumer that
  re-emits on a real-time clock (the HomeKit leg is an ffmpeg copy of the
  non-muted restream URL) forwards the compression to its own peer: a 2 996 ms
  burst produced exactly 3 030 ms of reported jitter on iOS. Spreading the bytes
  over time does not shrink the span — only the bound does.
- **Over the bound the burst is withheld, not trimmed.** A window cut from the
  ring's tail no longer starts at a keyframe, so it cannot be decoded. The
  session stays pending and joins at the next live keyframe AU.
- **Live packets arriving during a replay are appended to its tail**, never sent
  ahead of it. This was implicit while the burst was synchronous.
- **The bound is per camera stream, not a constant.** Because the ring holds
  `[last keyframe AU .. now]`, a burst's span at join time is the elapsed time
  since the camera's last IDR — so the fraction of joins a fixed bound withholds
  is `1 - bound/idrInterval`, a property of the CAMERA. The cluster default lives
  in the stream-broker addon's global settings (never `perNode` — ingest is a
  movable role) and a camera stream may override it. See
  `stream-broker/rtsp/join-burst-bound.ts`.

**A long-lived ring owns the backing store of every entry, and its budget
charges what an entry pins.** Node serves `Buffer.from` / `allocUnsafe` /
`concat` under 4 KiB as views of shared 8 KiB pool slabs — right for the
ingest path, where a packet is fanned out and forgotten within a tick, and
wrong for anything RETAINED: a 600-byte sub-stream NAL kept 60 s in a clip
ring, or a 1.3 KB RTP packet kept since the last keyframe in the pre-buffer
ring, pinned its whole slab and every short-lived packet beside it. On the hub
that was 550–980 MB of ArrayBuffers for ~150–250 MB of payload and a full GC
every 0.2–0.5 s, and neither `CLIP_RING_MAX_BYTES` nor `RTP_RING_MAX_BYTES`
could see it because both counted payload bytes. `stream-broker/stream-broker/owned-buffer.ts`
is the one place this is decided: `detachFromPool` (as-is when the buffer
already owns its ArrayBuffer, else one copy into `allocUnsafeSlow`) at
`EncodedRingBuffer.push` and in `captureRtpForPreBuffer`, and
`backingStoreBytes` in both budgets. Measured on the real ring code with the
hub's packet mix, 111 MB of payload cost 285 MB of ArrayBuffers before and
112 MB after. A new ring that keeps a buffer past the tick it arrived in goes
through the same helper; the asks and ring lengths are not the lever.

**A source packet is copied ONCE, and the copy is owned.** Since 2026-10-15 the
native readers (`rtsp-client.ts`, `rfc4571-reader.ts`) cut every packet out of
their socket buffer with `copyOwned` (`owned-buffer.ts`) instead of a pooled
`Buffer.from(subarray)`: the ring retains every video packet anyway, so the
pooled cut was copied a second time to own it — 15.1 + 14.8 MB/s on the hub's
load, two copies of every packet. Now `detachFromPool` is an identity for
them, and one allocation is shared by the fan-out, the ring, every session's
write queue and the restreamer's **keyframe cache**, which keeps a REFERENCE
(`detachFromPool(rtpData)`) where it used to `Buffer.from` every packet of
every keyframe AU and hold the copies for a GOP (`restream-keyframe-cache-no-copy.spec.ts`).
The cache stays: it is what primes a joiner when the ring is cold.

**The copy lands in a recycled slab, not a fresh allocation (D868).** One
allocation per packet was itself the cost: 12.2k mallocs/s of ~1.2 KB, 14.6 MB/s
of external memory, so V8 ran a mark-compact every ~4 s and the glibc arena
fragmented. Each broker now owns a `PacketSlabPool`
(`stream-broker/stream-broker/slab-pool.ts`): the readers cut packets into a
64 KiB slab (`packetAllocator`), and a slab is recycled once the structures that
RETAIN packets have let go of it — the source-RTP ring and the restreamer's
keyframe cache `holdPacket` / `releasePacket`, a WebRTC session holds the last
4096 packets it forwarded (`HeldPacketWindow`, werift's NACK history depth).
After 2 s with no hold the slab's memory moves to a fresh ArrayBuffer
(`transfer()`) and the old one is detached, so a view kept too long reads empty
instead of aliasing a newer packet. A consumer that keeps a packet past the tick
it arrived in (a new queue, a snapshot it replays later) takes a hold; caps keep
charging payload bytes and `BackingTally` the distinct slabs. The WebRTC send
path builds each outgoing packet once: werift's SRTP ciphers write header +
ciphertext + tag into one slice of an arena (`patches/werift+0.22.9.patch`) and
`H264Repacketizer` writes each fragment into an `OutputArena` slice; those
arenas are never reused, so they need no protocol. `[broker-mem]` reports
`slabs=<in service>/<free>` and `slabAllocs=<new ArrayBuffers since the last
line>`; a warm stream allocates none.

**The Annex-B plane is built only while something consumes it.** Every source
RTP packet is CLASSIFIED — what it carries, read from its payload headers by
`classifyRtpPacket` (pure, no allocation) — and that verdict is what the ring's
keyframe marks, the restreamer's AU flags and the input stats run on. NALs are
reassembled (`RtpDepacketizer.processPacket`) and pictures assembled only while
an encoded subscriber, a pipe client, a clip ring or an Annex-B-mode
restreamer exists (`StreamBroker.needsAnnexBPlane`). On the hub most brokers
have none — the RTSP restream (detection dials, the recorder, egress legs) and
the WebRTC RTP path are served from the source RTP — and the NAL copy plus the
AU concat were the two largest allocation sites of a process at 166–232 major
GCs a minute (7.8 + 7.0 + 2.0 MB/s of 50.2). The plane ARMS at the next
keyframe access unit after a consumer attaches, so the first `EncodedPacket` it
emits decodes, and IDLES (depacketizer and assembler reset, one log line each
way, `tags.deviceId`) when the last one leaves. Two things had to move with it:
the input stats (`inputFps`, `idrIntervalMs`, `packetCount`, bytes) are fed
from the RTP side while the native reader is up (`RtpPacketAuFlags.pictureStart`,
once per picture) and from `EncodedPacket`s otherwise — a camera nobody watches
through Annex-B must not read 0 fps — and the ring reads per-PACKET flags
(every fragment of an IDR carries them; it already marked one keyframe AU for
the lot) and trims once per keyframe mark. The push-rtp path classifies with
the same function; its flag-only depacketizer is gone.
`annexb-plane-lazy.spec.ts` drives it end to end over RFC 4571.

**An RTSP session corks once per ACCESS UNIT.** `RtspSession.writeInterleaved`
corked around every header + payload pair — one `writev` per packet per
session. It now corks on the first write of a picture and uncorks on the packet
that ends it (the RTP marker; every audio packet), with a `process.nextTick`
safety net so a marker-less camera degrades to one `writev` per tick and a
socket is never held corked across I/O. Backpressure sees through the cork:
`writableLength` counts corked bytes, so the `MAX_WRITE_BUFFER` gate, the
latch and the missed-keyframe close (D447) are unchanged
(`rtsp-session-cork-per-access-unit.spec.ts`).

**The broker's heap is SHAPED, not only ceilinged.** The `stream-broker`
manifest declares `semiSpaceMb: 8` and `initialOldSpaceMb: 512`; why, what the
kernel does with them and how a grouped runner combines them is in
[`addon-lifecycle.md`](./addon-lifecycle.md#a-runners-v8-heap-is-shaped-by-the-manifests-it-hosts),
and `npm run bench:stream-broker-gc` is the opt-in regression bench that
spawns the real broker under the flags `runnerHeapFlags` computes. The
measurements of everything in this block, on a reproduction of the hub's load
(47 brokers, ~115 Mbps, 38 RTSP clients), are in
`sessions.md` (planning repo: sessions/sessions.md) under 2026-10-15.

**The broker's `EncodedPacket` is one ACCESS UNIT — one picture — never one
NAL.** `stream-broker/stream-broker/access-unit-assembler.ts` groups the
depacketizer's NALs by RTP timestamp and marker bit (the marker flushes on the
spot, so a single-slice stream pays no latency; a timestamp change closes the
picture of a marker-less camera; a redial flushes the last one), welds the
parameter sets onto the keyframe picture they precede, and keeps a prefix SEI
inside its picture. Every consumer judges the packet as a picture: `keyframe`
is where a clip ring widens to and where a pre-roll window may start, the
stats count pictures per second and time the GOP from one keyframe picture to
the next, and the WebRTC delivery meter sizes its window on that GOP. Before
this, a 3-slice camera read 75 fps at 25, an 8–34 ms "IDR interval", a clip
widened to the last IRAP slice (a third of the picture, no parameter sets),
and a prefix SEI inherited the welded VPS/SPS/PPS. The source-RTP plane has
the same rule under a different name: `rtsp/rtp-access-unit-tracker.ts`
classifies each packet by what it CARRIES (`RtpPacketClass`, read from the
FU/AP headers, not from the NAL that completed) and carries the keyframe
verdict across the whole picture, so the restreamer's keyframe cache holds
every fragment of a fragmented IDR and a backlogged RTSP client misses
`MAX_MISSED_KEYFRAMES` PICTURES, not IRAP packets. `captureRtpForPreBuffer`
was already AU-aware (one mark per AU) and is unchanged.

**A consumer that needs an encoded stream ACQUIRES one; it does not keep a stream
of its own** ([D67](../decisions/adr-0067.md), [D69](../decisions/adr-0069.md)).
`streamBroker.acquireEgressTranscode` is THE ffmpeg primitive: a structured
encode plan in, a dialable RTSP url plus a refcounted `pipelineKey` out, with
the argv from the one builder in `@camstack/types` and decode hardware from the
decoder addon's per-node probe. Four properties, each of which is the fix for
something that happened:

- **Exact-match sharing, never fuzzy.** Identical arguments reach one child;
  different arguments reach different children, which is accepted. Merging
  nearly-identical requests would make the stream you receive a function of who
  else is watching and in what order they arrived.
- **The handle is IMMUTABLE.** There is no `reconfigure` — a consumer whose
  requirements change releases and re-acquires. A mutable shared handle is what
  made Alexa's old `derived:alexa-<id>` a co-tenant hazard: it was a *publicly
  selectable* camStream, so a browser viewer could attach and one consumer's
  downgrade dragged them all to 360p.
- **Three transports, and the transport is part of the sharing key.** `dial` is
  an elementary Annex-B bytestream into a restreamer the consumer dials, with
  audio on a separate RTP sidecar; `push` is MPEG-TS demuxed straight into a
  locally published cam stream, audio in-band as AAC; `fragments`
  ([D80](../decisions/adr-0080.md)) is a fragmented MP4 cut into an
  initialisation segment plus `moof`+`mdat` units on a subscribable in-process
  plane, audio in-band as AAC because HKSV accepts nothing else. Same encode
  parameters down different transports are different children — excluded from
  the key, whoever acquired first would decide the transport for every later
  sharer. `fragments` is reachable only through `acquireFragments`, never from
  the cap request: its consumers hold a live object, not a url.
- **A holder that dies without releasing leaks a child** until the broker
  process restarts. There is no lease TTL, on purpose: a TTL a live consumer
  fails to renew kills a working stream, and there is no renew method. Every
  holder is expected to release on its own failure paths.
- **A COLD acquire is on the client's critical path, so it is pipelined and it
  does not re-pay a dead backend.** Two defects composed into a re-offer loop on
  101: a browser watchdog re-offers every ~5 s, the leg only acquired after the
  DTLS wait, and the child then spent ~3 s dying on `-hwaccel vaapi` before its
  software retry — attach at +3-5 s, viewer already gone, next session cold
  again. Both halves are fixed and each is a rule:
  - **The acquire starts at the ANSWER**, in parallel with ICE and DTLS
    (`AdaptiveSession.prewarmTranscodeEgress`), because `needsTranscode` is
    final as of the `Codec negotiated` line. Only the acquire moves — the
    ATTACH stays behind DTLS, since `sendRtp` drops before the transport
    connects. Ownership of an unclaimed prewarm is a synchronous
    read-and-null-out, so exactly one of the feed and the teardown releases it;
    the primitive has no TTL and the widened window is precisely when a viewer
    gives up. A prewarm that lost a race with the source dial is retried at feed
    start, never turned into a closed session.
  - **A decode backend that fails in the broker RUNNER is quarantined
    process-wide**, not memoised for a minute — see
    [Decode](#decode) for the numbers and the escalation.
- **A stream this broker minted is `brokerOwned`, and the catalog sweep skips
  it.** `reconcileDeviceCatalog` retracts anything registered here and absent
  from two of the provider's `stream-catalog` pulls — and a provider catalog can never
  contain a broker-owned synthetic, so its absence is that stream's PERMANENT
  state, not a removal. Both publishers have now been swept out from under a
  live consumer: the 618 `derived:sub-cropped` bug, and every Alexa egress on
  587, 13 s in, refcount still 2 and ffmpeg still encoding into a sink whose
  broker was gone. The flag is internal — not in the cap-wire schema, so a cap
  caller cannot make its own publication un-sweepable.
- **A PUBLISHED stream is always reattachable.** The push sink resolves its
  broker per packet because the broker is created on demand — which was only
  ever true for the FIRST consumer, since `retractCameraStream` deletes the
  record `ensureBroker` needs. `ensureBrokerForWebrtcSession` now recreates the
  broker of a stream still published here, so an attach never fails with "No
  broker for stream" against a live egress. `derived:*` stays excluded:
  recreating one there yields a push broker with no feeder ("push source
  stalled"). A recreated broker is RE-PRIMED with the audio declaration the
  demuxer makes once at the child's start, and the sink's RESOLVED/DROPPED pair
  re-arms per generation — a recovery nothing announces reads exactly like the
  outage continuing.

**A DERIVED stream's audio is decided by its carrier, and an uncopyable track is
re-encoded — never dropped** ([D155](../decisions/adr-0155.md)). A derived stream
is an MPEG-TS on stdout, so `-an` (`audio: 'passthrough'`, correct for WebRTC)
loses the track; that was fixed in July and the track stayed missing anyway,
because `-c:a copy` clears the MUXER and not the DEMUXER. ffmpeg accepts a
`pcm_mulaw` copy into `-f mpegts`, warns, and writes stream_type `0x06` —
`MpegTsDemux` adopts an audio PID only for `0x0f` (AAC) or `0x03`/`0x04` (MP2),
so the broker is never told it has audio and its probe reads `audio: null`
forever, exactly like a camera with no microphone. The whole fleet speaks G.711,
so **no `derived:*` stream had EVER carried audio**; it surfaced only when camera
618's motion/audio profile was pointed at one. `resolveDerivedAudio` now copies
only an already-AAC source and re-encodes everything else (including an
unobservable codec — the unknown must not resolve to the branch that mutes the
camera) to mono AAC, reported once per feeder spawn with `tags: { deviceId }`.

**The decoded audio-chunk plane carries the SOURCE rate, and the one consumer
that needs more resamples next to itself**
([D450](../decisions/adr-0450-the-audio-plane-carries-the-source-rate-and-the-one-consumer-that-needs-more-resamples-next-to-itself.md)).
`subscribeAudioChunks` / `pullAudioChunks` is the poll-based plane the
ANALYZER drains per camera (the orchestrator did until D461, below) and
windows to ~1 s; it is the only consumer of `AudioRtpDecoder`'s output (the
WebRTC PCMU egress forwards the G.711 RTP payload, the Opus egress decodes
μ-law on its own). Until 2026-09-11 the decoder upsampled the fleet's G.711 to
16 kHz f32le at the source — 8× the source bytes — and the plane crosses
hub-main four times, so 22 cameras cost ~85 MB/min per leg. Now a native
G.711 camera's chunks are 8 kHz (`sampleRate` on every chunk is the
contract), the classifier's `resampleMono16k` brings a window to 16 kHz next
to the model, and the level is metered on the source samples. The codec
session (AAC/Opus) still targets 16 kHz because its PCM also feeds the live
Opus egress.

**And it carries the SOURCE BYTES, to whoever declared it can read them**
([D455](../decisions/adr-0455-the-audio-plane-carries-the-source-bytes-and-only-to-a-consumer-that-declared-it-reads-them.md)).
D450 left one expansion standing in front of the transport: each G.711 byte
still became a 4-byte f32le sample in `AudioRtpDecoder`, so every leg carried
four times the source — 37 KB per one-second window, 49 MB/min on the analyzer
leg alone. `AudioRtpDecoder` now buffers the CODED payload
(`format: 'pcmu' | 'pcma'`, one byte per sample) and the consumer expands.
`format` is optional on the wire and **absent means `f32le`**; a coded window
reaches only a subscription whose `accept` named that format
(`AudioSubscribeOptions.accept`, the D448 negotiation shape), so a consumer
from an older bundle is served exactly what it always was — `AudioChunkPlane`
expands for it, once per fanout, shared by every subscriber that needs it.
`expandAudioChunkToF32le` in `@camstack/types` is the ONE place a coded window
becomes floats; both addons bundle the bare entry, so the lever ships with
`camstack deploy`. `AudioWindowAccumulator` declares `accept: ['pcmu','pcma']`
and expands at FLUSH, so the analyzer cap's `AudioChunkInput` is unchanged and
stays f32le — which is what makes this safe while the analyzer runs on three
nodes. Measured: the expansion costs 11.6 µs per one-second window per camera
and is MOVED, not added (the decoder paid 12.3 µs for the same work) —
`scripts/bench-audio-g711-expand.mts`.

**The ANALYZER pulls, and the orchestrator keeps only the policy**
([D461](../decisions/adr-0461-the-analyzer-pulls-its-own-audio-and-the-broker-reaps-a-queue-nobody-drains.md)).
Until 2026-09-11 the plane crossed hub-main FOUR times because
`pipeline-orchestrator` drained it, windowed it and pushed it back out —
a process that neither produced nor consumed the audio. D455 could therefore
only reach the two legs BEFORE the relay: the accumulator, the one consumer
that could declare `accept`, had to expand before forwarding, so legs three and
four stayed on f32le at ~49 MB/min each. Poller, accumulator and the result
event now live in `audio-analyzer`, which opens its own `subscribeAudioChunks`
under an `audioAnalyzer.attachDevice` / `detachDevice` pair pinned to the
analyzer node; the subscriber IS the decoder, so both surviving legs stay
coded and the negotiation needs no third party. Composed with D455 the plane
goes from ~196 MB/min to ~25. The orchestrator still owns every question about
WHETHER and WHERE — the binding gate, `audioMode`, the on-motion window, the
audio-track probe, the node assignment, the settings read — and the watchdog's
`audio` stage is fed from `PipelineAudioInferenceResult` rather than from a
chunk it no longer sees. The poll RATE is now a property of the boundary it
crosses (200 ms same-node, 500 ms across the mesh, both named on the `audio
attached` line), because the loop moved to the consumer's side.

**A queue nobody drains is reclaimed by the broker, not trusted to its owner**
(D461). `AudioChunkPlane.subscriberCount` is what `hasDemand()` reads, so an
abandoned subscription does not merely leak a FIFO — it pins the source dial
and the decode session open for the broker's whole life. Now that the
subscriber is a process the orchestrator does not supervise, a subscription not
pulled for `AUDIO_SUBSCRIPTION_IDLE_MS` (120 s) is released and NAMED
(`audio-chunk subscription REAPED — nobody drained it`) and demand is
re-evaluated. The sweep rides `fanout` on a quarter-lease cadence: the plane
has no clock, and a dead consumer costs something exactly when there is a chunk
to queue for it.

A window whose next chunk carries a different `sampleRate`, `channels` **or
`format`** is DROPPED and named (`audio stream format changed — partial
window dropped`, `droppedMs`); the first format of every subscription is a
line (`audio stream delivering`, now carrying `format`), the plane says what
each subscription is being served and whether it forced an expansion
(`audio-chunk subscription serving`, `expanded`), the analyzer says what it
received and whether it resamples (`audio window format`), and the broker's
`native: audio decoder initialized` carries `planeSampleRate` +
`planeFormat` — the audio decision of a relay is never silent (D427).

**The plane's AMPLITUDE is ITU-T G.711, and the day it became so is named**
([D459](../decisions/adr-0459-one-g711-one-amplitude-and-the-instant-it-changed-is-named.md)).
Until 2026-09-11 the same decoder's tables produced μ-law at exactly 1/4 of the
standard's value (−12.04 dB) and A-law at exactly −1/8 (−18.06 dB, sign
inverted), while `g711-mulaw.ts` — the Opus egress, *what the operator hears* —
decoded the identical bytes correctly. So the audio you heard was right and the
audio the classifier and the dBFS meter measured was 4–8× quieter, on every
native G.711 camera. AAC/Opus sources went through the `audio-codec` cap and
were never affected. `AUDIO_SCALE_EPOCH_MS` and `G711_SCALE_CORRECTION_DB`
(`packages/types/src/audio/audio-scale-epoch.ts`) are the one place the instant
and the two per-law factors live; **they are there to EXPLAIN a step, never to
apply a gain** — nothing rescales a sample and no stored history was rewritten,
because the chunk never carried the codec and a row therefore cannot say which
of the three corrections is its own.

**The re-calibration half is
[D460](../decisions/adr-0460-a-dbfs-constant-says-which-meter-it-was-read-off.md),
and it turns on provenance rather than on which population is bigger.** The
codec census (19 PCMU, 5 AAC, 1 L16, **0 PCMA** — so one live factor, +12.04 dB)
came from `audio: track detected {codec=…}`, a log line that had been there all
along. After the epoch there is only ONE population, so a shared constant no
longer serves two scales; what is left is a question about where each number
came from. A constant that STATES a property of the scale (`-55 dBFS is near
silence`) was correct before and after and is not shifted — the 6 always-correct
cameras are the standing proof — while a constant MEASURED through the old
decoder is restated with `ituDbfsFromPreEpoch`. Exactly one qualifies:
`NC_AUDIO_DB_OFFERED`, −55 → −43. Every dB constant now declares its era
(`@dbfs-era`, enforced by `scripts/check-dbfs-era.ts`).

Still outstanding, and deliberately: the values an OPERATOR authored
(`NcAudioCondition.dbThreshold`, `RecordingTriggers.audioThresholdDbfs`,
per-device `audioMarkerMinDbfs`, the viewer's per-grid `audioDb`) are declared,
not migrated — a rule has no single camera, a migration cannot read a log line,
and +12.04 dB is a hypothesis about what the operator meant. `native: audio
decoder initialized` (now `tags: { deviceId }` + `preD459LevelDeficitDb`) is the
line that says which law a camera speaks, per camera. `classificationMinScore` /
`minConfidence` are NOT re-scalable in any direction and must be measured.

`getStreamWithCodec` is the older, `EncodeProfile`-free sibling and is unchanged;
prefer the primitive for a NEW consumer, because its request has no raw-flag
escape hatch and therefore no way to silently fork the shared child.

Placement is a CALLER-side `nodePin`. `stream-broker` is `placement: "any-node"`
and `classifyCapRoute` serves an unpinned call hub-in-process, so today every
transcode lands on the hub — what still has to be true before one genuinely runs
elsewhere is in D68.

## Clip playback: two paths behind one pointer

A vendor clip (`videoclips`, D549) is another POSITION of the recorded source
pointer — same WebRTC track, same control protocol, file-relative axis
([D575](../decisions/adr-0575-a-clip-is-another-position-of-the-recorded-source-pointer-behind-a-file-backed-feeder-and-a-file-that-cannot-be-indexed-is-refused-by-name.md)).
Since
[D597](../decisions/adr-0597-a-clip-plays-from-a-stream-forward-only-and-the-broker-dials-the-providers-listener-because-the-framework-has-no-addon-to-addon-byte-transport.md)
it has two feeders behind `playClip`, and `recorded/clip-path-choice.ts`
decides which ONCE, logged with its reason:

- **STREAM** (every profile since D599, whenever the broker has a dial): the
  provider's forward-only fMP4 (`/clip-stream/…`, written from the first muxed
  byte) is dialled on a one-shot loopback URL from `videoclips.dialClipStream`,
  demuxed incrementally (`recorded/fmp4-stream-demux.ts`) and PUSHED by
  `recorded/clip-stream-feeder.ts`. First frame at the first fragment
  (183–284 ms measured, flat across clip length); a seek behind the head is
  refused by name; duration is `null` until the stream ends.

  **Sound rides the same stream**
  ([D600](../decisions/adr-0600-a-clip-stream-carries-sound-transcoded-by-the-provider-and-the-broker-only-frames-and-paces-it.md)).
  The camera stores AAC and no WebRTC session speaks it, so the PROVIDER
  transcodes — the one ffmpeg it already runs gains `-f aac -i pipe:3` and
  encodes to the codec the broker named on the dial (`audio`), answering
  `servedAudio` beside `served`. `opus` rides in MP4; `pcmu` rides in **MOV**,
  because ffmpeg's MP4 muxer refuses `pcm_mulaw` outright. Doing it there
  rather than here is what keeps this hop a byte copy: an mp4 Opus sample IS
  an RTP payload, and µ-law is only re-cut into 160-byte frames
  (`recorded/clip-stream-audio.ts`). The broker decodes nothing.

  Three rules, each of which is a bug if it is missing and inaudible in a unit
  test: both tracks are anchored on ONE origin in the demuxer (per-track
  anchoring erases the A/V offset); the feeder runs ONE `MonotonicClock` and
  converts to each track's RTP rate (two clocks re-base on their own last
  output, so each seek leaves them a frame further apart — three seeks
  measured 900 ms); and audio whose moment has passed by more than 120 ms is
  DROPPED and counted, never burst. A clip that plays silent says which of six
  reasons it is, on the `clipAudio` control message and on the log line.
- **FILE** (`high`, or a broker with no dial): one bounded by-handle fetch of
  the whole clip (`videoclips.readClipBytes`), `stbl` indexed, pulled by the
  recorded feeder — free seeking, either twin. First frame after the last
  byte (0.8–3.6 s measured, growing with the clip).

**The stream's SOURCE decides what its controls can promise, and the two
vendors on this fleet are two orders of magnitude apart**
([D616](../decisions/adr-0616-a-hikvision-clip-arrives-at-realtime-so-the-seconds-before-the-first-frame-are-ours-the-rate-ladder-is-declared-and-the-camera-s-one-slot-is-held-by-the-provider.md)).
Reolink's cmd-5 transfer lands a whole clip at 49–62× realtime, so the pacer
has it all in hand and every rate on the ladder is deliverable. A Hikvision
RTSP replay arrives at **1.01×** (176 access units in 14.27 s at 12.5 fps,
1436), so the pacer eats `rate` seconds of media per second while the socket
supplies one and anything above 1 drains a buffer the rest of the clip was
never in. That is why `CLIP_PLAYBACK_OPTIONS` has a THIRD envelope,
`realtimeStream`, whose ladder stops at 1 — the honest answer to a rate a
transport cannot deliver is the declaration (D612), never a pacer that promises
and stalls. A pacer that runs dry now says so once per run
(`clip-stream:starved`); before that, the only evidence was the PROVIDER's
`peer-stalled` ten seconds later, which names the wrong end of the pipe.

A provider whose clips come off a realtime replay also pays its cost in the
FIRST frame, and most of what it paid was ours rather than the camera's: 222 ms
of RTSP handshake against 1 301 ms of holding access units for a rate probe and
2 793 ms inside ffmpeg (its own input probe, `frag_keyframe` waiting out a 4 s
GOP, and the AVIO buffer sitting on the init segment). All three are addressed
in the provider; D616 has the numbers.

Why the broker dials the provider's own listener and not the hub-proxied
route: the data-plane listener is loopback behind a hub-only secret, the hub
proxy takes only user credentials, and `ctx.api.<cap>.subscribe` is refused on
the addon caller. When this was built the framework had no addon→addon byte
transport at all, so the dial is the restream precedent
(`getStreamWithCodec`) one addon over; `ctx.peerBytes` now exists
(see below) and this stream deliberately does not migrate onto it. D9/D18 holds
by shape: compressed bytes, one TCP stream, the backlog bounded at the file
path's ceiling and the socket paused above it (D447 on the consuming hop).

## Addon → addon bytes: `ctx.peerBytes`

Three planes carry media, and until 2026-09-23 only two of them existed for an
ADDON. `dataPlane` lets an addon serve the HUB (loopback listener, per-listener
secret only the hub presents, hub reverse-proxies with user auth in front). A
cap method lets an addon call another addon, but it is a unary envelope — a
base64 payload is held whole (~1.33×) in the producer AND in the caller, which
is why every byte-carrying cap method has had to name a bound and refuse above
it.

`ctx.peerBytes` ([D613](../decisions/adr-0613-an-addon-reaches-another-addons-bytes-through-a-framework-transport-the-producer-offers-one-body-and-a-ticket-never-crosses-a-node.md))
is the third. Read that record before using it; the shape in one paragraph:

- **The producer OFFERS; a consumer cannot address a producer at all.** There is
  no `dial(addonId, path)`. `peerBytes.offer(...)` (or `offerBuffer` /
  `offerFile`) mints a one-shot loopback URL, usually returned as the answer of
  a cap method the producer already gates. Consent is per-request and stays
  with the addon that owns the bytes; the hub's data-plane secret is untouched.
- **One offer is one body and one take**, 30 s TTL, 64 outstanding, `HEAD`
  consumes nothing, a replay is `offer-used`. That bound is also what stops
  this becoming the frame pipe D9/D18 forbid.
- **Same HOST only.** The ticket carries the node it was minted on and `open()`
  refuses `cross-node` by name WITHOUT dialling — a runner's node id is
  `<hostNode>/<runnerId>` and the comparison is on the host part. Device
  providers run on agents, so this is a live branch; widening it means exposing
  an addon listener on a routable interface and is the operator's decision.
- **The producer writes no chunk the socket has not taken** (D447): `write()`'s
  return honoured, `drain` awaited, a peer that takes nothing for 15 s cut,
  every exit logged with `tags: { deviceId }`.
- **The body is handed over PAUSED.** That is the whole reason `open()` is in
  the framework: Node flushes what it already holds on the tick a `data`
  listener attaches, before the consumer's own continuation — the bug that ate
  the head of every clip stream with fourteen green tests (D597).

`videoclips.offerClipBytes` is the first user: the clip export streams a
camera's clip straight into the export file, so the 50 MiB inline refusal on a
long `high` twin no longer applies (the remaining bound,
`VIDEOCLIPS_MAX_OFFER_BYTES`, bounds what the PROVIDER holds — nothing on
Hikvision, one plain copy on Reolink).

The restreams and the clip dial are NOT migrated. They are long-lived streams
with richer per-request contracts; what they should give up, if anyone touches
them, is their private copies of the token/TTL/sweep/bound machinery.

## Who is watching: `getLiveViewerCounts`

`streamBroker.getLiveViewerCounts` answers "how many people watch this camera
live right now" for every camera in one cheap call (no I/O — it walks live
session maps). The definition is one pure module,
`stream-broker/live-viewers.ts`, and it is a POSITIVE classification, because
most consumers of a broker are the system itself:

- **Counted:** WebRTC sessions of a viewer kind (`webrtc-browser`, `-mobile`,
  `-whep`, `alexa`, `homekit`) whose track is on the live edge, and RTSP
  restream clients that reached PLAY and are not ours.
- **Not counted:** every other consumer kind (`recording`, `pipeline`,
  `snapshot`, `warmup`, `derived-broker`, `unknown`); a recorded-playback
  WebRTC session; an RTSP dial that declared a purpose (`/muted-detection`,
  `/recording`, `/sentry`), the muted decoder loopback, a `User-Agent` of ours
  (`recorder…`, `decode…`, `camstack-…`, `prebuffer`), or any peer on the
  loopback (snapshot, grid compositor, the HomeKit ffmpeg leg).
- **No counter to leak:** WebRTC reads `BrokerWebrtcServer.sessions` (the map
  `cleanupSession` empties on every teardown, including the peer vanishing);
  RTSP reads each session's own `playing && !closed`. An unknown RTSP client
  from another host counts as a viewer — add a new internal puller's
  `User-Agent` prefix to `INTERNAL_RESTREAM_AGENT_PREFIXES`.
- One session or connection is one viewer: two tabs on one camera read 2.

## WebRTC gotchas

These are all field-learned; each cost a debugging session.

- **A client-offer session answers audio `sendonly` — unless a trusted caller
  asked for talk-back.** `webrtcSession.handleOffer({ talkback: true })` (the
  Alexa export, for an Echo on an intercom camera) answers `sendrecv` when the
  offer lets the peer send audio, and `TalkbackBridge` relays every inbound
  frame to the camera through `intercom.startTalkSession` / `pushTalkAudio` /
  `endTalkSession` — the HomeKit return-audio primitive. The codec comes from
  the negotiated payload type. The hub strips `talkback` from every
  request-bound call, like `relayOnly`: a browser's talk permission is the
  intercom cap's own surface ([D771](../decisions/adr-0771-a-trusted-client-offer-session-may-carry-talk-back-to-the-camera-intercom.md)).

- **Cameras emit SPS/PPS/IDR as separate RTP packets — and a picture as several
  slices.** The access-unit assembler behind `handleDepacketizedNal` merges them
  into ONE access unit per picture (parameter sets first). Without that, Chrome
  cannot decode, and every per-picture consumer counts slices as frames.
- **`isH264IdrAccessUnit` must also check SPS (NAL type 7)**, not just IDR (type 5)
  — some cameras use non-IDR I-frames.
- **Chrome requires an explicit `video.play()`** on a MediaStream. The `autoplay`
  attribute is not enough when the stream has no initial data.
- **H.265 in Chrome needs hardware HEVC** (macOS/Windows). Chromium headless-shell
  has no VideoToolbox, so the test harness must run headed (`headless: false`).
- **The first adaptive picture is the smallest available rung.** Viewport size
  must not promote to `high` before a probe — a phone-sized player used to land
  on high because 1920×1080 was "closer" than 640×360. Cold start omits
  `downlinkMbps`; `pickAdaptiveTier` falls back to `low` then `mid`. The client
  probes `/adaptive-probe` only after the session's FIRST DECODED FRAME, times
  the body from its first byte, and then climbs: 2.5 Mbps → mid, 8 Mbps → high
  ([D635](../decisions/adr-0635-the-adaptive-ladder-judges-delivery-not-an-absolute-rate.md)).
  The climb is the SAME session: the player hands the reading to
  `webrtcSession.applyDownlinkProbe` and the broker moves that session to the
  rung, never a second session — unless the hub does not know the method
  ([D733](../decisions/adr-0733-a-tier-change-stays-on-the-session-the-viewer-already-has.md)).
  The probe blob is 1 MiB of random bytes served `compress: false` — the hub's
  global `@fastify/compress` counts `octet-stream` as compressible, and the old
  one-byte-repeated blob crossed the wire as ~1 KB of brotli, so the probe had
  been timing a round trip. A probe with too little body is unknown, not slow.
  It requires a session (Bearer or cookie; a `file://` host passes
  `probeAuthToken`), is rate-limited per IP, runs single-flight app-wide, and
  a renegotiation reuses the cached value only — it never probes into the link
  that just stalled. Every telemetry report carries the latest probe, whatever
  it read. Tiny tiles (`< 240 px`) still ceiling
  to low even after a fat probe. Live needs the player change (ui-library) AND
  the broker change (addon-pipeline); recorded playback is embed-side
  (`resolvePlaybackEntryProfile` always `'low'`).
- **The adaptive ladder climbs only on MEASURED health, and never off live.**
  Both halves were learned the hard way on 2026-08-03. `AdaptiveController` is
  ticked with `Date.now()`, so any hysteresis field left at `0` reads as "healthy
  since 1970" — a remote session steered to `low` climbed a rung on its first 2s
  tick, every tier switch rebuilt the controller and re-armed the same free
  upgrade, and the remote bias was gone in ~5s (110/110 sessions). "Not failing"
  is also not health: `LossTracker.lossRatio()` is 0 with fewer than two
  in-window samples, so a session with no RTCP at all read as perfect. And since
  [D42](../decisions/adr-0042.md) the track may be carrying the recorded feeder
  rather than the camera — a tier switch there disposes the `TimelineSession`
  and silently drops the viewer back to live.
- **A tier change stays on the session when the codec allows it**
  ([D733](../decisions/adr-0733-a-tier-change-stays-on-the-session-the-viewer-already-has.md)).
  `in-place-tier-switch.ts` judges it (same codec, passthrough source RTP, no
  Baseline transcode for the client's offered profiles, same audio codec) and
  subscribes the new rendition make-before-break; the switch commits on the
  first packet whose broker pre-buffer starts at a keyframe, rebases RTP and
  replays that GOP (`AdaptiveSession.switchLiveSource`). Anything else — a
  different codec (camera 106), a transcode, recorded mode, no keyframe in
  8 s — is the old close-and-recreate re-offer, logged with its `reason`.
- **The ladder judges DELIVERY, never an absolute kbps floor**
  ([D635](../decisions/adr-0635-the-adaptive-ladder-judges-delivery-not-an-absolute-rate.md)).
  A 41 kbps sub stream with a 4 s IDR alternates ~250/~40 kbps in 2 s client
  windows; an absolute 128 kbps climb floor reset the healthy clock on every
  P-only window and the ladder "never moved". The session keeps what it SENT
  (video RTP payload) in 100 ms buckets (`delivery-meter.ts` `SendHistory`);
  each device-scoped client report (Δ bytesReceived over 2 s, hub-stamped) is
  matched to the same 2 s of sends. Partial delivery and climbs are judged
  over `max(2 s, IDR interval)` (≤ 16 s): stall < 25 %, climb ≥ 90 %; a TOTAL
  freeze starts a stall on the newest 2 s report alone (< 10 % of ≥ 16 kbps
  sent), so freeze → downgrade stays 8–10 s at any GOP; recovery is judged on
  the newest report (≥ 50 %). A window not yet covered while the client
  reports refuses a climb. A tier-change session counts no report for the
  8 s change blackout (the player still reads its old PC), and with two
  adaptive sessions of one camera the device-scoped record is nobody's own —
  delivery unknown, no try. Capacity for the next rung
  is EVIDENCE (`climb-capacity.ts`): REMB or the viewer's probe
  (telemetry `downlinkMbps` + age, or `hints.downlinkMbps`; newest wins;
  confirms while fresh 120 s, holds when short until replaced;
  `probe-evidence.ts`) clearing the rung's
  measured bitrate × 1.2 (`rung-bitrate.ts`; unmeasured rung → client
  threshold 2.5/8 Mbps) confirms a climb. REMB is capped by what is sent —
  430–520 kbps on a 41 kbps rung — so it never counts AGAINST a climb; a
  measured probe below the bar does. No evidence ⇒ a TRY on a clean path
  (delivery ≥ 0.95, loss < 1 %, RTT stable), reverted within the rung's first
  window (`try-climb.ts`: two evaluations < 0.9, a stall, or failing loss) and
  retried after 30 s → … → 10 min; the trial state rides the adaptive intent
  across the re-offer and the backoff is kept per device (10 min TTL). Every non-promoting tick sets a named `climbHold`,
  surfaced on `getSessionDebug` and logged `adaptive: climb held` on code
  change. Tuning: `adaptive-config.ts`.
- **Never depacketize H.265 RTP and re-packetize from scratch.** Chrome's HEVC
  depacketizer rejects a synthesized RTP shape. Forward source RTP through
  `H265Repacketizer`, which preserves header layout: RTSP+H.265 goes
  `onVideoRtp` → repacketizer → `videoSender.sendRtp`. Push sources stay on
  AnnexB → `writeVideoNals`.
- **Scrub granularity is P-frame stepping, both directions, against a FIXED
  4 s camera GOP** ([D68](../decisions/adr-0068.md)). The feeder's sweep mode
  pushes the delta frames between drag targets — forward cheap, backward an
  IDR+prefix GOP walk per step (permanent asymmetry). Whether sweep engages at
  all is decided by the CLIENT's px→time mapping
  (`embed/src/scrub/drag-mapping.ts` — velocity-adaptive; the raw zoom mapping
  starved sweep to 3 engagements in 48 h). The scrub read is GOP byte-range
  (`recording.readGopBytes`, mfra-resolved, D31), fragments are cached per
  WebRTC SESSION (they survive feeder rebuilds; a warm tick skips `locate`),
  and the `{t:'warm'}` control message pre-runs the whole chain on timeline
  open without gating live.
- **The scrub read unit is the WHOLE `low` segment**
  ([D163](../decisions/adr-0163.md)). One sequential ~230 KB read per 10 s
  segment, demuxed once and held as access units, replaces three random seeks
  for ~135 KB of it (tail probe for the `mfra` index, `ftyp`+`moov` head, then
  the fragment) — on a spindle absorbing every camera's writes, bytes are nearly
  free and seeks are the whole cost, and the GOP range bought nothing reusable
  because the next tick in the same ten seconds paid all three again. Every tick
  landing inside a read segment is then served from RAM. `high`/`mid` keep the
  targeted GOP range of D31 (a `high` segment is ~5 MB): the fork is the
  profile. Entering scrub warms 15 min back / 5 min forward from the playhead
  (fire-and-forget, never gating a tick) — asymmetric because a drag starting
  at the live edge or a notification's moment is looking for what ALREADY
  happened. Since 2026-08-25 the warm does not stop at commit: every completed
  seek (a timeline tap or a scrub commit) starts a paced **idle fill**, ±15 min
  symmetric around the landing, one read every 250 ms, yielding to any
  in-flight seek/tick — the operator's think-time on a landed frame is the one
  window the spindle is otherwise free, and it is what makes the NEXT drag's
  entry warm mostly redundant. The cache budget is per profile (48 MB for
  `low` ≈ 30 min of timeline — a ±15 min window either warm can fill — 2 MB
  otherwise, shared by both warms and the drag itself), and BOTH the warm and
  the prefetch stand down when the median recent read crosses 600 ms —
  counted as `prefetchSuppressed`, because on a saturated array speculation is
  another seek queued ahead of the read the operator is waiting on.

  **Every one of those behaviours is gated on `deps.profile === 'low'` by exact
  string equality, and NOTHING server-side pins `low`.** The pin lives entirely
  in the embed client, which sends `setProfile low` before `scrubStart` and only
  when its own `lastSentProfile` mirror disagrees — so a server-side profile move
  is unrepairable: the mirror never learns, the re-pin is skipped, and every
  later drag in that session stays degraded. That is not hypothetical. Once
  `seek`/`scrubCommit` began resolving a profile, a momentary `low` GAP at a tap
  instant returned `high` (because `profileSearchOrder` puts `high` first), the
  feeder rebuilt on `high`, and all three pre-cache behaviours silently switched
  off. The requested tier is now searched to exhaustion first — a `nearestEdgeMs`
  on the REQUESTED tier ends the search, since it already proves that tier
  records — and only a tier that records NOTHING is abandoned. If you add a
  behaviour keyed on the profile string, assume the client is the only thing
  holding it there.
- **The scrub tick IS the read, so speculation is the only throughput lever**
  ([D158](../decisions/adr-0158.md)). Measured on hall 104 over `low`:
  `tickMsP50 = 270` of which `readMsP50 = 263` (a cold ~135 KB fragment off the
  HDD array through shfs/FUSE), `locateMsP50 = 1`, `demuxMsP50 = 1`,
  `ackMsP50 = 23` — one read at a time is a ~3.8 push/s ceiling and the network
  is nowhere near it. (Since 2026-08-25 a per-tick deadline —
  `SCRUB_TICK_DEADLINE_MS = 700`, `2500` for the drag's first frame — drops a
  frame that cannot be produced in time rather than waiting on it, and a drag
  may have up to two fragment resolutions in flight
  (`SCRUB_RESOLVE_MAX_INFLIGHT`) so a dropped read cannot cascade into a third;
  a target within `SCRUB_RIDE_WINDOW_MS` of an in-flight read still rides it
  rather than starting a second one, so the steady-state ceiling above is
  largely unchanged — dropping and the ride window are what keep one deadline
  miss from becoming a saturated spindle. See `recorded-feeder.ts`'s
  `SCRUB_TICK_DEADLINE_MS` docblock for the full four-rule design.)
  The coverage tiers cannot help by themselves: at ~8.8 s of
  timeline per CSS pixel a 270 ms tick steps tens of seconds, so consecutive
  targets never share a ~4 s fragment (`coverMemo = 0` over 17 ticks is the
  proof, and it feeds itself — a slower tick makes a bigger step). Prefetch
  therefore probes where the drag is HEADED (`target + dir × max(|step|,
  durMs+1) × horizon`), not the fragment next door, which is where it used to
  probe and which cost 7 wasted cold reads out of 15. Every speculative read is
  on the census (`prefetchReads` / `prefetchBytes` / `prefetchHits`) — it lands
  on the disk the drag is already waiting for.
- **The receiver credit counts PUSHES, and the ack names the push it settles**
  ([D150](../decisions/adr-0150.md)). A sweep puts ~25 access units on the wire
  under ONE position message, so a viewer without `requestVideoFrameCallback`
  can only ever ack it once — charging per push and repaying per FRAME parked
  the drag permanently at the exact moment the operator slowed down enough for
  sweeps to engage. The `position` a push emits carries a `seq`, the viewer
  echoes it, the first ack naming a push settles it and the surplus (rvfc acks
  once per rendered FRAME) is a no-op. An unacknowledged push is written off
  after 2 s — counted as `ackTimeouts`, never silent.
- **A drag reports itself in ONE line** ([D70](../decisions/adr-0070.md)):
  `scrub-feeder:drag-end` carries the whole census — mapping (`mapFine` /
  `mapCoarse` / `mapUnknown`, from the client's optional `scrubTo` hint),
  locate (`coverMemo` / `coverCache` / `coverMiss`, `locateCalls`,
  `locateMs*`), fetch (`gopReads` / `wholeReads` / `readBytes` / `readMs*`),
  demux (`demuxJs` / `demuxFfmpeg` / `demuxFallback` — the worker_threads
  mp4box parse vs the ffmpeg subprocess; D228 keeps this inside stream-broker, push (`jumps` / `jumpsBack` / `sweeps` /
  `backSweeps` / `aus` / `bytes` / `parks` / `ackTimeouts` / `wholeReads` /
  `prefetchReads` / `prefetchHits` / `prefetchBytes` / `prefetchSuppressed`)
  and ack
  (`ackMsMin/P50/Max` — with `SCRUB_CREDIT_CAP = 2` the achievable rate is
  `2 / RTT`). The per-tick
  `scrub-feeder:pushed` line is SAMPLED (first push, then 1/s) and the
  pathological ones (`parked`, `slow-locate`, the ffmpeg-fallback warn) are
  once-per-drag or throttled: at drag rates an unsampled per-tick line is
  ~16/s per camera on a hub already at 70–95% main thread. The viewer half —
  the mapping hint and the render clock — is specified in
  `docs/design/2026-08-07-viewer-scrub-instrumentation-spec.md`.
- **The demux Worker is transient and sized for itself.** The stream-broker
  runner's V8 flags (`--initial-old-space-size=512`, `--max-semi-space-size=8`)
  are process-wide and a `worker_threads` isolate inherits them, so an
  unconstrained demux worker grew to ~144 MB of uncollected garbage. The client
  (`recorded/demux-off-thread.ts`) therefore spawns it with explicit
  `resourceLimits` (`DEMUX_WORKER_RESOURCE_LIMITS`, which replace the inherited
  sizing) and terminates it after `DEMUX_WORKER_IDLE_MS` (60 s) with no parse
  in flight; the next parse respawns it. A parse is never cut by the idle exit,
  and a worker that dies on its limit fails the in-flight parses to the ffmpeg
  fallback (logged with `tags.deviceId`). Spawn and idle exit log once each.

## Decode

> Which ffmpeg BINARY any of this runs through — the pinned build every node
> downloads, the `CAMSTACK_FFMPEG_PATH` override, and how to change the version
> without an image rebuild — is [`ffmpeg.md`](./ffmpeg.md).

The live runner path is the **native session-decode worker** (node-av, in a
forked child of the runner). There is no decoder session cap and no ffmpeg
decoder addon any more (D763). Why RTP sources (rfc4571 / rtsp) decode via the
RTSP restream rather than hand-depacketized AnnexB — the reference rebroadcast
approach — is covered in the design doc, along with the always-on
detection-subscription ordering.

**A session's worker outlives its detach by a bounded drain
([D652](../decisions/adr-0652-the-runner-never-destroys-a-frame-it-admitted.md)).**
A detection frame on the local-frame-ref path is a reference into the decode
worker, so killing the worker kills every frame the runner still holds. A
teardown sends `drain` (decoding stops, held frames stay readable), waits up to
`SESSION_DECODE_DRAIN_BOUND_MS` (1.5 s) for the frames it handed out to be read,
then kills. It waits only on frames a CONSUMER holds: a detection frame parked
for a late crop (the on-demand JPEG fallback) is served while the worker lives
but does not keep it alive
([D656](../decisions/adr-0656-a-drain-waits-only-on-frames-a-consumer-will-read.md)); only addon shutdown and a crashed session kill at once
(`'immediate'`). The node's live-worker slot is returned at the worker's real
exit, so a draining worker still counts against the ceiling. The occupancy recheck completes when its frames are INFERRED,
not when they are enqueued. Details in the design doc § "Teardown drains".
**No worker outlives the runner process**
([D666](../decisions/adr-0666-a-decode-worker-exits-when-its-parent-or-its-stdio-is-lost-and-the-runner-kills-its-workers-on-shutdown.md)):
`onShutdown` SIGKILLs every live worker first, and a `process.exit` hook kills
whatever is left. A worker whose parent is gone exits in the same turn.

One operational fact worth repeating here: for decode on the hub,
**vaapi works** — a silent fall back to software decode there is a flow bug, not a
capability limit.

**That fact does not generalise across processes, and assuming it did produced a
black Echo.** Measured on 101 on 2026-08-07: `-hwaccel vaapi` inside the
*stream-broker* runner fails to create a device — ffmpeg exits `code=244`,
"Device creation failed: -12 … Cannot allocate memory", ~2 s after spawn with
`packetsOut=0` — while the decoder addon does ten concurrent 4K decodes on the
same host.

**Answered on 2026-09-18, and the answer was not a resource at all.** The two
runners were reaching DIFFERENT ffmpeg binaries. The decoder addon's had VAAPI
compiled in; the broker's was the downloaded portable static build, which has
none (`hwaccels: vdpau`). `-12` is what fftools prints when
`av_hwdevice_ctx_alloc` returns NULL because the type is not in the build — the
name parses, so the request looks valid and the device cannot exist. It reads
as a shortage and is a property of the binary. Both halves are now fixed: every
node runs a binary WE provide, the image's VAAPI-capable one
([D536](../decisions/adr-0536-the-ffmpeg-a-node-spawns-is-always-one-we-provided.md)),
and the broker asks `ffmpeg -hwaccels` before resolving a backend, so a device
that cannot exist is never requested. Both egress transports now
retry once with no `-hwaccel`: `TranscodeEgress` always had that retry (which is
why only the PUSH transport was dark), and `EgressTranscodeManager.createPushChild`
gained it. Two properties came with the fix and are the point: the handle reports
the backend that ACTUALLY ran (a handle still claiming vaapi after a fallback is
the silent downgrade [D67](../decisions/adr-0067.md) exists to make loud), and the
broker is told which backend failed so it stops handing the same corpse to every
child that follows.

**Being told once was not enough.** The failure was first written into the broker's
60 s `egressHwAccelCache`, which is a READ-cadence memo — it exists so a per-session
resolve is not a per-session `decoder.getInfo`, so it expires in a minute, the
decoder answers `vaapi` again, and the next cold child re-pays the ~3 s death. That
is measurable: 22:17:07, 22:18:42, 22:28:48, 22:30:52, 22:32:39, 22:34:07, 22:52:07
on 101, one per memo window. The verdict now has its own home,
`stream-broker/stream-broker/dead-decode-backends.ts` — a process-wide quarantine, escalating
30 min → 2 h → 6 h, lifted by a success, keyed by backend so switching the decoder
to qsv is obeyed at once, and instance state so a runner respawn clears it. The
decoder addon remains the authority on what the NODE can decode; the quarantine is
only what THIS process has observed.
