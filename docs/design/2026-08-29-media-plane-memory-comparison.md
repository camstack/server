---
title: The reference NVR media plane, second pass — where the 5× CPU gap lives, and what to adopt
last-verified: 2026-08-29
covers:
  - packages/addon-pipeline/src/stream-broker/**
  - packages/addon-pipeline/src/session-decode/**
  - packages/addon-pipeline/src/pipeline-runner/**
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/**
---

# The reference NVR media plane, second pass — where the 5× CPU gap lives

> **The ask.** Same host, same 30 cameras, both stacks doing prebuffer and
> detection (the reference NVR also records 10): camstack **16.6 %** CPU / **0.84 GB**
> RAM per camera vs the reference NVR **3.5 %** / **0.34 GB**. On our side
> (`metricsProvider.listNodeProcesses`, hub): **336.9 % total CPU, 121.6 % of
> it garbage collection**; `stream-broker` alone 95.5 %, **68 % of that its
> own GC**, `heapUsed` 151 MB against `arrayBuffers` 883–961 MB; hub root
> 79.7 %; decode workers 40–80 % each; **Python inference 12 % of one core
> total**. This document answers four structural questions against the reference NVR's
> source (local clone, licence-checked per file), ranks what actually explains
> the gap, and stages what to adopt.

**Relation to the first pass.** `docs/design/2026-08-25-media-plane-comparison.md`
is the container-level inventory and the RAM story (hub-main mediation, idle
tail, recording index). It measured a 1.5× container-level gap on a day when
the reference NVR was bursting; today's per-process numbers on the same host show 5×
per camera. Both are real measurements — see §8. This second pass goes below
the process table: what the bytes do, allocation by allocation. Note the fleet
already moved: the 25th measured ~556 % avg; after removing a per-packet
`setTimeout` watchdog and a double NAL copy, today reads 336.9 %. The
remaining gap is what is analysed here.

## 0 · Licence boundary (verified per file, 2026-08-29)

The reference NVR's root `LICENSE.md` says licensing varies per directory. Verified
against each directory's `package.json` `license` field in the local clone:

| Directory | Declared | Treatment in this document |
| --- | --- | --- |
| `the reference NVR sources` | **Apache-2.0** | quoted, line-cited, adoptable |
| `the reference NVR sources` | **Apache-2.0** | quoted, line-cited, adoptable |
| `the reference NVR sources` | Apache-2.0 | not needed here |
| `the reference NVR sources`, `the reference NVR sources` | `"Apache"` (no version) | not relied on; version ambiguity noted, not needed |
| `the reference NVR sources`, `the reference NVR sources`, `the reference NVR sources` | **ISC** | permissive; line-cited where load-bearing |
| `the reference NVR sources`, `coreml`, `onnx`, `openvino`, `tensorflow-lite`, `webrtc`, `opencv` | **none** → all rights reserved | **behavioural facts only** — no code, no identifiers, no constants of theirs reproduced |
| NVR plugin | **absent from the repo** (closed source) | recording/playback/tracking internals unverifiable |

Adoption obligations, should any code be taken: Apache-2.0 §4 — ship the
licence text, retain copyright/attribution notices, state changes, carry any
NOTICE file. ISC — retain the copyright and permission notice. The
recommendation below (§6a) is that **no literal code needs to be copied**;
everything worth having is a structural pattern our codebase already half-owns.
Note: `the reference NVR sources` is a symlink into
`the reference NVR sources` — both unlicensed, so the shared base class is
facts-only too.

## 1 · Question 1 — the prebuffer

### What the reference NVR holds, and in what form

**Raw containerised bytes, exactly as read from the camera socket, shared by
reference with every consumer.** The entire prebuffer is
`rtspPrebuffer: PrebufferStreamChunk[]` — a plain JS array of
`{ chunks: [Buffer, Buffer], type, time }`, where the two Buffers are the
4-byte RTSP interleave header and the RTP packet payload
(`the reference NVR sources`:48`). Window fixed at 10 s
(`the reference NVR sources`:29`), trimmed by `shift()` per
packet with a periodic `slice()` compaction every 100 000 shifts
(`the reference NVR sources`:710`). Not parsed frames, not
NALs, not a file: the wire bytes. NAL inspection (sync-frame search, IDR
interval, SPS resolution) is done lazily over `subarray` views, never copies
(`the reference NVR sources`:109`).

**One allocation per packet, total.** Ingest is a pure-JS RTSP client whose
read loop does `readable.read(4)` + `readable.read(length)` and yields
`{ chunks: [header, packet] }` unchanged
(`the reference NVR sources`:969`,
`the reference NVR sources`:130`). The Buffers the
ring retains **are** the buffers the stream layer produced. There is no
depacketizer on this path at all, for anyone — Annex-B exists only inside a
decoder when one runs.

**Per-consumer cost: two `socket.write()` calls, zero copies.** Every consumer
subscribes to the same `'rtsp'` event and writes the shared Buffers directly
(`the reference NVR sources`:840`). When the client
negotiated a different interleave channel, only the **4-byte header** is
duplicated and rewritten (`the reference NVR sources`:974`);
when channels match, `interleavePassthrough` skips even that
(`the reference NVR sources`:1029`). **The class of cost at
our `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:255` — a
full per-packet copy per connected client — is structurally absent.** Their
per-packet watchdog is a coarse `setInterval` plus a timestamp write
(`the reference NVR sources`:14`), the same shape we adopted
yesterday.

**A joining consumer gets a replay of the same objects.** History = iterate the
shared array from a sync frame (found by scanning NAL types through views,
`the reference NVR sources`:298`) and write the same Buffers down the
new socket (`the reference NVR sources`:885`). No re-mux, no
byte range, no copy. Every consumer — HomeKit, WebRTC, objectdetector, the
closed NVR — is "an ffmpeg-shaped RTSP client" on a localhost socket, so
cross-process media is compressed RTP through kernel socket buffers, never
frames.

**Recording is the same buffers appended to a file.** The closed NVR drives an
Apache-licensed non-standard `WRITE` verb; the prebuffer process then passes
each header+payload pair to an `fs.WriteStream`
(`the reference NVR sources`:109`). Zero remux,
zero extra allocation, no ffmpeg. (The format cost is paid at playback — §6c.)

**Bounds and lifecycle.** 10 s per stream, at most two prebuffered streams per
camera by default (local + remote-recording,
`the reference NVR sources`:156`); everything else
is on-demand and self-terminates after 10 s without active clients
(`the reference NVR sources`:738`). Backpressure is a hard
100 MB `writableLength` kill of the consumer
(`the reference NVR sources`:858`) — we already have the
equivalent (`MAX_WRITE_BUFFER`,
`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:224`).

So the answer to "why is their heap small" is indeed the shape of what they
retain: **the retention is the ingest allocation, and sharing is the only
fan-out mechanism.** ~10 s × bitrate per stream of Buffers and nothing else;
at 30 cameras × 2 streams that is on the order of 150–300 MB, allocated once
per packet, freed once per packet, never copied in between.

### What we hold — same fundamental design, plus four accretions

Our broker's core is the *same* idea: `rtpRing`, a `Buffer[]` of on-wire RTP
packets (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:540`),
keyframe-indexed, replayed to joiners by reference through a paced burst
(`packages/addon-pipeline/src/stream-broker/paced-rtp-replay.ts:183`). **This
is not a redesign case.** The 68 %-GC broker is the base design buried under
accretions the reference NVR does not have:

1. **The per-client egress copy.** Every packet, per connected RTSP session,
   is copied whole to prepend 4 bytes
   (`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:255`,
   audio twin at `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:278`).
   At ~3 000 pps ingest and 2–3 sessions per broker (detection dial, recording
   dial, egress legs) that is ~6 000–9 000 full-packet allocations/s for four
   constant bytes. The reference NVR writes header and payload as two socket writes.
2. **Unconditional depacketization feeding a consumer that never exists.**
   Every video packet of every broker is depacketized to Annex-B (~1 500–3 000
   allocations/s + copies, `packages/addon-pipeline/src/stream-broker/rtsp/rtp-depacketizer.ts:310`)
   to feed `decoderSeedBuffer` — 6 s of full-bitrate Annex-B pushed
   unconditionally (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:1693`)
   for a `FrameHandlePlane` that the shipped pull-mode decode path never
   constructs (`docs/architecture/data-planes.md` marks that subscribe surface
   a leftover). The reference NVR has no Annex-B anywhere in its broker.
3. **The same media retained twice, in two encodings, in up to four rings.**
   `rtpRing` (10 s — recording pre-roll ships ON for every broker,
   `packages/addon-pipeline/src/stream-broker/pre-roll.ts:213`, installed at
   `packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts:1805`),
   `decoderSeedBuffer` (6 s Annex-B, everyone), `clipBuffer` (25 s Annex-B,
   cheapest profile of every camera,
   `packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts:6068`),
   `preBuffer` (10 s, push sources). The reference NVR holds one ring, one encoding.
   Sub-hazard found on the way: the pre-roll byte budget caps at 32 MiB
   (`packages/addon-pipeline/src/stream-broker/pre-roll.ts:234`) **above** the
   whole-ring hard ceiling of 24 MiB
   (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:594`),
   so a ≳13 Mbps stream at a 10 s window is authorised to overflow its own
   ring and cycle `resetRtpPreBuffer`.
4. **A join-handshake allocation burst.** While any session sits between SETUP
   and PLAY, *every* incoming packet maps the entire retained ring (~1 800
   entries) into fresh packet objects before discovering no session is ready
   (`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts:658`
   allocates; the `ready.length === 0` return is only at
   `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts:676`).
   Detection dials do this on every motion event — 823 attach/detach cycles in
   6 h per D282.

**Why `arrayBuffers` reads ~900 MB against ~150 MB heap.** Logical retention
across 47 brokers is roughly 250–500 MB (the repo already attributed "~1 GB …
arrayBuffers (47 RTP rings)" at
`packages/system/src/kernel/moleculer/process-service.ts:266`). The
amplification on top is most plausibly Buffer-pool slab pinning: retained ring
packets (~1.2–1.4 KB each, under the pool threshold) and the millions/minute of
short-lived egress copies from accretion 1 are drawn from the **same shared
8 KB slabs**, so one retained packet pins a slab full of dead neighbours —
which also explains why the number is stable rather than sawtoothing.
Hypothesis, not proof; a heap snapshot would settle it (§8). There is no
pooling or slab discipline anywhere in the media path — every retained packet
is an independent `Buffer.from` at
`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-client.ts:409` (that one
ingest copy is load-bearing: the source `subarray` aliases the socket buffer).

## 2 · Question 2 — objectdetector orchestration

**Theirs, from the Apache-2.0 source.** Inference is strictly motion-gated:
detection starts only when the camera's motion sensor fires
(`the reference NVR sources`:213`) and stops
`postMotionAnalysisDuration` (default **20 s**,
`the reference NVR sources`:19`) after motion ends. Between
motion events **nothing is decoded and nothing is inferred**. During a session
the object path requests frames with `fps: undefined` — uncapped; the decoder
runs at native stream rate and the detector consumes via a **single-slot
drop-newest** handoff (frame dropped on the floor if the detector is busy,
`the reference NVR sources`:125`), so effective
inference rate = accelerator throughput. Admission control is fleet-level: a
camera detecting below 7 fps for >30 s is killed to make room
(`the reference NVR sources`:1160`). The software-motion
variant (cameras with no firmware motion) decodes low-res at 4 fps in bursts
and sleeps ~26 s of every 30 s motion window
(`the reference NVR sources`:337`).

**Motion→detection handoff:** the new session asks the prebuffer for history
(`prebuffer: this.model.prebuffer`,
`the reference NVR sources`:350`); open-source models never
set it, so the effective catch-up is the prebuffer's default ≤4 s sync-frame
search (`the reference NVR sources`:927`) — enough to start
the decoder on an IDR *behind* the live edge instead of waiting for the next
one. **This is the mechanism that makes their ephemeral decoders latency-free,
and it matters for Question 3.**

**Detections→tracks: there is no tracker.** The Apache plugin emits stateless
per-frame results (`the reference NVR sources`:646`);
`detectionId` is a 10-s JPEG handle, not a track id; the `movement` state is
produced only by the closed NVR. Continuity is the consumer's problem (the
smart motion sensor latches a boolean with a 60 s timeout,
`the reference NVR sources`:148`).

**Ours, for contrast.** Same gating shape, deliberately: `on-motion` is the
default mode (`packages/types/src/capabilities/pipeline-runner.cap.ts:374`),
sessions are opened by the orchestrator on motion edges and closed by
falling-edge/cooldown/track-presence/2-min-max rules
(`packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts:551`),
an idle on-motion camera holds **no attach at all**
(`packages/addon-pipeline-orchestrator/src/detection-wiring-controller.ts:483`).
In-session we run governed `detectionFps` 10 with a pixel-free admission check
before any materialization
(`packages/addon-pipeline/src/session-decode/session-decode-pump.ts:296`),
frames reach the executor as an in-process `frameRef` (D9/D18), dropout-skip
bridges detector flicker on detector evidence only
(`packages/addon-post-analysis/src/pipeline-analytics/pipeline/dropout-skip.ts:17`),
and a real SORT tracker with time-based coasting builds tracks
(`packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/sort-tracker.ts:16`). <!-- drift-ok: this comparison is dated 2026-08-29, against the old tracker; deleted with it (D683 Task 21) -->

**Verdict: orchestration is not where the gap lives.** Ours is already
converged with theirs (the keep-warm was explicitly modelled on their ~15 s
idle fork timeout, `packages/addon-pipeline/src/pipeline-runner/index.ts:294`),
and where we differ we are mostly *better*: a governor instead of uncapped
fps, a tracker instead of none, pixel-free admission instead of decode-then-drop.
Our ~15 fps fleet-wide at ~100 % inference success is a policy outcome, not a
structural cost — inference is 12 % of one core. What their orchestration does
expose is the decode lifecycle difference (next).

## 3 · Question 3 — the decode path

**Theirs: decoders are ephemeral, and prebuffer replay is what makes that
cheap.** The frame source is created per detection session and destroyed with
it — either an ffmpeg child (`-f image2pipe` to fd 3, killed in `finally`,
`the reference NVR sources`:166`) or a
python-codecs fork (behavioural: forked per session, watchdog hard-exits it
~10 s after the last consumed frame; no licence, so no more detail). Between
motion events there is **zero decode anywhere in the system**. There is no
park, no keep-warm, no pause protocol — and no need for one, because a fresh
decoder joining through the prebuffer is handed the current GOP back to the
last sync frame and starts decoding immediately instead of waiting mid-GOP for
the next IDR.

**Ours: one forked worker per session
(`packages/addon-pipeline/src/session-decode/fork-decode-worker.ts:125`), and a
park that keeps decoding.** D282 measured it: frames advanced in 122/122 park
windows at full source rate, because the child's demux→decode loop
(`packages/addon-pipeline/src/session-decode/decode-worker-child.ts:2085`) is
gated by nothing — the fps cap applies only after decode, in
`packages/addon-pipeline/src/session-decode/frame-slot.ts:120`. ~0.19 core
burned continuously to avoid forks measured at well under 1 core-second, ~25×
net-negative — and the parked worker also keeps its broker restream lease
open, so the most saturated process on the host keeps paying ingest, egress
copy and depacketization for a consumer that discards everything. There is no
pause in `packages/addon-pipeline/src/session-decode/worker-protocol.ts`.

**Position: D282's open choice should be resolved to window→0, because we
already own the mechanism that makes cold forks cheap.** The keep-warm exists
to dodge `firstDecodeMs` 210–1 651 ms — but that latency is the cost of joining
at the live edge mid-GOP, and our broker already serves detection dials a
keyframe-aligned pre-roll burst from `rtpRing`
(`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts:678`).
That is exactly the reference NVR's answer. Kill the worker on detach, let the next
session's dial start on the replayed IDR. The fork itself is not the expensive
part on either stack.

## 4 · Question 4 — CoreML

Facts only (no licence): the plugin wraps Core ML via `coremltools`, loading a
compiled model and calling predict from Python. Its frame handling is a base
class **symlinked from the OpenVINO plugin** — it wants an in-memory image at
model input size produced by the shared pipeline; there is no CVPixelBuffer
path, no VideoToolbox/Vision integration, **no zero-copy from the decoder**.
Every analysed frame still crosses a socket as a raw resized buffer between the
decoder fork and the detector fork. Swapping CoreML for ONNX/OpenVINO changes
nothing above the predict call.

**So: CoreML is an accelerator behind the same frame interface, not an
architecture.** It cannot be the answer to this gap, and on our numbers it has
nothing to accelerate — both inference pools plus audio cost 12 % of one core.
Our co-located `frameRef` handoff is already structurally *better* than their
open-source decoder→detector hop. The operator's instinct to look here can be
retired with confidence.

## 5 · What actually explains the measured gap — ranked

The gap is 336.9 % vs ~105 % total; GC alone (121.6 %) exceeds their entire
media plane's share. Ranking by measured weight and structural evidence:

1. **Per-packet allocation multiplication in `stream-broker` (~95.5 %, 68 %
   GC).** the reference NVR's broker does 1 allocation per packet and shares it with
   every consumer and the ring; ours does the ingest copy **plus** a full copy
   per connected session (§1 accretion 1), **plus** Annex-B depacketization
   nobody consumes (accretion 2), **plus** ~4 tracking objects per NAL, **plus**
   ring-sized bursts on every motion-event join (accretion 4). At ~3 000 pps
   that is order 10⁴ allocations/s sustained where theirs is order 10³ — young-gen
   scavenge pressure is the direct product, and 68 %-of-95 % GC is the bill.
   This is the single largest, best-evidenced component.
2. **Decode that runs when nothing wants frames (decode workers 40–80 %
   each).** Parked workers decode at full source rate (122/122 windows) and
   hold restream leases that feed cost back into item 1. The reference NVR's
   equivalent cost between motion events is zero by construction. In-session
   decode cost is comparable on both stacks; it is the *idle* decode that is
   ours alone.
3. **hub root 79.7 %.** The mediation story — every child↔child hop, tRPC
   JSON, playback proxy on one loop — was diagnosed and planned in the
   2026-08-25 document (its plan item 1). Nothing found in this pass changes
   that diagnosis; it is the second-largest single process and its fix is
   already scoped there. Not re-litigated here.
4. **Retention amplification (RAM, and GC scan cost).** Four rings, two
   encodings of the same media, pre-roll installed fleet-wide whether or not a
   recorder dials, plus probable slab pinning → 883–961 MB `arrayBuffers`
   against ~250–500 MB logical. This is most of the 0.84 vs 0.34 GB per-camera
   RAM gap and a secondary CPU term (larger external-memory graphs to trace).
5. **Explicitly not the explanation:** the model runtime or accelerator (12 %
   of a core; §4), the detection orchestration policy (§2 — converged), the
   tracker (a feature they lack), recording (both stacks stream-copy; their
   raw-append is cheaper at write, paid back at playback).

## 6 · What camstack should adopt

### (a) Apache-2.0 / ISC code we may take

Licence permits lifting, with obligations (Apache-2.0: licence text +
notices + change statements; ISC: notice): the prebuffer replay/fan-out logic
(`the reference NVR sources`), the RTSP parser/server and
sync-frame scan (`the reference NVR sources`), the coarse activity
timer (`the reference NVR sources`), the length-loop reader
(`the reference NVR sources`).

**Recommendation: take none of it verbatim.** Every valuable mechanism already
has a camstack twin (wire-form ring, keyframe marks, paced replay, coarse
watchdog, backpressure kill) — what differs is discipline, not code, and
grafting their files onto our broker would import their idioms without
removing our accretions. Adopt patterns (below); if during implementation any
literal snippet is copied after all, carry the Apache-2.0/ISC attribution with
that file per §0.

### (b) Architectural changes we implement ourselves

1. **Two-write interleave egress.** Delete the per-client packet copy at
   `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:255` (and
   `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts:278`):
   write a small header Buffer and the shared payload as two writes (cork/
   uncork or writev). This removes the one cost class the reference NVR proves
   structurally unnecessary.
2. **Demand-gate the Annex-B plane.** Push `decoderSeedBuffer` — and run the
   depacketizer at all — only when a frame-handle consumer exists
   (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:1693`
   is unguarded today). If the plane is truly a leftover, delete ring and
   plane together instead.
3. **Hoist the join-window early-exit** above the ring `.map()`
   (`packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts:658`
   vs `packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts:676`).
4. **Retention allocation discipline.** Retained ring packets go to unpooled
   allocations (or a per-ring slab), so 10 s survivors stop pinning slabs
   shared with per-millisecond churn. The reference NVR solves this by having no churn
   to interleave; we solve it by segregation.
5. **Scope recording pre-roll to dialed streams** instead of every broker
   (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts:1805`),
   and fix the budget>ceiling inversion (32 MiB budget,
   `packages/addon-pipeline/src/stream-broker/pre-roll.ts:234`, vs 24 MiB
   ring cap, `packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:594`).
6. **Resolve D282 to window→0.** Kill the decode worker on detach; rely on the
   keyframe-aligned pre-roll burst we already serve detection dials for
   instant cold starts (§3). If measured motion-recall regresses, the fallback
   is a real pause verb in
   `packages/addon-pipeline/src/session-decode/worker-protocol.ts` — not a
   longer park.

### (c) Attractive, and wrong for us

- **Raw-RTP recording format.** Reaffirmed from the first pass: write-time
  savings repaid at every playback/export, no standard tooling. Our
  fMP4 + m3u8 chain (`packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts:81`)
  is the better half of our design.
- **One mega media process.** Their prebuffer-mixin does ingest + fan-out +
  recording writes for all 30 cameras in one process; a crash there is a
  total media blackout. D2/D29 exist because we paid for that lesson —
  co-locating our broker with more roles is not on the table.
- **Their cross-process frame hop.** Open-source the reference NVR ships every analysed
  frame as a raw resized buffer over a socket between forks. Our co-located
  `frameRef` (D9/D18) is strictly better; do not regress toward their shape,
  and their closed `decoder: true` monolith is just co-location we already
  have via the `detection` group.
- **Uncapped detection fps and no memory bounds.** Their discipline is
  structural absence (ephemeral forks, one ring); where structure fails they
  have nothing. Keep the governor, keep the V8 caps, keep the byte budgets —
  fixed, per item 5 above.
- **Dropping the tracker.** Their OSS emits stateless detections and leaves
  continuity to consumers. Our tracks, zones and post-analysis are the
  product; the lesson is only that none of it needs to run when no session is
  open — which is already true.

## 7 · Staged plan — cheapest first, each independently shippable

Each stage is measured by `metricsProvider.listNodeProcesses` deltas on the
hub, same 30 cameras, before/after.

| Stage | Change | Measure | Expected |
| --- | --- | --- | --- |
| 1 | Two-write egress (b1) + join-window early exit (b3) | `stream-broker` CPU and GC share | GC 68 % → well under half; removes ~6–9 k allocations/s |
| 2 | Demand-gate seed ring + depacketizer (b2); scope pre-roll + fix budget cap (b5) | `arrayBuffers`, broker CPU | `arrayBuffers` −200–400 MB; depacketizer cost → 0 on non-consuming brokers |
| 3 | Retained-packet slab segregation (b4) | `arrayBuffers` vs computed logical retention | ~900 MB → approaches logical (~300–500 MB); stability preserved |
| 4 | D282 → window 0, pre-roll cold start (b6) | decode-worker fleet CPU, `firstDecodeMs`, per-camera miss rate (`tags: { deviceId }`) | −0.19 core parked decode + broker lease load; `firstDecodeMs` held down by replay, not by heat |
| 5 | Bulk media off hub-main | hub root CPU, viewer `netMs` | Already scoped in the 2026-08-25 plan (item 1); unchanged by this pass |

Stages 1–3 are broker-local, no protocol change, no cap change, deployable as
one addon (`camstack deploy packages/addon-pipeline`) and individually
revertible. Stage 4 touches runner lifecycle only. If stages 1–4 land as
expected, the per-camera CPU gap closes to roughly hub-root mediation plus
in-session decode — i.e. the honest residual is stage 5 plus physics.

## 8 · What could not be determined

- **The reference NVR internals** — recording index, playback remux cost, the
  `movement` track state machine: closed source, absent from the repo.
- **Their production per-camera detection fps** on this host — `fps:
  undefined` means accelerator-bound; measuring it would require touching
  their install, which stayed read-only.
- **The slab-pinning explanation of `arrayBuffers`** is inference from
  allocation sizes and pool semantics; proof needs a heap snapshot of a live
  broker (not taken against production).
- **The 1.5× (25th) vs 5× (today) discrepancy** — different days, the reference NVR
  bursts (its snapshot and third-party plugins), and two camstack fixes landed
  in between; the per-process methodology today is the finer instrument, but
  the two baselines were not taken under identical load and cannot be
  force-reconciled.
- **Unlicensed plugin internals** (python-codecs zygote timings, GStreamer
  pipeline choices, CoreML predict details) are reported behaviourally only,
  by licence discipline — including anything that would have required lifting
  a constant they chose.
