---
id: D472
title: A GC rate is external CHURN gated by RETENTION — and holding a source warm is not asking for its bytes
status: proposed
date: 2026-09-12
supersedes:
covers:
  - packages/system/src/kernel/gc-census.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtp-depacketizer.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts
  - packages/addon-pipeline/src/stream-broker/pre-roll.ts
---

## Context

D469 measured `stream-broker` at **63.3 % of a core, 36.6 % of it V8 background
threads**, and left it unattributed: *"261.6 major GCs/min against one scavenge,
91 MB of JS heap inside 1 035 MB of RSS … that needs the inspector, which needs
a restart."* This record is what could be established without the inspector.

### 1. The premise holds, and it is RETENTION, not accumulation

`hub/stream-broker`'s own `[mem]` line, 24 consecutive heartbeats over two hours
(2026-09-12, 08:50–10:52):

| field | range |
| --- | --- |
| `rss` | 971 – 1084 MB |
| `heapTotal` | 209 – 232 MB |
| `heapUsed` | 73 – 103 MB |
| `external` | 595 – 668 MB |
| `arrayBuffers` | 104 – 663 MB |
| `gc` | maj 627–1542 / min 0–3 / inc == maj, per 300 s |
| `gcPauseMs` | 1604 – 3892 per 300 s |

`external` ≈ `arrayBuffers` to within 5 MB, and `rss − heapTotal` ≈ 834 MB, of
which 643 MB is `external`. The hypothesis in the brief is confirmed: the gap is
ArrayBuffer backing stores.

But the level is **flat for two hours**. This is not a buffer that grows. It is a
live set of ~600 MB that is re-measured at the same size every five minutes.

### 2. The `min0` inference in D469 is WRONG

D469 read `261 majors against ONE scavenge` as *"almost nothing is dying young"*.
It is the reverse: **a major mark-compact collects the young generation too**, so
a high major rate starves the scavenge counter. `min0` is a CONSEQUENCE of the
major rate, and says nothing about object lifetimes.

Reproduced on this laptop (Node v24.17.0 — the hub runs v24.20.0),
`--max-old-space-size=1216`, 15 s windows, churn = fresh 1400-byte
`Buffer.allocUnsafeSlow` at a fixed MB/s, `hold` = the same buffers kept alive in
an array:

**Retention sweep, churn fixed at 60 MB/s**

| held external | majors/min | scavenges |
| --- | --- | --- |
| 0 MB | **0** | **118** |
| 32 MB | 28 | 24 |
| 64 MB | 80 | 11 |
| 128 MB | 76 | 6 |
| 256 MB | 84 | 6 |
| 600 MB | 100 | 6 |

Identical allocation behaviour, identical object lifetimes. At zero retention it
is 0 majors and 118 scavenges; at 600 MB it is 100 majors and 6 scavenges. The
counters invert with the RETAINED BASELINE, not with what dies young.

The live fleet supplies the control: `agent-a/stream-broker` and
`MacMiniAgent.localdomain/stream-broker` run the same build with
`external=5MB` and report **0.6–1.0 majors/min**. Same code, 300x less GC,
because they retain nothing.

### 3. The rate is CHURN, gated by retention

**Churn sweep, retention fixed at 600 MB**

| churn | majors/min |
| --- | --- |
| 5 MB/s | 44 |
| 20 MB/s | 64 |
| 60 MB/s | 96 |
| 140 MB/s | 164 |
| 280 MB/s | 276 |

Linear: `majors/min ≈ 40 + 0.84 × churnMBps`. Once the retained baseline opens
the gate, V8 runs a full mark-compact roughly every 60 MB of external
allocation — and each one marks the whole live set on the platform workers,
which is the 36.6 % D469 measured.

So the `[mem]` line ALREADY carries the allocation rate; D469 just had no
calibration to read it with. Inverting the fit on the observed 125–308
majors/min puts `hub/stream-broker`'s external allocation at roughly
**100–320 MB/s, median ~270 MB/s**. Order of magnitude only: different machine,
different Node patch, different live-set size.

### 4. What that rate is NOT explained by

Fleet media ingest is ~24 main + ~23 sub streaming brokers (`listAllProfileSlots`,
47 with `status: streaming`; 32 `high` slots at `preBufferSec: 5`). At the
bitrates D381 measured on this hub (1.7 / 5.1 / 8.0 Mbps) that is **13–25 MB/s
of actual media**. Against ~270 MB/s of external allocation that is roughly a
**10x amplification** — the same shape D458 found for moleculer's TCP path (42x),
in a process that does not use it.

### 5. The retained 600 MB is NOT a leak

Attribution against the declared budgets, for 47 streaming brokers:

| structure | sizing | fleet estimate |
| --- | --- | --- |
| `rtpRing` pre-roll (`pre-roll.ts`) | 5 s × bitrate × 1.5 headroom + current GOP, cap 24 MiB/broker | **~290 MB** |
| `RtspRestreamer` keyframe caches | 2 × 16 MiB cap/broker, one GOP steady | ~70 MB |
| `clipBuffer` | 25 s Annex-B, cheapest profile per device, **no byte cap** | ~75 MB |
| `ScrubFragmentCache` | 48 MiB per WebRTC timeline session | ≤150 MB |
| `EventMediaStore` | 64 MiB, process-wide | ≤64 MB |
| socket write backlogs | 2 MiB per RTSP session / pipe client | ~50 MB |

That sums to the observed 600 MB. Every one of those budgets was individually
reasonable; the total is what nobody costed. **Cutting it to below the gate
(~64 MB) is not reachable** — it would mean giving up the join bootstrap, the
pre-roll window and the notification clip. Retention is therefore the wrong
lever, and raising `heapLimit` to move V8's gate is the pezza this repo already
forbids.

### 6. The one defect actually found

`StreamBroker.onEncodedData()` is the channel for "deliver me Annex-B packets".
It is ALSO the channel three call sites use to mean "keep this source dialed":

- `stream-broker-manager.ts:4345` — `probeStream`, `kind: 'warmup'`
- `stream-broker-manager.ts:4642` — profile restreamer warm-up, `() => {}`
- `stream-broker-manager.ts:6546` — RTSP restreamer warm-up, `() => {}`

The third is on every RTSP restream session, and the shipped detection path is
PULL mode off that restream (`docs/design/decode-path.md`) — so on this hub it is
connected essentially always, on every main stream. The logs show it cycling
hard: 106 connect/disconnect pairs in 30 minutes on `104/native:main` alone.

Consequently `encodedCallbacks.size > 0` on every warm main stream, and
`onVideoRtp` runs `rtpDepacketizer.processPacket()` unconditionally, allocating a
fresh Annex-B buffer for **every NAL of every stream** — while the actual Annex-B
consumers on a main stream are absent: `preBuffer` is skipped for RTP sources,
`clipBuffer` lives on the cheapest profile (the sub stream), `rtspRestreamer`
is in `rtpPassthroughMode`, and `decoderSeedBuffer`/`frameHandlePlane` were
already demand-gated 40 lines below for exactly this reason. The bytes are built
at full bitrate and handed to `() => {}`.

This is D391's rule — *a branch that ACCEPTS work and produces nothing is the
same branch* — and it is the same failure the `decoderSeedBuffer` gate fixed:
*"Unguarded, every broker on the fleet retained SIX SECONDS of full-bitrate
Annex-B for a consumer that is never constructed."*

It is worth ~1x the fleet media rate, ~13–25 MB/s. It is **not** the whole 10x.

## Decision

**Holding a source warm is a different request from asking for its bytes, and the
broker must be able to tell them apart.** A caller that only needs the camera
dialed takes a warmth lease; `onEncodedData` means "I will read these packets".
A no-op callback passed to `onEncodedData` is forbidden — it makes the broker's
own demand signal unreadable and buys a full Annex-B copy of the stream at
frame-rate.

**And a GC rate is never read as a level.** `gcMajPerMin` on the `[mem]` line is a
measure of EXTERNAL ALLOCATION RATE once the retained baseline exceeds ~64 MB,
at roughly one major per 60 MB allocated; below that baseline the same allocation
rate produces zero majors and the counter says nothing. A scavenge count near
zero next to a high major count is an ARTEFACT of the major rate and must never
be read as evidence about object lifetimes.

## Consequences

- Three call sites must migrate off `onEncodedData(() => {})` to a warmth lease
  before any Annex-B demand gate can be correct. Gating on
  `encodedCallbacks.size` today would be a no-op, because the warm-up holders
  keep it non-zero.
- The Annex-B gate cannot simply skip `rtpDepacketizer.processPacket()`:
  `_lastNalKeyframe` / `_lastNalParamSet` are set there and are required by
  `pushRtpPassthrough` and `captureRtpForPreBuffer`. Skipping it would break the
  join bootstrap on every camera. The gate needs a flags-only mode in the
  depacketizer that parses NAL headers without `copyIntoAnnexB` and without the
  FU-A `fuBuffer` concat.
- Retention is explicitly NOT the lever. Anyone who proposes shrinking
  `DEFAULT_PREBUFFER_SEC`, `CLIP_RETENTION_SEC` or `SCRUB_FRAGMENT_CACHE_MB` to
  fix the GC rate is trading a feature for nothing: the gate opens at ~64 MB and
  the reachable floor is several hundred.
- **~90 % of the 10x amplification is still unattributed.** It is not the
  restreamer's interleaved write (already reference-shared), not the Annex-B
  weld (already zero-copy on non-keyframes), and not the depacketizer's per-NAL
  buffer alone. Closing it needs a per-callsite allocation census inside the
  running process.

## What could not be verified

- **Function-level attribution.** Node's inspector is a singleton on
  `process.debugPort`; hub-main holds 9229 inside the container and will not
  release it without a container restart (D469). No CPU or allocation profile of
  `stream-broker` was possible. **A container restart is required to finish this
  — the operator decides, not this session.**
- **Live per-broker consumer counts.** `scripts/hub/hub.mjs` began returning 401
  mid-session, after `listAllCameraStreams` (109 rows) and `listAllProfileSlots`
  (96 rows, 47 streaming) were captured but before `getBrokerStats` could be read.
  So `encodedSubscribers`, `pipeClients`, `preBufferPackets` and `bitrateKbps`
  per broker are ESTIMATES from the code and from D381's measured bitrates, not
  readings. Re-authentication is the operator's (see the auth-recovery note).
- The 100–320 MB/s churn figure is a calibration transfer between two machines
  and two Node patch versions. It is an order of magnitude, not a measurement.

## Enforcement

Nothing yet, review only — and that is the honest state. The guard that belongs
here is a lint over `packages/addon-pipeline/src/stream-broker/**` forbidding
`onEncodedData` with an empty-bodied callback, and it cannot be armed until the
three warm-up sites migrate. Until then this record is the only thing standing
between the next session and re-deriving §2 and §3 from scratch.
