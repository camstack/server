---
id: D450
title: The audio plane carries the source rate, the one consumer that needs more resamples next to itself, and a window that changes format under a relay is dropped and named
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/audio-rtp-decoder.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-pipeline.ts
  - packages/addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts
  - packages/addon-pipeline-orchestrator/src/audio-subscription-controller.ts
last-verified: 2026-09-27
---

## Context

D446 priced the decoded-audio plane at **340 of the ~470 MB/min** hub-main
moves over UDS — broker → hub → orchestrator → hub → analyzer, ~85 MB/min
per leg — and D448 named the multiplier: `AudioRtpDecoder` took the fleet's
G.711 (8 kHz, one byte per sample) and emitted **16 kHz f32le**, eight times
the source bytes, "to match the ffmpeg path", before the first byte entered
the transport. The comment at the top of that file said the upsample existed
so that "downstream consumers (audio-classifier, VAD) receive identical
data". So the first question of this record was who those consumers are.

**Who consumes the plane, traced.** `AudioChunkPlane.fanout` has exactly one
subscriber on the fleet: the orchestrator's `AudioChunkPoller` (tag
`audio-analyzer`), which feeds `AudioWindowAccumulator` and calls
`audioAnalyzer.analyseChunk` once per ~1 s window. Nothing else reads the
decoder's output: for a native G.711 camera the WebRTC PCMU egress forwards
the RTP payload untouched (`onAudioRtp`, `fanOutEncoded`), the Opus egress
decodes μ-law itself at 8 kHz (`feedOpusEncoder`), and the RTSP restreamer
passes the RTP through. The 16 kHz decoder output went to the chunk plane and
nowhere else — the only path that crosses hub-main was the only path that
carried the expansion.

**What the analyzer needs.** `analyseChunk` meters RMS/dBFS over whatever
samples arrive (rate-agnostic), then `classify` hands the window to the
pipeline; both `YamnetPythonPipeline.classify` and
`AppleSoundAnalysisPipeline.classify` already do
`chunk.sampleRate === 16000 && chunk.channels === 1 ? chunk.data :
resampleMono16k(chunk)`. The classifier's 16 kHz is a real constraint
(YAMNet is spawned with `--sample-rate=16000`), and the resample already lived
next to the model — the same linear interpolation the decoder did per RTP
packet, done once over a whole window. The source-side upsample was not
serving a consumer; it was duplicating one.

**The fleet's shape** (Loki, 12 h): 19 native PCMU cameras through
`AudioRtpDecoder`, 5–7 AAC cameras through the codec session (`decoder-nodeav`,
`targetSampleRate: 16000`, feeding the PCMU egress downsample and the Opus
egress as well as the plane). ~79 % of the plane's bytes were G.711.

**The transition hazard.** A broker redeploy flips the rate of a live
subscription. `AudioWindowAccumulator` anchored a window to its FIRST chunk's
`sampleRate` and appended bytes until the duration target: a window opened
at 16 kHz and finished at 8 kHz would have been sent to the classifier
labelled 16 kHz with half its bytes at the other rate — one garbage second
per camera, and not one line saying so. That is the D427 failure in a new
place: a relay's audio decision made silently.

**Rejected here, and priced.** Carrying s16le or the raw G.711 codes would
take the G.711 legs 4× / 8× below the 16 kHz baseline instead of 2×, but it
needs a `format` field on `DecodedAudioChunk` and `AudioChunkInput`
(`@camstack/types`), and a consumer that does not know the field reads s16le
bytes as f32le and reports a level of +43 dBFS — silently. The two
consumers deploy from two packages (`addon-pipeline-orchestrator`,
`addon-pipeline`) and the analyzer runs on three nodes, so the skew is real.
The safe shape is negotiation at `subscribeAudioChunks` (`accept: ['s16le']`,
absent → f32le, the D448 `rawForward` pattern) with the conversion in the
ORCHESTRATOR so the analyzer keeps receiving f32le; that halves two legs
again for ~20 MB/min more and is not worth a second hot deploy of the big
bundle today. It stays available.

**It was taken, on 2026-09-18, in exactly this shape** — D455. The skew
worry above was answered by the `accept` negotiation rather than by a version
gate, and `AudioWindowAccumulator` expands at the FLUSH, so the analyzer cap's
`AudioChunkInput` never changed and no analyzer from any bundle is handed bytes
it cannot read. Measured at 11.57 µs per one-second window against the 12.31 µs
the decoder used to pay: moved, not added.

## Decision

1. **The audio chunk plane carries the source rate.** `AudioRtpDecoder`
   emits 8 kHz mono — and `sampleRate` on every chunk is the
   contract. A consumer that assumes a rate instead of reading the field is
   the bug.

   !!! warning "The format half of this clause was superseded on 2026-09-18"

       As shipped, this record left the FORMAT at f32le: the decoder still
       turned each G.711 byte into a 4-byte sample before the transport, so all
       four legs still carried 4× the source. The "Rejected here, and priced"
       paragraph below is the option that was deferred that day and it did
       ship — as
       [D455](adr-0455-the-audio-plane-carries-the-source-bytes-and-only-to-a-consumer-that-declared-it-reads-them.md).
       `AudioRtpDecoder` now buffers the CODED payload
       (`format: 'pcmu' | 'pcma'`, one byte per sample, 4000 bytes per 500 ms
       chunk) and whoever needs floats expands next to itself
       (`expandAudioChunkToF32le`). What makes that safe across three analyzer
       nodes is the thing this record correctly identified as the requirement:
       negotiation. `subscribeAudioChunks` takes `accept`, and the plane serves
       a coded window ONLY to a subscription that named that format; absence
       still means f32le, byte for byte what every consumer received before.

   The codec session (AAC/Opus) keeps `targetSampleRate: 16000`
   because its PCM also feeds the live Opus egress, where 8 kHz would be an
   audible loss for the viewer; that is a different consumer with a different
   need.

2. **The one consumer that needs 16 kHz mono resamples next to itself.**
   `resampleMono16k` in `audio-pipeline.ts` is the one place a window is
   brought to the classifier's rate; it is exported so the guard can pin it.
   The level meter runs on the source samples.

3. **A window has one format, and every format is reported.**
   `AudioWindowAccumulator` drops a partial window whose next chunk carries
   a different `sampleRate` or `channels`, and reports the first format and
   every change through `onFormat`; the controller writes
   `audio stream delivering` (info) on the first and `audio stream format
   changed — partial window dropped` (warn, with `droppedMs`) on a change,
   both with `tags: { deviceId }`. The analyzer writes `audio window format`
   once per device and on every change, with `classifierResamples` saying
   whether the window is native to the model. The broker's `native: audio
   decoder initialized` line carries `planeSampleRate` and `planeFormat`.

## Consequences

- **Deployed 2026-09-11** as `@camstack/addon-pipeline-orchestrator@1.2.182`
  at 08:55:17Z (first, so the guard is live before the rate flips) and
  `@camstack/addon-pipeline@1.2.219` at 08:56:01Z, both hot, hub healthy
  after each; nine `Audio analysis failed: channel closed` at the instant of
  the analyzer respawn and nothing after. Within the first minute: 19 brokers
  reported `planeSampleRate: 8000`; the orchestrator logged 18 subscriptions
  delivering 8 kHz and 4 at 16 kHz (the AAC cameras); the analyzer reported 18
  devices resampling and 4 native. The subscriptions were re-created by the
  broker restart rather than flipped under an open window, so the drop path
  did not fire on this deploy; it exists for the next one.
- **Measured on the `[mem] hub-main` line** (`socketTop=` per-peer kB per
  60 s window, medians over 30 min before and TODO-MEASURE-N min after):
  TODO-MEASURE-TABLE
- The level reported for a G.711 camera is now the RMS of the 8 kHz samples,
  not of the interpolated 16 kHz ones. A midpoint-interpolated stream has
  slightly LESS energy in its upper band, so dBFS moves up by a fraction of a
  dB on high-frequency content; nothing reads the level at that precision.
- `docs/design/2026-08-28-tts-stt-capabilities.md` §"STT input" assumed every
  broker decode session targets 16 kHz mono. An STT consumer of the chunk
  plane now reads `sampleRate` and resamples if it needs to — the same
  discipline as the classifier.
- The relay leg (analyzer pulls from the broker under `attachDevice` /
  `detachDevice`, D441 option 2 / D448) is re-priced in
  (planning repo: sessions/sessions.md) under this date from the after-numbers, not the <!-- drift-ok: moved to the private planning repo -->
  before-numbers.

## Enforcement

`audio-rtp-decoder.spec.ts` (the source rate, the byte count, one sample
per byte with no midpoints), `audio-window-accumulator.spec.ts` (the first
format reported once, a change under an open window dropped and reported
with `droppedMs`, a change between windows reported with nothing dropped,
channels are a format), `audio-window-format.spec.ts` (`resampleMono16k`
doubles with midpoints and folds stereo; the level is metered on the source
samples and the classifier receives the source rate; the format line once
per device, again on change, `classifierResamples` true at 8 kHz and false
at 16 kHz mono). Each guard disarmed and the suite re-run:

| disarmed | red |
| --- | --- |
| the decoder interpolates a midpoint after every sample again | 3 of 10 |
| the decoder labels its chunks 16 kHz | 4 of 10 |
| the accumulator keeps the partial window across a format change | 1 of 5 |
| the accumulator never reports a format | 4 of 5 |
| the analyzer stops reporting the window format | 2 of 5 |
