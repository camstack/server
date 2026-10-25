---
id: D455
title: The audio plane carries the source bytes, a coded window reaches only a consumer that declared it reads them, and the expansion happens once at the flush
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/types/src/audio/audio-chunk-format.ts
  - packages/types/src/capabilities/schemas/streaming-shared.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/audio-rtp-decoder.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/audio-chunk-plane.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-chunk-poller.ts
  - scripts/bench-audio-g711-expand.mts
last-verified: 2026-10-02
---

## Context

D450 took the audio chunk plane off its 8 → 16 kHz upsample: the plane carries
the source RATE and the one consumer that needs 16 kHz resamples next to the
model. It left the FORMAT alone. `AudioRtpDecoder` still turned each G.711 byte
into a 4-byte f32le sample **before the first byte entered the transport**, so
every leg of a plane that crosses hub-main four times carried four times the
source: 37 KB per one-second window, **49 MB/min on the analyzer leg alone**
against hub-main's 311 MB/min total. In aggregate the audio plane, spread over
three peers (`pipeline-orchestrator` 110.2, `stream-broker` 69.6,
`audio-analyzer` 48.6 MB/min), is the largest single item on the socket plane.

D450 had already priced this option and declined it for the day, naming the
exact hazard: `AudioChunkInput` is f32le by contract, its two consumers deploy
from two different packages, **and the analyzer runs on three nodes** — so a
consumer that does not know about a `format` field reads coded bytes as floats
and reports +43 dBFS, silently. That is the D427 failure with a new cause.

**Who consumes the plane, re-traced against the files.** `AudioChunkPlane.fanout`
still has exactly one subscriber: the orchestrator's `AudioChunkPoller` (tag
`audio-analyzer`) → `AudioWindowAccumulator` → `audioAnalyzer.analyseChunk`.
For a native G.711 camera nothing else reads `AudioRtpDecoder`'s output —
`onAudioRtp` forwards the RTP payload to the encoded fan-out and to the RTSP
restreamer untouched, and the live Opus egress decodes μ-law **from the RTP
payload on its own path** (`stream-broker.ts`, the `opusConsumerCount > 0`
branch), not from the decoder. The AAC cameras go through
`AudioCodecSession`, whose `buildAudioCodecEmitCallback` fans one f32le chunk
to the plane AND in-process to the PCMU/Opus egress; that chunk never crosses
a process boundary as PCM and is not this record's business. So the ONLY path
that crossed hub-main was the only path carrying the expansion — again.

**What the expansion costs where it does not happen today.**
`scripts/bench-audio-g711-expand.mts`, best of 5 rounds over 20 000 one-second
windows, output asserted identical sample by sample:

| shape | per 1 s window of one camera |
| --- | --- |
| A — expand per RTP packet (what the broker does today) | 12.31 µs |
| B — expand the whole window (what a consumer does) | 11.57 µs |
| C — copy the coded bytes (the accumulator's append) | 1.60 µs |
| D — allocate the `Float32Array` alone (the floor) | 1.85 µs |
| msgpack encode+decode, f32le window (32 044 B) | 6.45 µs |
| msgpack encode+decode, coded window (8 056 B) | 3.72 µs |

The expansion is **moved, not added**: B − A is −1 ms/min across 22 cameras.
In absolute terms it is 15 ms/min of one core for the whole fleet, 0.025 %.

**The first run of that bench said B cost twice A** — identical work, 24.3 µs
against 12.3 µs — and the tidy story was right there (batching a table lookup
is worse for cache locality). It was the measurement: one pass, fixed order, B
paying for A's garbage. Best-of-5 with an alloc-only floor collapsed the gap to
nothing. This is the D454 failure mode inside a bench written the same day.

**A thing found while moving the table, which this record does NOT fix.** The
shipped μ-law/A-law magnitude is `((2m + 33) << e) - 33`, one quarter of ITU-T
G.711's `((m << 3) + 132) << e) - 132`: the table's extremes are ±0.2451, not
±0.98. Every native G.711 camera on the fleet has been metered ~12 dB low since
the native decoder shipped, and every configured audio threshold is calibrated
against that. The table is carried here **verbatim**, and the value is pinned in
a test, because correcting it is a fleet-wide re-calibration and a different
decision.

## Decision

**The audio chunk plane carries the source BYTES, and a coded window reaches
only a consumer that declared it can read them.**

1. **`AudioRtpDecoder` decodes nothing.** It strips the RTP header and buffers
   the coded payload into ~0.5 s chunks: `format: 'pcmu' | 'pcma'`, 8 kHz mono,
   one byte per sample, 4000 bytes per chunk. `planeFormat` on `native: audio
   decoder initialized` says which.

2. **`format` is optional on the wire and its ABSENCE MEANS `f32le`.** Nothing
   that predates the field changes behaviour, because of (3).

3. **The broker never emits a format nobody asked for.**
   `subscribeAudioChunks` takes `accept: AudioChunkFormat[]` (the D448
   negotiation shape); `AudioChunkPlane` serves a chunk's own format when the
   subscription named it and expands to `f32le` otherwise — once per fanout,
   shared by every subscriber that needs it. A subscription that declared
   nothing gets exactly the bytes it got before this record existed. This is
   the whole of the safety argument, and it is what lets the broker and its
   consumers deploy one at a time across three nodes.

4. **One expansion, in `@camstack/types`.** `expandAudioChunkToF32le` is the
   only place a coded window becomes floats, and it always returns owned,
   0-offset bytes. Both addons are `self-contained` and bundle the bare
   `@camstack/types` entry, so this travels with `camstack deploy` and needs no
   published server. A second μ-law table anywhere is the defect.
   (`stream-broker.ts`'s `mulawToPcm` / `pcmToMulaw` are the ENCODE direction
   for the WebRTC egress — a different transform, not a copy.)

5. **The relay expands at the FLUSH, and `AudioChunkInput` is unchanged.**
   `AudioWindowAccumulator` declares `accept: ['pcmu','pcma']`, counts samples
   by `audioChunkBytesPerSample(format)` — not by a hard-coded 4, which would
   buffer four seconds before believing it had one — and expands the whole
   window once on flush. The analyzer cap's contract stays f32le, so no
   analyzer on any node, from any bundle, is ever handed bytes it cannot read.

6. **The byte format is part of a window's IDENTITY, not a label on it.** A
   chunk whose `format` differs from the open window's drops the partial window
   and is reported, exactly as a rate or channel change is (D450) — otherwise a
   redeploy under a live subscription concatenates one byte per sample with
   four and labels the result 8 kHz mono.

7. **Every leg says what it is serving and what that cost** (D427).
   `audio-chunk subscription serving` carries `sourceFormat`, `servedFormat`
   and `expanded`, once per subscription and again on every change — a leg
   still paying 4× because its consumer declared nothing is NAMED, not
   inferred from a byte census. `audio stream delivering` carries `format`
   beside the rate. `audio-chunk subscription added` carries the `accept` list.

## Consequences

- **Not deployed.** Committed only; `main` merges and deploys. Three agents
  deploying `addon-pipeline` from three worktrees on 2026-09-11 each shipped
  their own view of the package and silently reverted the others — D450 was
  overwritten twice and the hub ran three hours without the fix.
- **What this buys, as a projection, stated as one.** This record covers the
  two legs BEFORE the relay (broker → hub, hub → orchestrator); legs three and
  four still carry f32le because the accumulator expands before forwarding.
  Each of those legs is ~49 MB/min, and the G.711 share of the plane's bytes is
  now ~61 % (19 native cameras at 8 kHz f32le against 5–7 AAC at 16 kHz, from
  D450's fleet shape), of which 75 % goes away: **−45 MB/min of hub-main's 311,
  ~14 %.** The measurement that would confirm it is `socketTx` per peer on the
  `[mem] hub-main` line over ten clean minutes, and it has not been taken.
- **The relay leg is now worth MORE than this record, not less.** The gate on
  work item 3 of the load scaletta was "if the source bytes reduce enough, the
  relay may be worth less than its risk". They do not, and it is not. After
  this record the remaining audio plane is legs three and four at ~49 MB/min
  each — **~98 MB/min, untouched** — and moving `AudioWindowAccumulator` into
  `audio-analyzer` (D441 option 2 / D448) removes both of them outright *and*
  lets the surviving legs stay coded end to end, because the subscriber would
  then BE the decoder and the negotiation in (3) would need no third party.
  The deformity that forces the expansion to happen in the orchestrator is
  precisely the relay. Composed, the plane goes from ~196 MB/min to ~25.
- **The skew this does not have.** Because of (3) and (5) there is no deploy
  order that breaks: an old orchestrator declares no `accept` and is served
  f32le; a new orchestrator against an old broker sends an `accept` the broker
  ignores and is served f32le; an analyzer of any age receives f32le always.
  The cap-call path carries no schema validation (`addon-api-factory` does not
  parse), so the additive fields survive an unpublished server; the tRPC edge
  gets them at the next release.
- **The level a G.711 camera reports does not move by a single dB**: the table
  is byte-identical and the expansion is the same lookup, once per window
  instead of once per packet. The pinned values in the test are what makes
  that checkable rather than asserted.
- `AudioChunkPlane`'s docblock claim that chunks are "a few KB of Float32 PCM"
  is now true only of the AAC path; a native chunk is 4 KB of G.711.

## Enforcement

`packages/types/src/__tests__/audio-chunk-format.spec.ts` (bytes per sample,
the two tables against pinned values, owned 0-offset output, a misaligned
msgpack subview, the known-format guard),
`audio-chunk-format-negotiation.spec.ts` (coded served to a subscriber that
accepts it; expanded for one that declared nothing; expanded for one whose list
does not name the source format; two appetites from one fanout; f32le passed
through; the serving line once and again on change; `expanded: true` named; one
expansion shared), `audio-rtp-decoder.spec.ts` (the coded contract, payload
bytes verbatim, the chunk size, the codec label, the copy out of the reused
accumulator, and the tables end to end through the emitted chunk),
`audio-window-coded.spec.ts` (one sample per coded byte, f32le at the flush,
silence still metering ~0, f32le left alone, `format` reported, a format flip
dropping the partial window, absent = f32le, no off-by-a-sample across a chunk
boundary), `audio-chunk-poller.spec.ts` (`accept` on subscribe, omitted when
undeclared, **re-declared on the recovery re-subscribe**). Each guard disarmed
and the suite re-run:

| disarmed | red |
| --- | --- |
| the decoder labels its coded chunks `f32le` | 2 of 29 |
| the plane ignores `accept` and serves everyone the source format | 4 of 29 |
| the plane never says what it is serving | 2 of 29 |
| the accumulator counts 4 bytes per sample regardless of format | 5 of 19 |
| the accumulator flushes the coded bytes without expanding | 3 of 19 |
| the window format ignores the byte format | 1 of 19 |
| the recovery re-subscribe drops `accept` | 1 of 19 |

What is NOT guarded: that the orchestrator's controller keeps declaring
`accept` at all. Dropping it is a one-line regression that costs 45 MB/min and
breaks no test — but it is not silent, because `audio-chunk subscription
serving` would report `expanded: true` on every camera. That line is the guard,
and it is review-only.
