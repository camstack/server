# Decode path — how the pipeline turns a camera stream into decoded frames

> Status: detection data plane re-verified 2026-08-23 against the
> pipeline-frame-lazy worktree (Tasks 1–5); session teardown and the pre-roll
> hold cap re-verified 2026-09-27 (D652), and what a teardown drain waits on
> re-verified 2026-09-27 (D656); worker exit on parent loss and the shutdown
> kill re-verified 2026-09-28 (D666). Streaming/pull-mode facts from
> 2026-07-06 and native-lease/tile facts from 2026-08-14 remain. Companion to
> [`transport-and-cross-node-routing.md`](./transport-and-cross-node-routing.md)
> and [`data-planes.md`](../architecture/data-planes.md). Detector default
> decision:
> [`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).
> Read this before touching `packages/addon-pipeline/src/session-decode/**`,
> `packages/addon-pipeline/src/pipeline-runner/**`,
> `packages/addon-decoder-nodeav/src/**`, or the stream broker.
> The broker's frame-handle plane (`FrameHandlePlane`, `subscribeFrames`) was
> removed on 2026-10-08 ([D762](../decisions/adr-0762-the-stream-broker-has-no-frame-plane.md)):
> the broker decodes nothing. The same day the `decoder` cap lost its session
> surface, and `decoder-ffmpeg` and `@camstack/shm-ring` were deleted
> ([D763](../decisions/adr-0763-the-decoder-cap-is-a-hwaccel-answer-and-shm-ring-and-decoder-ffmpeg-are-deleted.md)):
> nothing decodes video except the session-decode worker.

> **Detection data plane (2026-08-23).** The live path is a **native decode
> worker** inside `@camstack/addon-pipeline` session-decode. It publishes a
> **process-local `frameRef`**. Co-located `pipeline-executor` resolves
> **content-sized views** (JPEG by policy) from `LocalFrameRegistry`.
> Detection retention is **on-demand** after a positive result. Shared memory
> is **not** this plane: the shm ring, the handle poller, and
> `frameSink:'shm'` as a video selector are gone from the default path, and
> the broker's `FrameHandlePlane` is deleted (D762), and the
> `@camstack/shm-ring` package itself is deleted (D763). Historical one-process
> design:
> [`2026-07-16-shm-removal-one-process-design.md`](./2026-07-16-shm-removal-one-process-design.md).

> **Decoder backend.** There is one: node-av, in the session-decode worker.
> The operator Decoder Backend selector was removed; persisted
> `backend@<nodeId>` rows are inert and unread.

> **Detector default stays 320.** Hardware-aware picks are `yolov9m-320` /
> `yolov9m-320-int8`. 640 is not the default — see
> [`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).

## The chain

```
camera → source reader → StreamBroker
  → native decode worker (nodeav pull / AnnexB push)
  → LocalFrameRegistry (process-local frameRef)
  → content-sized JPEG/RGB views
  → pipeline-executor (in-process) + on-demand retention
```

The historical shm path (deleted; the broker half went with D762) was:

```
… → FrameHandlePlane → decoder session → shm ring → poller → runner
```

1. **Source reader** (`stream-broker/rtsp/`): pulls the physical camera.
   - Native RTSP (Hikvision, …) → `rtsp` source.
   - Reolink native → **`rfc4571`** source (RTP over a length-prefixed TCP
     loopback the `@<github-account>/nodelink-js` Baichuan lib serves). `Rfc4571Reader`
     reads the 16-bit-BE length framing and dispatches RTP packets.
   - `isRtpSource()` = `rtsp | rfc4571 | push-rtp`. Push AnnexB sources are the
     complement (a provider pushes AnnexB `EncodedPacket`s directly).
2. **StreamBroker** (`stream-broker/stream-broker/stream-broker.ts`): the per
   `(deviceId, camStreamId)` hub. On-demand: dials the source only while a
   consumer is attached, suspends on idle. Fans the stream to WebRTC, the RTSP
   restreamer and recording. It decodes **nothing**: its frame-handle plane
   (`subscribeFrames`, the per-format `frameSink:'shm'` decoder sessions, the
   keyframe seed ring, `decodeFps` / `decoderNodeId` in its stats) had no
   caller and was removed (D762). The runner's session-decode worker reads the
   broker's RTSP restream instead.
3. **decoder** — the session-decode worker itself, node-av in-process in a
   forked child (`session-decode/decode-worker-child.ts`). The `decoder` CAP
   decodes nothing: since D763 it is `getInfo` + `reprobeHwaccel` on
   `decoder-nodeav`, i.e. a node's decode-hwaccel answer (`hwaccel@<node>`,
   `probedBestHwaccel@<node>`) that the egress transcode, HomeKit and the load
   view read pinned to the node. Its session surface (`createSession`,
   `pushPacket`, `openStream`, `pullFrames`, …) and the ffmpeg-subprocess
   `decoder-ffmpeg` addon are gone.
   > Historical note (corrected): the 8MP h264 SIGBUS that once got node-av
   > removed was **`/dev/shm` exhaustion** (64MB Docker default vs the ring
   > budget), fixed by `--shm-size=2g` + `RING_BUDGET_MB=16` — NOT a node-av
   > VA-API bug.
5. ~~poller~~ — **deleted on 2026-07-16 with the shm ring.** The runner drives
   decode itself: `startGuardedSessionDecode`
   (`packages/addon-pipeline/src/session-decode/guarded-session-decode.ts`) pulls
   `VideoFrame`s from a forked decode worker via
   `packages/addon-pipeline/src/session-decode/session-decode-pump.ts` and
   publishes process-local `frameRef`s (below).

## Current detection data plane (2026-08-23)

This is the path Task 2–4 shipped. It is **not** shm, **not** a poller, and
**not** an operator-selected ffmpeg video sink.

1. **Native decode worker.** Session-decode forks a child
   (`decode-worker-child.ts`). RTP sources pull the broker RTSP restream;
   push AnnexB sources stay on the AnnexB feed. The worker holds native
   pixels; the parent sees a lazy `VideoFrame` until a view is requested.
2. **Process-local `frameRef`.** `LocalFrameRegistry` stores a serialisable
   `{registryId, id, width, height, format, timestamp}`. `resolve` is not a
   public API: a consumer `acquire`s a `LocalFrameLease` and calls
   `toBuffer()`. LRU evicts owner-only entries (`refs === 1`). A foreign
   registry or a stale id is a miss, never a silent remap. `frameRef` is
   used only when `pipeline-executor` is in the same process as the
   registry.
3. **Content-sized views.** After the tree/model is known,
   `resolveRootFrameViewSpec` asks for the **content** rectangle, not a
   padded square:
   - CamStack default preprocess `letterbox` → `fit: 'contain'`, 16:9
     content (a 320 model on 16:9 is 320×180).
   - The reference NVR catalog (and any `preprocessMode !== 'letterbox'`) →
     `fit: 'stretch'` to the model's square (catalog pin: **resize 320**).
   Payload policy is JPEG (`FRAME_VIEW_PAYLOAD_POLICY`). The worker encodes
   the view on the existing IPC protocol. Split / cross-process still
   sends inline RGB `contain`, never a `frameRef`.
4. **On-demand retention.** Default: admit a pixel-free handle; write
   content-sized JPEG only after a detection (`rememberOnDemand`, reserve
   worst-case 640×640×3 until hydrate). No-detection leaves zero retained
   bytes. Native hold + subject tiles (below) stay the primary late-crop
   path; the RAM fallback is a content-sized JPEG pulled after the result.
5. **Hardware-aware detector default stays 320.**
   `resolveDefaultDetectionModel` maps ANE → `yolov9m-320`, Intel NPU/iGPU
   → `yolov9m-320-int8`. 640 is catalogued and runnable as an operator
   pick; it is **not** the default. The controlled eval recovered **0/3**
   misses at the current 0.50 threshold and failed the false-positive and
   capacity gates —
   [`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).
6. **the reference NVR catalog.** Model Studio's local the reference NVR YOLO manifesto is
   34/34 entries at **320×320** with `preprocessMode: 'resize'` (stretch).
   Letterbox is forbidden on that catalog —
   [`2026-08-23-model-studio-external-catalog.md`](./2026-08-23-model-studio-external-catalog.md).

### Rollback env (inline, no deploy)

| Env | Effect |
| --- | --- |
| `CAMSTACK_CONTINUOUS_RETAIN=1` | Restore write-on-admit retention (continuous RAM write of admitted frames) instead of detection-only on-demand hydrate. |

Neither flag changes the detector default. Clearing the env restores the
shipped path. Do **not** promote 640 by flipping an env — there is no
`CAMSTACK_DEFAULT_DETECTION_640`.

## Push mode vs PULL mode — the important decision (2026-07-06)

The native session-decode worker is PULL-only for RTP sources: it dials the
broker's RTSP restream and lets libav demux it. Push AnnexB sources stay on the
AnnexB feed. The decoder cap's push-mode session surface, the other place this
choice was once made, was removed with D763.

**Why pull mode for RTP sources.** The hand-rolled `rfc4571 → AnnexB` path
produced ZERO decodable frames for Reolink's 4K rfc4571 stream (both vaapi and
software): the AnnexB emitted from heavily FU-A-fragmented 4K NALs is
undecodable, while the SAME stream decodes at full fps through the RTSP restream
(ffmpeg demuxes the RTP itself). This mirrors the reference NVR's rebroadcast
(`prebuffer-mixin` `startRFC4571Parser` + `the reference plugin`): **pass RTP
through, let the consumer's demuxer handle it — never hand-depacketize to AnnexB
for the decoder.** WebRTC on the same camera works precisely because it uses the
raw-RTP path.

**Wiring.** The session-decode worker dials the broker's OWN RTSP restream
(`pull-demuxer-open.ts`). The RTSP client connecting resumes the source
(`rtspRestreamer.onSessionCountChanged → checkDemand`). (The broker-side wiring
that handed its frame-handle plane a `pullModeUrl` went with D762.)

**ffmpeg args gotcha.** `-probesize 1M -analyzeduration 0` is a PUSH-mode
optimisation (raw `pipe:0` h264 self-describes). On the pull RTSP path those
flags starve the demuxer → garbage/no frames (looked like a ~3000fps runaway as
the shm sink counted churn). `buildFfmpegDecodeArgs` emits them for push mode
only; pull-mode RTSP probes normally. `+nobuffer`/`low_delay` stay on both.

## Pre-roll — the seconds BEFORE the motion edge ([D125](../decisions/adr-0125.md), [D381](../decisions/adr-0381-one-prebuffer-the-broker-decides-whether-consumers-only-ask.md))

A detection session attaches when motion has already been detected, so its first
frame is at best the live edge. When that stream's **prebuffer** is on, the
broker retains history past the current GOP and the detection dial is seeded from
a keyframe up to that far back, so the first analysed frames predate the trigger.
It is cut by one pure selector
(`stream-broker/pre-roll.ts`, `selectPreRollStart` — the oldest keyframe AU still
inside the window):

- **pull mode / RTP**: `StreamBroker.getRtpPreRollBuffer(requestedMs)` →
  `RtspRestreamer.setPreRollSupplier` → the join burst that dial receives.
- **push AnnexB sources**: none since D762 — the broker's decoder-seed ring
  (`getDecoderSeedPackets`), its only consumer the frame-handle plane, is
  removed.

**Detection does not configure the window, but it does ASK.** There is ONE
prebuffer per camera-stream (`enabled` + `seconds`, `stream-broker/prebuffer.ts`)
and it is the only thing that decides how much history EXISTS. A dial states, on
its path, how much of it it wants — `/muted-detection/preroll-<ms>`,
`/recording/preroll-<ms>` — and is served the smaller of that and what the ring
holds (`capPreRollRequestMs`). The retired `preRollMs` / `recordingPreRollMs`
pair is D381: two settings for one retention, beside a third (`preBufferSec`)
that on 2026-09-07 was measured retaining nothing on 22 of 22 warm streams.

**An unstated ask is ZERO** ([D382](../decisions/adr-0382-a-consumer-is-served-the-history-it-asked-for-and-an-unstated-ask-is-zero.md)).
It used to be "everything", which is how detection — whose suffix exists to lift
the live-edge join withhold, not to buy history — came to be served the whole
prebuffer. Both shipped dials now name their number in
`stream-broker/rtsp/restream-intent.ts` (`DETECTION_PRE_ROLL_REQUEST_MS`,
`RECORDING_PRE_ROLL_REQUEST_MS`, both `PREBUFFER_MAX_MS` = "as much as you
kept"), and a detection dial that asks for `0` still keeps its live-edge
exemption and takes the ordinary current-GOP burst.

Three properties are load-bearing. The window always starts AT a keyframe (a
tail cut does not decode — D57). It is served ONLY to a session that declared an
intent AND asked for an amount: `getRtpPreBuffer()` still returns the current GOP, because it is also
the WebRTC bootstrap and every ordinary RTSP join. And a prebuffer that is OFF
reduces every path to the pre-D125 behaviour exactly. Pre-roll spends retained
history and never dials a camera: a source that was cold when motion fired falls
back to the current GOP — which is why `enabled` (hold the source warm) is a
separate question from `seconds`, and not a `seconds > 0` shorthand.

**What a burst costs is measured per attach, not per stream.** The broker's
`restream attach live-edge` line (one per session, `tags: { deviceId }`) names
`requestedMs` / `retainedMs` / `preRollSpanMs` (history beyond the ordinary
burst; `0` on a plain join, so both populations compare on one line) and
`liveEdgeMs` (PLAY → on the live feed). It joins the runner's
`session-decode: detection first frame` through the decode dial's per-attach
`User-Agent`, `decode/<deviceId>/<dial>`. Measured on the live hub 2026-09-07
over one hour (239 attaches, 56 with history): an attach served ~4.0 s reached
the live edge in **313 ms** p50 against **171 ms** for a history-free one (broker
side, a paced drain bounded at ~320 ms), and its **first decoded frame arrived
sooner, not later** — `firstFrameMs` p50 **483 ms** (n=48) vs **780 ms**
(n=187). The 4 s of media is drained faster than real time; it does not become
4 s of latency.

## Detection subscription lifecycle (pipeline-runner)

An **always-on** camera starts in the ACTIVE phase, so `runner.registerCamera`
fires a SYNCHRONOUS `detectionStreamHandler('subscribe')`. The addon's
`handleDetectionStreamChange` early-returns when `this.attached` has no entry, so
the attachment MUST be set BEFORE `registerCamera` — otherwise an always-on
camera never opens a detection subscription and sits at 0 fps. On-motion cameras
subscribe later (on a watching→active transition), so they mask this ordering.

## Teardown drains — the runner never destroys a frame it admitted ([D652](../decisions/adr-0652-the-runner-never-destroys-a-frame-it-admitted.md))

A frame on the local-frame-ref path is a zero-copy reference into the session's
decode worker: the runner holds a `frameRef`, and its pixels are the worker's
reserved slot or held frame until `toBuffer` reads them. Killing the worker
kills every such frame. Until 2026-09-27 the runner did exactly that on every
detach — `detachInternal` → `detectionUnsubscribe()` → pump `iterator.return()`
→ coordinator `stop` + `kill()` in the same turn → the child's
`process.exit(0)` → `handleExit` rejected every pending read — and 4 h of hub
logs showed 164 `worker exited before toBuffer reply` / `worker already exited`
failures against **zero** unexpected worker exits.

The teardown is now two-phase:

1. **`drain`** (`worker-protocol.ts`): the child stops decoding, aborts a dial
   still opening and never re-dials; a later `pull` answers `ended`. It frees
   the one undelivered slot frame (`FrameSlot.freeUndelivered`) and closes the
   demuxer once the decode loop has left it (never under an in-flight read).
   The reserved slot, the hold, the tile/scene stores and the decoder whose
   GPU pool those surfaces belong to are untouched — the per-dial `closeInput`
   is skipped while draining — so `toBuffer`, `nativeCrop` and `cutTiles` on
   frames already handed out keep working.
2. **kill**, once no CONSUMER holds an image the coordinator yielded and
   every `toBuffer` / `nativeCrop` already sent has been answered — or when
   `SESSION_DECODE_DRAIN_BOUND_MS` (1 500 ms) expires, which is a WARN naming
   `consumerFrames` / `retainedFrames` / `pendingReads` / `pendingCrops` with
   `tags:{deviceId}`. A session holding nothing a consumer will read is killed
   at once. **A frame only PARKED for a late crop does not hold the worker**
   ([D656](../decisions/adr-0656-a-drain-waits-only-on-frames-a-consumer-will-read.md)):
   every detection frame leaves an on-demand JPEG fallback in the retained
   store, and that fallback keeps a registry lease — so the image stays
   open — until post-analysis asks for it, 2.2–9.9 s later, or it is evicted.
   Counting those made almost every teardown wait the full bound (~99
   WARNs/h, `pendingReads=0` in all of them). The registry now tells each
   lease's `FrameHolder` apart (`consumer`: the runner's owner reference and
   every reader's lease; `retention`: the parked fallback) and signals the
   image when its last consumer goes (`FrameImage.setPendingConsumer`); the
   coordinator counts `consumerImages` and `retainedImages` separately and
   waits on the first. A parked frame whose read has STARTED is a pending
   read and is waited for, and `getNativeCrop` holds the parked frame as a
   consumer across BOTH rungs (`withRetainedReader`): a native miss settles the
   worker's last request in the same turn the fallback's read is not yet
   sent. After the kill a `toBuffer` is refused by name
   (`SessionDecodeReadRefusedError`), and the retained fallback turns that
   into a counted miss. A crop requested after the
   teardown is refused by name. The child exits through `createWorkerExit`:
   quiesce with NO native call, queue the last lines, then exit — the loop may
   still be in libav, and process exit reclaims everything. **While the parent
   is alive** (`stop`, the first SIGTERM, the first uncaught error) it waits at
   most `WORKER_EXIT_FLUSH_BOUND_MS` (250 ms) for those lines. **Once the
   parent is gone** (`disconnect`, a ppid that changed, stdio lost with the
   channel down) it exits in the SAME turn
   ([D666](../decisions/adr-0666-a-decode-worker-exits-when-its-parent-or-its-stdio-is-lost-and-the-runner-kills-its-workers-on-shutdown.md)):
   the bound is a timer, and on the Mac agent a starved loop never fired it.
   An EPIPE on the inherited stdio is never an uncaught exception: raw stderr
   writes stop, and with the channel still up the worker says so once over
   IPC and keeps decoding (raw stderr is the secondary log path). Faults are
   reported rate-limited (5 a minute, the rest counted at exit) and a report
   never loops; a second SIGTERM exits at once.
   Which dispose is allowed when is `decode-loop-policy.ts`; every native
   dispose/close goes through `NativeDisposer`, which refuses once the exit
   began, and a step that throws still exits (code 1). The forked entry is
   `decode-worker-main.ts`, its process wiring `decode-worker-process.ts`
   (`wireDecodeWorkerProcess`, which a test fixture runs as is); the worker
   class stays in `decode-worker-child.ts`.

**The live-worker slot follows the PROCESS.** It is returned from the worker's
real exit (`onWorkerGone`, pump → guarded decode), not from the teardown
request: a draining worker still holds a decoder, a GPU pool and a hold, so
the node ceiling keeps counting it and a re-attach during the drain is refused
rather than admitted as a second worker for the camera — and woken the moment
a slot comes back (`LiveDecodeWorkerAdmission.slotWaiter`: one `SlotWaiter`
per start, FIFO by its first park so a re-park keeps the place; one wake per
slot; a woken start torn down before it asks passes the slot on; the backoff
timer is only the fallback; the refusal WARN fires once per camera per refused
state, and a teardown while refused leaves that state).
A spawn that fails with `error` and no `exit` still delivers its one exit.

`SessionTeardownMode` names the exception: `'immediate'` for addon shutdown (the
runner already stopped dispatching) and for a session whose worker reported a
fatal error. Every other teardown drains by default. The restream is released
at the start of the drain — a draining worker decodes nothing; the live-worker
budget slot follows the PROCESS and comes back at the worker's exit (above).
`'immediate'` SIGKILLs outright: since the child gained a SIGTERM handler, a
worker blocked in a native call never runs it, and the SIGKILL fallback was an
`unref`'d timer the exiting runner did not wait for — the fallback is now
ref'd, and a second teardown saying `'immediate'` during a drain escalates it
to the kill through the whole chain (guarded start → pump → coordinator).
The pump sends that SIGKILL in the same turn as the teardown call, not from the
generator's `finally`: a generator parked in `await pullNext()` runs its
`finally` only after the next frame, and on shutdown the runner has exited by
then (D666). And whatever any session's bookkeeping says, the FIRST thing
the runner's `onShutdown` does is SIGKILL every worker in its
`LiveDecodeWorkers` set — every worker from its fork to its real exit,
occupancy bursts included — logging `session-decode: worker killed at
shutdown` per camera. A fork after that is killed as it registers, and a
`process.once('exit')` hook (`RunnerDecodeWorkers`) kills whatever is left on
any `process.exit`, the runner's uncaught-error `exit(1)` included. A runner
killed by an unhandled signal runs none of this; there the worker's own
parent-loss exit is the protection. Before this, a TERM to the Mac agent's
server left 17 workers at PPID 1, 3.7 GB RSS and 641 % CPU.

The same rule reaches the **occupancy recheck**: its dial used to enqueue the
last frame and tear down + report in one turn, so the verdict was read before
any result and the frames died with the worker. A burst frame now carries
`onSettled` (fired once by the runner: inferred after the result callbacks, or
let go), and `OccupancyBurstLedger` completes the burst when collection has
closed and every admitted frame has settled, bounded by
`OCCUPANCY_BURST_SETTLE_BOUND_MS` (5 s). `occupancy re-check: burst complete`
carries `{frames, inferred, superseded, lost, unsettled, timedOut, found}` and
is INFO whenever `lost > 0` (`superseded` — replaced by a newer frame of the same
burst on the latest-only queue — is not a loss). Collection closing DRAINS the
dial's worker at once. A burst that inferred nothing has observed nothing: it
reports NO verdict (`burst complete — nothing inferred, no verdict`, INFO) and
the arm's empty-burst streak is untouched (D49).

## Admission before pixel materialization

Session decode pulls a lazy `VideoFrame`: no RGB/JPEG bytes cross the worker
boundary until a content-sized view is requested (`toBuffer` / `frameRef`
lease). The adaptive `FrameGovernor` must therefore reserve detection
admission **before** that call. A rejected frame is closed and the pump
immediately pulls again; it pays neither GPU→RAM conversion, content-sized
JPEG IPC, on-demand retain nor native-lease admission.

`PipelineRunner.reserveDetectionFrame` counts source arrivals before applying the
interval, while `enqueueReservedDetectionFrame` queues only an accepted,
materialized frame. Keeping those operations separate is intentional: measuring
only admitted frames creates a throttle→lower measured FPS→higher admission
feedback loop.

When analyzer motion shares the detection worker, materialization happens if
**either** detection or the independently paced motion sink reserved the frame.
Inference throttling therefore cannot starve motion analysis. Only a detection
reservation writes the retained-frame handle and sends `markInferred`.

The worker's configured FPS cap remains the coarse ceiling (10 fps by default);
the governor is the adaptive lower ceiling. Hot updates to target load, minimum
throttled FPS or inference concurrency rebuild and recompute the live governor.

## Lease admission — which frames are saved?

The native-frame lease is the RAM window that lets a LATE cross-process crop
(post-analysis snapshot, face/plate detail) be cut from real native pixels
instead of the ≤640 detection frame. Admission happens in
`decode-worker-child.ts` `captureNativeFrame`, reached through exactly one seam:
`FrameSlot.reserveSlot()`'s `retainSuperseded` hook
(`session-decode/frame-slot.ts`), which fires on the frame the previous `pull`
DELIVERED to the parent, at the moment the next `pull` supersedes it.

That seam decides *what is offered*, on lifecycle rather than content:

| Frame | Offered to admission? |
| --- | --- |
| Dropped by the `minIntervalMs` fps throttle (never entered the slot) | no |
| Superseded in the slot before any `pull` took it (latest-wins) | no |
| **Delivered to the runner** | **yes — exactly once** |

What happens to an offered frame is the `nativeLeaseAdmission` knob (2026-08-07):

- **`all`** — everything delivered is retained. The behaviour this path shipped
  with.
- **`inferred`** — only frames the runner MARKED as having reached inference.
  The default since 2026-08-07.

The hold is the runner's ceiling too (D367, 2026-09-06): the runner keeps at
most `holdFrames - 1` frames of one camera in inference at once
(`maxInflightPerCamera`, resolved from the same lease setting and re-applied on
every lease refresh). Beyond that the latest frame waits in the queue and is
copied inline when picked — a marked frame past the hold would evict the
oldest in-flight one, which is exactly what made the first eight reads of
every fresh session fail before.

A PRE-ROLL burst has to fit that hold too (D652, 2026-09-27). Its frames reach
the runner as lazy refs and sit in the lane until a permit is spare, read
oldest-first — so a burst of `preRollInferenceFrames` (12) into a hold of 8
evicted its own oldest frames before inference reached them (95 of 98 live
`toBuffer miss … released/hold-full` in 4 h named a frameId ≤ 12). The burst now
sends at most `holdFrames - 1` frames (`planPreRollWithinHold`) spread across
the same `preRollInferenceFrames × cadence` of media the operator asked for, so
the history served (D382) is unchanged and only its density drops. The
`pre-roll catch-up burst` line reports `effectiveBudgetFrames`, still at burst
end. The delivered frames' later fate is its own line, `pre-roll frames settled`
(`read`, `released`, `lostByReason: evicted | cleared | download-failed | miss`,
`unsettled`), sent once they have all settled or on teardown. The cap removes
the burst's self-eviction; it does not make `evicted` zero, because live frames
share the hold and outrank the lane.

And the hold ends when the runner lets a frame go (D368, 2026-09-06): a
superseded queue entry, an inference error or a timeout releases the frame's
lease at once through the runner's per-frame cutter binding
(`frame-cutter-binding.ts`), the same binding a result consumes to cut its
tiles. Until then a dropped frame stayed held until 256 later bindings evicted
it, and at 40% queue drops the hold overflowed on three of every four admits.

Two conditions still switch the whole path off for a stretch of time, and
neither is per-frame: `budgetMb = 0` disables the hold entirely, and the
`LeaseActivityGate` closes after `activityMs` without a native-crop request.

> **The TTL is gone (2026-08-13).** A held frame now lives until the runner has
> ITS `FrameResult` and has cut the subject tiles it wanted — an EVENT, not a
> clock — bounded by `nativeLeaseHoldFrames` (default 8) for a runner that
> stops answering. What survives a frame is a compressed native tile per
> subject, and that is what a late crop is served from. `nativeLeaseTtlMs` was
> REMOVED, not redefined. The rungs are summarised next; the full record is
> [`2026-08-13-native-lease-two-tier-redesign.md`](./2026-08-13-native-lease-two-tier-redesign.md).

### The rungs that replaced the TTL (2026-08-13/14)

Under all of them sits the `RetainedFrameStore` **on-demand** content-sized
fallback (pixel-free handle until a detection; JPEG hydrate on late pull;
`CAMSTACK_CONTINUOUS_RETAIN=1` restores write-on-admit). Every rung below
it is native-resolution.

| Rung | What it retains | Shipped default | Owner |
| --- | --- | --- | --- |
| R0 reserved slot | the newest DELIVERED frame, croppable regardless of its inference mark | always on | `packages/addon-pipeline/src/session-decode/frame-slot.ts` |
| R1 the HOLD | a delivered frame, from delivery until its `FrameResult` | `nativeLeaseHoldFrames: 8` (`nativeLeaseBudgetMb: 0` disables the hold) | `packages/addon-pipeline/src/session-decode/native-lease-store.ts` |
| R2 the subject TILE | one padded, JPEG-encoded native tile per surviving detection, 30 s | `nativeTileBudgetMb: 64` — **on by default**; `0` restores the pre-2026-08-13 miss profile | `packages/addon-pipeline/src/session-decode/native-tile-store.ts`, `native-tile-geometry.ts`, `subject-tile-cut.ts` |
| R2b the SCENE tile | one JPEG of the WHOLE native frame, cut in the same synchronous read as R2, on detection-bearing frames only, 30 s | `nativeSceneBudgetMb: 48` — **on by default**; `0` restores the 2026-08-27 full-frame miss profile | `packages/addon-pipeline/src/session-decode/scene-tile.ts` |
| R3 recorded re-decode | nothing — `(deviceId, epochMs)` → segment → GOP → one still | wired to exactly ONE caller (the embedding rebuild's `keyFrame === null` branch) | `packages/addon-post-analysis/src/pipeline-analytics/recorded-still.ts` |

R2 is the tier a late crop normally lands on: by the time post-analysis asks
(measured 2.2–9.9 s after the frame) the hold has long ended, and
`handleNativeCrop` falls through to `serveTileFallback`. Six things about it are
load-bearing, and five of them are a defect this repo already shipped:

- **A tile is a CONTAINER, never a model input.** It is padded to
  `NATIVE_TILE_PADDING_RATIO` (0.35) against the crop convention's 0.15, at most
  `MAX_TILE_SUBJECTS_PER_FRAME` (4) per frame, highest-confidence first. The
  model rectangle is still derived once by `deriveDetailCropRect`
  ([D52](../decisions/adr-0052.md)) and cut OUT of the tile. A rectangle no tile
  contains is a MISS (`no retained subject tile contains the requested
  rectangle`), never a clamp — a clamped rectangle enriches a different part of
  the scene and errors nowhere.
- **A `child_process.fork` inherits the environment but NOT the framework's ESM
  resolver hook.** The tile is a JPEG and the encoder is `sharp`, a
  host-external that `registerFrameworkResolver` provides in the *addon-runner*
  process — so a bare `import('sharp')` in the decode worker resolved nothing
  and the tier cut ZERO tiles on every node from the day it shipped. Both
  host-externals now resolve through
  `packages/addon-pipeline/src/shared/host-external-import.ts` (bare specifier →
  `CAMSTACK_FRAMEWORK_DIR` → the Electron bundle roots → the process cwd, via
  `createRequire().resolve`, which honours `NODE_PATH` where an ESM bare import
  does not). A RESOLUTION failure is now sticky — one warn naming every
  candidate — because the old memo-clearing retry re-entered the module loader
  (a synchronous `Atomics.wait`) once per subject per frame: 3 800 WARN/min
  cluster-wide. A LOAD failure stays retryable.
- **The retained frame is not always YUV420P.** `planar-crop-source.ts` owns the
  plane offsets for every layout the hold can carry, NV12 (two planes: Y plus
  one interleaved U/V plane) included — libswscale reads it as a source format,
  so the crop is still ONE sws pass. An NV12 chroma column is two bytes, so an
  even `left` lands at byte `left`, not `left/2`; getting that wrong shifts
  colour instead of throwing. The scaler cache key carries the SOURCE format so
  a three-plane scaler is never served to a two-plane frame.
- **A format this path still cannot read is NAMED**, not asserted away:
  `retained frame in unsupported pixel format <n> (planes=…, hw=…)`. The message
  it replaced claimed YUV420P and never said what it had been handed, which is
  why 533 identical lines on one camera answered nothing. Tile-cut failures log
  on TRANSITION; the volume lives on the metrics line as `tileCutFailures`.
- **Every subject's pixels are read in ONE synchronous turn**
  (`subject-tile-cut.ts` `extractSubjectTiles`), and the encodes then run off
  copied bytes. Awaiting a JPEG encode between two reads lets the worker service
  a `pull`, whose delivered frame evicts the oldest held frame — which on a busy
  camera is the one being cut. That cut subject 1 of each frame and lost the
  rest, and surfaced as `unsupported pixel format -1 (planes=0)`: a node-av
  frame whose `free()` had already run.
- **The hold is ended by a PER-FRAME binding made at delivery**, not by a
  lookup in `NativeCropRegistry`. That registry is a node-wide LRU capped at 256
  and shared by every camera to serve late cross-process crops; on the live hub
  it sits pinned at its cap, so an entry's lifetime is a function of how busy
  the OTHER cameras are. Dispatching the cut through it meant a frame could not
  find its own cutter, the hold never released, and `holdOverflow` climbed while
  `tilesCut` stayed 0 — with both early returns silent. Every non-dispatch is
  now counted per camera by reason (handleless / unbound / threw) and warned
  once a minute.

**R2b is R2's missing half, and it was missing for exactly the reason R2 is
strict** (2026-08-27). Containment is the serve gate, so a subject tile can never
contain the FULL-FRAME rectangle — which means the consumers that ask for the
whole frame had no rung at all below the hold: the native `keyFrame`
(`getNativeKeyFrameRgb`, bbox `{0,0,1,1}`, `maxWidth 4096` — the only image a
semantic rebuild reads), the detail plane's `runDetailSubtree({ frameJpeg })`
rung, and the display-crop full-frame fallback. Measured over 24 h on the live
cluster: **874 of 3 750 key-frame captures (23.3%) ended `native-miss`**, and of
the 893 runner-side `native full-frame miss` warns at `maxWidth 4096`, **855
(95.7%) carried `nativeMissReason: worker-lease-gone`** against 38 (4.3%)
`no-registry-entry` — i.e. the worker was reached and answered, the raster was
simply gone. The ≤640 `RetainedFrameStore` did not cover either: only **3**
captures in the same 24 h ended `ram-tier`, because its on-demand hydrate
re-enters the same released frame. The requests were not exotically late —
handle age at the miss was **p50 367 ms, p75 1.0 s, p90 4.3 s, p99 15 s**.

Why a tile rather than a longer hold, in the numbers that decided it: a held 4K
raster is **23.75 MB** (`leaseMb:190, leaseFrames:8` on every 4K camera — the
`holdFrames` COUNT binds, never the 1024 MB ceiling), the admitted rate is
**~2.1 frames/s** per camera, and decode-session concurrency is **4.3 typical /
12 peak**. Holding rasters across the operator's 10 s window is
`21 × 23.75 MB ≈ 498 MB per camera`, **~6 GB at peak** — the D9/D18 OOM exactly.
A scene tile is ~1.5–2.5 MB and is cut only on detection-bearing frames
(**~0.4/s**, not 2.1), so the same window costs ~10–25 MB per camera and the
30 s TTL binds before the budget does at steady state.

Three properties, each of which is a decision rather than an accident:

- **Its own store, not a fifth entry in the subject store.** A scene tile is ~20×
  a subject tile; one shared budget would let a busy camera's key frames evict
  the face/plate tiles the recognisers live on. Two `NativeTileStore` instances
  make starving that tier structurally impossible, and
  `scene-tile.spec.ts` asserts it.
- **Budget exhaustion evicts the OLDEST scene, it does not refuse the newest.**
  At p50 367 ms the newest tile is the one most likely to be asked for, so
  refusing it would drop the request most likely to arrive. Every drop is counted
  (`NativeTileStore.evictedCount` → `sceneEvicted`), because on this store a
  dropped entry is a key frame that can never be re-captured. Nothing in either
  budget can reach the live decoder: both stores hold already-encoded bytes.
- **Expiry is the store's own TTL, not the track's lifetime.** A track that never
  closes cannot pin RAM — the scene tile ages out at
  `CAMSTACK_SESSION_NATIVE_TILE_TTL_MS` (30 s) whether or not anything asked for
  it, and `closeInput()` clears the store on every re-dial and teardown.

Per-device on the session-decode metrics line: `holdOverflow`, `tilesCut`,
`tileHits`, `tileMisses`, `tileCutFailures`, `tileMb`, `tileFrames`,
`scenesCut`, `sceneHits`, `sceneRefused`, `sceneEvicted`, `sceneMb`,
`sceneFrames` — alongside `leaseMb` / `leaseFrames`, which now say what the HOLD
is resident for.

R3 is deliberately not on any delivery path: it refuses past 2 concurrent rather
than queueing work whose value decays, and
`scripts/check-recorded-still-off-delivery-path.ts` (wired into CI) fails the
build if the notification centre or the capture scheduler imports it.

### Why `inferred` is not lossy

A native crop names one specific `frameId`, and **the only way a `frameId`
leaves the runner is on a `FrameHandle` riding an INFERENCE RESULT.** Every
handle post-analysis owns arrives through `PipelineAnalytics.processFrame`, and
its only handle-bearing caller is `handleInferenceResult`; the onboard-motion
caller passes no handle at all. The detail plane's `nativeCropRef`, the
event-media captures (`keyFrame` / `snapshot` / `thumbnail`), the plate and face
recognisers and the executor's `buildNativeFaceCropProvider` all descend from
that one handle. There is no UI caller and no other addon holds a `FrameHandle`.
So a frame the runner never enqueued is a frame nobody can ask for.

That is an argument, and the code carries the measurement that outranks it:
`leaseUnmarkedCrops` on the session-decode metrics line counts every native-crop
request naming a frame the runner never marked, **in both modes**, so the premise
is checked on production traffic before and after the filter is switched on.
Anything other than 0 means put the cluster back on `all`.

The mark is `markInferred(frameId)` on the existing worker channel
(`worker-protocol.ts`), sent from the same synchronous turn that received the
frame — the `pull` that follows is what decides that frame's retention, so IPC
ordering is the whole contract. The runner's `enqueueDetectionFrame` /
`enqueueOccupancyFrame` return whether the frame was admitted; that boolean is
the signal.

The **newest delivered frame is croppable regardless of its mark**: it is the
slot's `reserved` frame and `handleNativeCrop` resolves it through
`FrameSlot.toBuffer`, never through the lease. That is the margin for the
one-frame race between a mark and the supersede that consumes it, and it is free
because the frame is held anyway.

> The three paragraphs that follow describe the PRE-2026-08-13 TTL lease. They
> are kept because the measurements in them are what motivated the hold, not
> because any of it still runs: there is no TTL, and the resident set is now
> `frameBytes × holdFrames` under the same ceiling.

**Rate and cost, and which limit was actually binding.** In `all` mode the
admission rate is the *delivered* frame rate: ~25/s on a 25 fps camera with
`detectionFps: 0` and a runner keeping up. One 4K frame is ~24.9 MB on the
default pinned-RGB24 lease path (~12.4 MB as YUV420P); 1080p is ~6.2 / ~3.1 MB.
So a busy 4K camera drives ~620 MB/s of GPU→RAM download while the gate is open.

The resident set is `min(frameBytes × admittedFps × ttlSeconds, budgetMb)`, and
**at the 2 800 ms TTL the operator chose on 2026-08-07 the BUDGET is what binds**
— measured: `leaseMb:1020, leaseFrames:43` on every 4K camera, i.e. pinned at the
1024 MB ceiling with the TTL never expiring anything. That inverts what
`inferred` buys. It does not give RAM back; it makes the same 43 retained frames
cover roughly twice as much wall-clock time, which is why the measured effect was
a **drop in crop misses (7.1% → 4.4%)** rather than a drop in worker RSS. If RAM
is what you want, lower `nativeLeaseBudgetMb` — the filter is what makes a
smaller budget still cover the late-crop horizon.

`leaseMb` / `leaseFrames` on the metrics line say which limit is binding for a
given camera. `rssMb` cannot answer it: it is a high-water mark dominated by the
decoder's own pools and it never comes back down.

**Every-Nth decimation is still NOT what this is.** "Admit every Nth" does not
work on its own: a crop asks for one specific `frameId`, so N−1 of every N
requests would simply miss. `inferred` works precisely because it is not a
count — it is the exact set a request can name.

## Operator knobs for the lease (2026-08-07, re-cut 2026-08-13)

Hold depth, RAM ceiling, demand window, admission, tile budget and scene budget
are **cluster-wide `pipeline-orchestrator` settings**, not env vars — Pipeline →
*Native frame lease*: `nativeLeaseHoldFrames` (8), `nativeLeaseBudgetMb` (1024),
`nativeLeaseActivityMs` (15 000), `nativeLeaseAdmission` (`inferred`),
`nativeTileBudgetMb` (64), `nativeSceneBudgetMb` (48). There is no `nativeLeaseTtlMs` — it was deleted with
the design that gave it meaning, rather than left to mean something else. Same
neutral-owner idiom as the detail-crop convention: the keys and bounds live in
`packages/types/src/pipeline/native-lease.ts` because the writer (orchestrator)
and the reader (pipeline-runner) are different addons and may not import each
other.

The path a value takes: the runner reads the orchestrator's globals over the
hub-routed `addon-settings` cap (`pipeline-runner/native-lease-settings-source.ts`,
30 s TTL, refreshed on the acquire leg of every session-decode dial), RESOLVES
them in its own process (`session-decode/native-lease-config.ts`, precedence
**setting > env > default**) once per session, and sends the resolved set to the
child on the `start` message as the required `WorkerRequest.lease`. The child
(`session-decode/native-lease-knobs.ts` — the wire shape and its guard, types
only) builds its hold, tile and scene stores from them before the first packet,
and logs the effective values plus their source once per session, tagged with
`deviceId`.

Until D453 the CHILD resolved them, at module load, from `*_SETTING` env vars
the fork wrote. That needed the Zod schemas inside the child bundle, which
dragged the whole 1.5 MB `@camstack/types` chunk in with them: **~170 ms and
~99 MB of heap on every fork**, measured on the hub, ~277 cold forks an hour.
`scripts/check-decode-worker-child-lean.ts` fails CI if any module reachable
from the child entry value-imports a package again. A decode-worker fork now
carries no configuration at all, which is also the only reason a worker could
ever be pre-forked.

Consequences worth knowing:

- **A change applies to NEW decode sessions only.** A running session keeps the
  knobs it was forked with; re-dial the camera (detach/attach, or a runner
  respawn) to move it.
- One env var per knob survives as an emergency/dev override —
  `CAMSTACK_SESSION_NATIVE_LEASE_{HOLD_FRAMES,BUDGET_MB,ACTIVITY_MS,ADMISSION}`,
  `CAMSTACK_SESSION_NATIVE_TILE_BUDGET_MB` and
  `CAMSTACK_SESSION_NATIVE_SCENE_BUDGET_MB` — and each applies only while the
  corresponding setting is unset. **"Unset" includes a knob sitting at its
  shipped default**: `addon-settings.getGlobalSettings` hydrates an unstored
  field with the schema's own default (verified live — a cluster that has never
  opened the form reports `nativeLeaseHoldFrames = 8`) and there is no raw-store
  read on that cap to tell the two apart, so treating the default as a choice
  would have retired every env var on the day this shipped. Move the slider off
  the default and the setting takes over; move it back and the env var returns.
  The one honest edge: you cannot select the default value in order to overrule
  an env var — clear the env var instead. The worker's spawn line names the
  source, so which one won is never a guess.
- `CAMSTACK_SESSION_NATIVE_CROP_RING` (the GPU surface ring) stays **env-only on
  purpose**: every slot pins a VAAPI surface out of the decoder's own pool — the
  historic leak site — and the ring is only reachable at all when the hold is
  disabled (`budgetMb: 0`).
- The tile tier's shape knobs — `CAMSTACK_SESSION_NATIVE_TILE_TTL_MS` (30 000)
  and `CAMSTACK_SESSION_NATIVE_TILE_MAX_PER_FRAME` (4) — are env-only too, for
  a bisect rather than for operation: the RAM they cost is already an operator
  knob (`nativeTileBudgetMb`).

## Hub hardware facts (verified 2026-07-06)

The Unraid hub container HAS working VA-API H264 hardware decode: `/dev/dri/{card0,
renderD128}`, `vainfo` OK (Intel iHD, `VAProfileH264High:VAEntrypointVLD`), and
10× concurrent 4K vaapi decodes pass. `qsv` fails device-creation (`-12`, no MFX);
`vaapi` is the working hub hwaccel. So a software fallback in the logs signals a
FLOW problem (wrong args / undecodable input), not missing hardware.

## Reference implementations (read-only inspiration)

- The reference NVR rebroadcast: `~/Documents/Git/`the reference NVR sources`
  (`startRFC4571Parser` — RTP passthrough, no depacketization).
- `~/Documents/Git/`the reference plugin` (Reolink native →
  `x-the reference NVR/x-rfc4571` media object; same rfc4571 source as camstack).
- NVR libav decoder: `~/Desktop/NVR/libav-fork.nodejs.js` (replays buffered packet
  list `p` to each hwaccel candidate — the pattern behind the cascade GOP replay).

## Change log

- 2026-10-08: the `decoder` cap's session surface is removed and
  `decoder-ffmpeg` and `@camstack/shm-ring` are deleted (D763). The cap is
  `getInfo` + `reprobeHwaccel` on `decoder-nodeav`; push-mode sessions, the
  ffmpeg hwaccel cascade with GOP replay and the shm ring went with them. On the
  live cluster `decoder.listActiveSessions` was `[]` on every node.

- 2026-09-28: a decode worker never outlives its runner (D666). A graceful
  runner exit killed no worker (`'immediate'` queued behind a pending pull;
  bursts unreachable), and the orphan's D652 exit waited on a timer its own
  EPIPE → uncaughtException → EPIPE loop never let fire. The runner now
  SIGKILLs its `LiveDecodeWorkers` first thing on shutdown and on any
  `process.exit`, `'immediate'` kills in the same turn, and a worker exits in
  the same turn once its parent is gone (a dead stderr alone only turns raw
  logging off).
- 2026-09-27: teardown DRAINS (D652). The runner killed its own decode worker in
  the turn it detached, destroying every admitted frame still queued or in
  flight (164 failures in 4 h, zero unexpected exits). A teardown now sends
  `drain`, waits ≤1.5 s for the frames it handed out, then kills; shutdown and
  a crashed session stay `'immediate'`; the live-worker slot returns at the
  worker's exit. The occupancy burst completes on inference, not enqueue, and
  gives no verdict when nothing was inferred. Pre-roll is capped at
  `holdFrames - 1` with its reach kept; its later losses are a separate
  `pre-roll frames settled` line.
- 2026-08-27: the SCENE tile (R2b). A full-frame rectangle is contained by no
  subject tile, so every FULL-FRAME consumer — the native `keyFrame` above all —
  had no rung below the hold and missed 23.3% of the time, 95.7% of those with
  `worker-lease-gone` at a median handle age of 367 ms. One JPEG of the whole
  native frame is now cut in the same synchronous read as the subject tiles, on
  detection-bearing frames only, into its OWN `NativeTileStore` under
  `nativeSceneBudgetMb` (48) — a separate budget so a key frame can never evict a
  face tile. The 10 s the operator asked for costs ~10-25 MB a camera this way;
  as retained RASTERS it would have been ~498 MB a camera and ~6 GB at peak.
- 2026-08-23: detection data plane documented as native decode worker +
  process-local `frameRef` + content-sized JPEG views + on-demand
  retention. Decoder Backend selector removed (always `nodeav`). Hardware-aware
  detector default stays 320 — 640 failed the promotion gates in
  [`pipeline-frame-model-eval.md`](../benchmarks/pipeline-frame-model-eval.md).
  Rollback: `CAMSTACK_CONTINUOUS_RETAIN=1` (the local-`frameRef` rollback env
  was removed on 2026-10-06). shm / poller / ffmpeg-as-video-selector are
  not the active plane.
- 2026-08-14: the tile tier stopped cutting zero. Three independent defects, in
  the order they were found: `sharp` unresolvable inside the forked decode
  worker (host-external resolution + a sticky resolution failure), a retained
  NV12 frame rejected by YUV420P-only plane math (`planar-crop-source.ts`, plus
  a named message for any layout still unreadable), and a frame evicted between
  two subjects because the cut awaited each encode (`subject-tile-cut.ts` reads
  every subject in one synchronous turn).,

- 2026-08-13 (later): ending a frame's hold moved off `NativeCropRegistry` — a
  node-wide LRU pinned at its 256 cap — onto a per-frame binding made at
  delivery, and every undispatched cut is counted and warned. Before that the
  hold never released: `holdOverflow` climbing, `tilesCut: 0`, the retention
  window collapsed and tRPC at 6.5 s.
- 2026-08-13: the TTL lease became a HOLD (`nativeLeaseHoldFrames`, `nativeLeaseTtlMs`
  removed), a subject-TILE tier (`nativeTileBudgetMb`) and a recorded GOP
  re-decode.; design
  [`2026-08-13-native-lease-two-tier-redesign.md`](./2026-08-13-native-lease-two-tier-redesign.md).
- 2026-08-07 (later): lease ADMISSION became a knob. The runner marks the frames
  it sent to inference (`markInferred`), and `nativeLeaseAdmission: 'inferred'`
  retains only those — the only frameIds a crop request can ever name. Shipped as
  `all` and promoted to the default after ~50 000 live crop requests recorded
  `leaseUnmarkedCrops: 0`; misses then fell 7.1% → 4.4%. Operator TTL set to
  2800 ms the same day, which is what made the RAM ceiling the binding limit.
- 2026-08-07: the native-lease knobs (TTL / RAM ceiling / demand window) became
  cluster-wide `pipeline-orchestrator` settings, carried into each decode worker
  on the fork env with `setting > env > default` precedence. Lease admission
  documented: every DELIVERED frame, no decimation.
- 2026-07-16: shm-ring removal (DONE). Default-path frame retention moved
  off the `csr.` shm ring; the shared poller was deleted. `frameSink:'shm'`
  remained a leftover wire value on the broker subscribe surface until that
  surface was removed on 2026-10-08 (D762). See
  `2026-07-16-shm-removal-one-process-design.md`.
- 2026-07-06: pull-mode RTSP restream decode for RTP sources (fixes Reolink 592
  detection + motion boxes); push-mode keyframe seed + cascade GOP replay;
  always-on subscription ordering; push-only probe flags.,

