---
title: the reference NVR vs CamStack — comparative media-plane architecture, measured on the same host
last-verified: 2026-08-25
covers:
  - packages/addon-pipeline/src/stream-broker/stream-broker/encoded-ring-buffer.ts
  - packages/addon-pipeline/src/recorder/segment-store.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
---

# the reference NVR vs CamStack — comparative media-plane architecture

Both NVRs run on the SAME Unraid host (Core Ultra 7 265K, 62 GiB), against the
same cameras. This document records measured numbers from 2026-08-25, the
mechanism-by-mechanism comparison (grounded in the reference NVR's public source,
`github.com/koush/the reference NVR`, fetched same day), which of our prior assumptions
the measurements destroyed, and an ordered plan of what to borrow.

**the reference NVR is production and was observed strictly read-only** (docker
stats/top, /proc, its public code). Nothing was restarted, configured or called.

## 0. Corrections to the going-in assumptions (read these first)

1. **"Their bytes live in ffmpeg, ours in Node" is FALSE — inverted, even.**
   The reference NVR's media plane is MORE in-JS than ours: ingest is a pure-JS
   `RtspClient` (`common/src/rtsp-server.ts`) with **no ffmpeg at all** on the
   happy path; the 10 s prebuffer is an array of RTP `Buffer`s in the
   rebroadcast plugin's Node heap; recording appends that raw RTP to disk from
   the same JS process; WebRTC is werift, SRTP in JS per packet. Their biggest
   single process is the media one: prebuffer-mixin at **2.48 GiB RSS** —
   larger than our stream-broker (1.5 GiB). The structural difference is NOT
   JS-vs-native. It is **how many times the bytes are re-handled, and who
   mediates**.
2. **The CPU gap is real but half the claimed size.** 8 samples over 30 s:
   CamStack ≈ **556 %** avg (peaks 837), the reference NVR ≈ **374 %** avg (peaks 440).
   The earlier 507-vs-252 snapshot caught the reference NVR in a trough — it bursts too
   (snapshot plugin 35 %, the operator's own advanced-notifier plugin 51 %).
   Ratio ≈ 1.5×, not 2×.
3. **The host itself is oversubscribed**: load average **35 on 20 cores** with
   both NVRs plus ~30 other containers. Some share of the viewer's 16 s
   container stalls is host run-queue contention, which hits both stacks.
4. **Where our extra ~5–7 GiB actually is** (it is NOT the rings, and NOT the
   recording index — the reference NVR's NVR process is the same ~1.7 GiB as our
   recorder runner):
   - **hub-main ≈ 5.0–5.2 GiB RssAnon** vs the reference NVR's server at 0.6 GiB → **+4.5 GiB**.
   - **the idle runner tail: ~25 runners × 105–190 MB ≈ 3.4 GiB** vs their
     idle-plugin tail at 35–110 MB each ≈ 1.5 GiB → **+1.9 GiB**.

## 1. Measured inventory (2026-08-25, ~50 min after CamStack restart)

### Container level (8 × 4 s samples)

| | CamStack | the reference NVR |
|---|---|---|
| CPU avg / peak | 556 % / 837 % | 374 % / 440 % |
| Memory | 16.6–18.9 GiB (cap 24, regime ~21) | 11.5–12.0 GiB (no cap) |
| Load carried | 30 cams, continuous detection + recording | ~30 recorded streams (3 × ~10 cams), motion-gated detection |

### CamStack per process (`metricsProvider.listNodeProcesses` + /proc)

| Process | RSS | CPU (30 s window / spot) | Notes |
|---|---|---|---|
| hub-main (`starter.js`) | 3.79 GiB @11 min → **5.2 GiB @40 min**, plateau ~5.0 | bursty 14–105 % | RssAnon 5.15 GiB — over the default V8 old-space cap ⇒ mostly **external Buffers/churn**, not JS objects |
| runner:stream-broker | 1.45→1.52 GiB | **72–75 %** | 47 `EncodedRingBuffer`s (10 s/stream) ≈ 970 MB + WebRTC + RTSP restream to 16 local consumers |
| runner:recorder | 1.07→**1.87 GiB** (cap 3072) | ~30 % | `RecordingIndex` in heap: 5–6 M `SegmentRow` ≈ 1.3 GiB; ~6 segment finalizations/s fleet-wide (10 s segments × ~60 streams) |
| runner:pipeline-analytics | 660 MB | ~20 % | post-analysis bundle (zones, galleries, videoclips) |
| decode-worker-child (×1–2) | ~770 MB each | 3–18 % | long-lived session-decode children |
| runner:sqlite-settings | 569 MB | 9 % | |
| runner:provider-reolink | 454 MB | 11 % | |
| **idle tail: ~25 runners** | **105–190 MB each ≈ 3.4 GiB** | <1 % each | providers (tuya, petkit, dreo…), notifiers, mqtt, terminal, auth, admin-ui |
| 18 × ffmpeg segmenters | 50–70 MB each | 0.6–1 % each | `-c copy` remux + opus audio re-encode, fed from **rtsp://127.0.0.1:8554** |
| 2 × ffmpeg libx264 egress | ~100 MB | ~11 % each | 640×360 transcode (`acquireEgressTranscode`) |
| python (inference_pool ×2, yamnet) | 335+126+87 MB | 0.6–4 % | inference itself rides GPU/NPU — cheap on CPU |

### the reference NVR per process

| Process | RSS | CPU | Notes |
|---|---|---|---|
| prebuffer-mixin | **2.48 GiB** | 69–75 % | THE media process: JS RTSP ingest ×30, 10 s prebuffer in heap, fan-out, recording writes |
| `the reference plugin` (server) | 602 MB | 35–80 % | control plane + RPC brokering only |
| @the reference NVR/nvr (+fork) | 1.6 GiB + 140 MB | 8–18 % | index in LevelDB (`the reference NVR.db`) + per-segment `.json` sidecars on disk |
| openvino (python) | 1.58 GiB | ~3 % | models resident, inference sparse (motion-gated) |
| objectdetector | 636 MB | ~3.5 % | |
| snapshot | 504 MB | 17–35 % | |
| advanced-notifier (operator plugin) | 430 MB | 38–51 % | biggest third-party CPU consumer |
| idle tail ~30 plugins | 35–110 MB each ≈ 1.5 GiB | ~0 % | |
| ffmpeg | 0–3 transient | — | snapshots only; **zero per-camera ffmpeg** |

Recording on disk (observed): `/Volumes/NVR/`the reference plugin`*/…/<ts>.rtsp` ≈ 30 MB
per ~6 min per stream, one small `.json` sidecar each; three variants per
camera (`<id>`, `.remote`, `.low-resolution`) — the "3 streams per camera".

## 2. Mechanism table — where the bytes live, who copies them, who keeps them alive

| Mechanism | CamStack | the reference NVR (public code) |
|---|---|---|
| Ingest | broker per stream: RTP parse in JS (`stream-broker.ts`, `source-parser.ts`) | `RtspClient` pure JS in prebuffer-mixin; ffmpeg only as protocol adapter for odd sources (`-c copy` back into the same JS parser) |
| Prebuffer | `EncodedRingBuffer`, 10 s default, JS heap of broker runner (47 rings ≈ 970 MB) | `rtspPrebuffer: StreamChunk[]`, fixed 10 s, JS heap of prebuffer-mixin (≈2.5 GiB total) |
| Fan-out | RTSP restream :8554 — JS re-packetizes per consumer (16 local consumers incl. our own recorders) + WebRTC + paced GOP replay | same Buffer objects written to N consumer sockets (copy at kernel `write`, not in JS); 100 MB `writableLength` kill-switch per consumer |
| Recording write | broker → **RTSP loop → 18 × ffmpeg remux** (fMP4 10 s segments, opus audio re-encode) → staging → stat+move+index | NVR issues RTSP `WRITE` (`FileRtspServer`) → prebuffer-mixin **appends raw interleaved RTP to an `fs.WriteStream`** — zero extra hops, zero remux, zero ffmpeg |
| Recording index | `RecordingIndex` **in recorder heap**: 5–6 M rows ≈ 1.3 GiB; 10 s granularity ⇒ ~6 finalize/s churn | LevelDB + per-segment JSON sidecars **on disk**; ~6 min segments ⇒ ~36× fewer entries, one rotation/6 min/stream |
| Playback | recorder `ctx.dataPlane` listener, hub-main **proxies every byte** (`/addon/:addonId/*`, `reply.hijack()` + pipe — streaming, but on hub-main's loop) | closed source (unverified); remux from raw RTP must happen at read time — their write-time saving is paid at playback |
| Detection decode | long-lived decode-worker children (~770 MB each), continuous session decode; frameRef in-process (D9) | **ephemeral zygote forks** (python-codecs, GStreamer/PyAV): exit ~1 s after the session, RSS returned to OS; decode motion-gated, low-res, ≤4 fps; `Queue(1)` drops frames at the decoder |
| Frame → detector hop | in-process `FrameRef` (detection group) — zero-copy, better than theirs | resize-to-model-input inside the codec fork, ~300 KB tensor over a **direct socket between plugin processes** (`connectRPCObject` — bypasses the server) |
| Thumbnails / event media | **base64 inside tRPC JSON** (`events.getEventThumbnail`…), MsgPack over UDS **through hub-main**, then JSON-stringified on hub-main's loop | raw sideband Buffers (length-prefixed frames, `SidebandBufferSerializer`); base64 is a warned fallback; sockets passed as OS handles |
| Cross-component RPC (bulk) | child↔child cap calls transit the hub-main parent router (decode + re-encode per hop, `local-child-registry.ts` `cap-call-out`) | `connectRPCObject` upgrades a proxy to a direct P2P socket; the server never touches frame-rate media |
| WebRTC | werift in broker runner, SRTP in JS | werift in a per-viewer zygote fork, SRTP in JS — same cost, better isolation, worse per-viewer overhead |
| Process baseline | addon-runner ≈ **105–190 MB idle** (post barrel-fix, with `--max-semi-space-size=2`) | node plugin ≈ **35–110 MB idle** |
| Memory bounds | V8 caps being rolled out (1024/3072 old-space) | **none anywhere** — discipline is structural: ephemeral forks, time-bounded prebuffer, 100 MB socket kill-switches, decode-side frame dropping |

## 3. Why the viewer is slow — verdict

Client-side is proven idle (`blockedMs`/`parseMs`/`maxLagMs` = 0; `netMs` ≈ 4 s).
Three server-side causes, in estimated order of weight:

1. **hub-main is a single event loop that mediates everything**: all tRPC JSON
   (including base64 media), every child↔child UDS hop (MsgPack decode +
   re-encode), the playback byte proxy, plus all registries. Its CPU is bursty
   (14 % quiet → 105 % under load): the viewer's 4 s `netMs` is head-of-line
   blocking behind whatever batch is being serialized. The reference NVR's server loop
   carries control-plane only; bulk bytes go plugin↔plugin or plugin→client.
2. **Memory pressure near the 24 GiB cap** (regime ~21): page-cache eviction
   makes every recorder/segment read a real disk read, and 5 GiB of external
   Buffer churn in hub-main adds allocator/GC stalls.
3. **Host oversubscription** (load 35/20 cores) — affects both stacks; some of
   the 16 s container stalls are not ours to fix in-process.

## 4. Plan — what to borrow, ordered by benefit/risk

1. **Take bulk media off hub-main's loop.** (a) Serve event/track media and
   scrub thumbnails from the owning runner via the existing `ctx.dataPlane`
   HTTP primitive (URLs in tRPC responses instead of base64 bodies); (b) give
   bulk child↔child cap payloads a direct-socket path (our `connectRPCObject`
   equivalent: hub brokers a one-time token + UDS path, runners talk
   point-to-point). Est. gain on our numbers: −2–4 GiB hub-main churn, the
   dominant share of viewer `netMs`. Risk: **low-medium** — the data-plane
   primitive and its auth already exist (recorder playback uses it today).
2. **Shorten the recording chain.** Feed each segmenter ffmpeg via stdin pipe
   from the broker (drop the 18 loopback RTSP sessions and their per-consumer
   JS re-packetization), and **raise segment duration 10 s → 60 s+**: index
   rows −6×–36×, finalize churn from 6/s toward 0.1/s, recorder heap 1.3 GiB →
   ~0.2 GiB. Keep fMP4 — do NOT copy their raw-RTP format. Est. gain: ~1 GiB
   + 50–100 % CPU across broker/recorder/ffmpeg fleet. Risk: **medium**
   (durable state; migrate one camera first, scrub granularity must come from
   keyframe index, not segment boundaries).
3. **Ephemeral decode workers (zygote pattern).** Decode-worker children are
   long-lived at ~770 MB; the reference NVR's codec forks exit ~1 s after each session
   and return RSS to the OS. Give session-decode workers a bounded idle
   lifetime + pre-spawned zygote for instant restart. Est. gain: ~1–1.5 GiB at
   regime. Risk: **low** — worker lifecycle already exists.
4. **Shrink the idle tail.** ~25 near-idle runners ≈ 3.4 GiB. Two levers:
   baseline diet (lazy-load heavy graphs — the barrel-leak fix showed the
   shape) and extending the D29 `ml`-group policy to more non-live, frame-free,
   low-crash addons (never device providers, per D29). Target: 3.4 → ~1.5 GiB.
   Risk: **medium** (co-located crash blast radius — respect D29's exclusions).
5. **Adopt their backpressure kill-switches.** A hard bound (theirs: 100 MB
   `writableLength`) on every fan-out socket and media write stream, killing
   the consumer, not the source. Est. gain: removes an OOM class, near-zero
   cost. Risk: **minimal**. Keep our V8 caps (in flight) — their *absence* of
   caps is a weakness (2.5 GiB unbounded prebuffer), not a model.

Optional knob, operator decision: the reference NVR's detection is **motion-gated at
≤4 fps on the low-res stream**; our continuous session decode is a real share
of the CPU delta. A per-camera "gated" detection mode would close most of the
remaining CPU gap at the cost of detection latency/recall.

**Do not copy**: the raw-RTP `.rtsp` recording format (write-time savings paid
at every playback/export, proprietary, no standard tooling — our fMP4+m3u8 is
the better half of our design); per-viewer WebRTC process forks; running
without memory caps; the closed NVR monolith coupling.

## 5. Open questions / measures not taken

- The reference NVR playback/remux internals are closed source — unverified.
- Exact hub-main heap-vs-external split needs an inspector snapshot (not taken:
  would perturb production-adjacent load; V8-cap work was in flight in a
  parallel session on `process-service.ts`).
- The 2 permanent libx264 egress transcodes (~22 % CPU) deserve a consumer
  audit (who holds them, and is `pull-http` MJPEG still among them — see
  data-planes.md on the glances relay).
