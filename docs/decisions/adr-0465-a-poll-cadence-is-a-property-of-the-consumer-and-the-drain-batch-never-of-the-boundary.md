---
id: D465
title: A poll cadence is a property of the fastest CONSUMER and of the drain batch, never of the boundary — and the FIFO that overwrites says so
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/audio-codec-session.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/audio-chunk-plane.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-chunk-poller.ts
last-verified: 2026-09-12
---

## Context

D455 and D461 took the audio plane's BYTES from ~196 MB/min to ~25. Neither
touched its MESSAGES, and after them audio is the largest single source of
requests on hub-main's UDS plane. Measured on the live hub at 2026-09-12 00:30
(night, low subject activity — a floor, not a peak), from three consecutive
`[mem] hub-main` heartbeats:

```
socketTopActions=
  audio-analyzer!stream-broker.pullAudioChunks : 24 260 kB / 2 748 : r2748/d0
  stream-broker!stream-broker.pullAudioChunks  : 24 220 kB / 2 748 : r0/d0
  stream-broker!audio-codec.pullPcm            : 16 373 kB / 5 997 : r5997/d0
  decoder-nodeav!audio-codec.pullPcm           : 16 244 kB / 5 997 : r0/d0
socketTop=
  stream-broker  : tx=2763/8679/3 rx=8679/2763/1985
  decoder-nodeav : tx=8496/1/0    rx=1/8496/0
  audio-analyzer : tx=0/2749/0    rx=2749/0/1571
```

Every one of these is RAW-forwarded (`r=all`, `d=0`), so hub-main copies the
bytes without parsing them. **The cost is the request count and the event-loop
time, not the bytes.**

**The actual multiplier, derived and then checked against the log.** The fleet,
counted from the 22:32 boot burst of `audio-chunk subscription serving`: **22
cameras attached, 18 `pcmu` (native G.711, coded since D455) and 4 `f32le`
(AAC through `AudioCodecSession`, target 16 kHz mono)**.

| leg | multiplier | calls/min |
| --- | --- | --- |
| `audioCodec.pullPcm` | 4 AAC decode sessions x 1/40 ms | 5 997 (= 4.0 x 25/s, exactly) |
| `audioCodec.pushEncodedFrame` | one RPC per depacketized AAC frame | 2 499 (8 496 − 5 997) |
| `streamBroker.pullAudioChunks` | 22 cameras x 1/200 ms, throttled by `classify` | 2 748 (= 45.8/s, ~2.08/s per camera) |

That is **11 244 originations/min**, and hub-main handles each one four times
(request in, request out, response in, response out): **~45 000 message
handlings/min, ~750/s**.

The byte model confirms the fleet shape independently: 4 x 64 kB/s (f32le
16 kHz) + 18 x 8 kB/s (coded G.711) = 400 kB/s, against 24 260 kB/min = 404 kB/s
measured. And 2.73 kB per `pullPcm` is exactly one 42 ms f32le frame — the poll
is matched 1:1 to a decoded frame, so the batch, not the emptiness, is what is
wrong.

**One number in the brief that prompted this was off, and it matters.** The
`decoder-nodeav: tx=8497 req/min` figure is not 8 497 `pullPcm` calls; it is
every request hub-main forwards to that peer. `pullPcm` is 5 997/min and
`pushEncodedFrame` is the other ~2 499 — which `socketTopActions` never shows,
because that list is ranked by BYTES and an AAC frame push is ~1 kB. A census
ranked by bytes cannot answer a question about counts (D456's own limit).

**What the 40 ms is FOR, traced rather than assumed.** `POLL_INTERVAL_MS = 40`
carries a comment naming its reason: the WebRTC PCMU / Opus egress, which
cannot take the ~500 ms window the accumulator used to produce. That is true.
But the branch it serves is already gated — `buildAudioCodecEmitCallback` does
the µ-law conversion, the 20 ms RTP slicing and `feedOpusEncoder` **only inside
`if (this.encodedCallbacks.size > 0)`**. With no live listener the one consumer
left is `this.audioChunkPlane.fanout(chunk)`, whose consumer accumulates to
`AUDIO_WINDOW_TARGET_MS` (1 000 ms) before it classifies anything and is watched
by a 90 s watchdog. At 00:30 `encodedCallbacks.size` was 0 on all four. **The
cadence and the work it feeds already disagreed; only the cadence did not know.**

**And a live defect found on the way, which is the same mistake in the other
direction.** D461 made the pull rate "a property of the boundary": 200 ms local,
500 ms remote, reasoned as *"500 ms matches the chunk cadence: the FIFO holds
~30 s and `PULL_MAX_COUNT` drains 8 at a time, so a poll per chunk loses
nothing."* That is true of `AudioRtpDecoder`, which buffers native G.711 into
~500 ms chunks. It is wrong by 12x for `AudioCodecSession`, which emits one
chunk per decoded codec frame — ~42 ms here, deliberately, because the
accumulator was removed to give WebRTC sub-100 ms latency. 500 ms of a 42 ms
producer is ~12 chunks against a batch of 8: a remote AAC camera falls ~4 chunks
further behind every poll, fills the 64-deep FIFO in ~15 s, and then loses
roughly a third of its audio for as long as it stays dispatched. It is latent
today (all 22 attachments are `hub/audio-analyzer`), and it is silent forever:
`RingBuffer.push` overwrites its oldest entry and **not one line is written**,
on a path whose every docblock calls the overwrite "a bounded safety valve, not
the steady-state behaviour".

**Why not events.** The plane already carries events and the broker already has
`hasDemand()` / `subscriberCount`, so pushing audio is buildable. It is refused:
D8/D11 make events telemetry that MAY be dropped, and a dropped audio chunk is
not a degraded reading — it is a hole in the exact window a classifier is about
to score, with nothing downstream able to notice or reconcile it. The pull is
the reconciliation. What was wrong was never the model; it was two constants
that had stopped describing anybody.

## Decision

**A poll cadence is derived from the fastest CONSUMER that exists right now and
bounded by the DRAIN BATCH against the producer's chunk rate. Never from the
boundary it crosses, and never from a constant nobody re-derived. A FIFO that
overwrites NAMES it.**

1. **`AudioCodecSession` polls at the cadence its consumers justify.**
   `REALTIME_POLL_INTERVAL_MS` (40 ms) while a live egress consumer is attached,
   `IDLE_POLL_INTERVAL_MS` (400 ms) when the only consumer is the audio-chunk
   plane. The probe is `RealtimeAudioDemand`, and the broker supplies
   **`() => this.encodedCallbacks.size > 0` — the same expression
   `buildAudioCodecEmitCallback` already branches on**, so the cadence and the
   work it feeds cannot disagree again. Omitted = always realtime, so no other
   caller changes behaviour.

2. **Demand is re-read every tick, not latched.** `setInterval` cannot change
   period; the loop re-arms itself with `setTimeout`. A listener arriving
   mid-stream is served at 40 ms within at most one idle interval (400 ms),
   against an ICE/DTLS handshake measured in seconds. The loop refuses to re-arm
   for a session `handleSessionGone` reaped — that orphan is what the mid-create
   race guard exists to prevent.

3. **The batch is what bounds the interval, and it is sized for the producer.**
   `MAX_PCM_PER_POLL` 16 → 32: an AAC session makes ~25 frames/s, so 400 ms is
   ~10 frames, a 3x margin that also covers a 21 ms-frame codec. The ceiling was
   16/42 ms = 640 ms; 400 ms is inside it with the margin stated rather than
   assumed. `PULL_MAX_COUNT` 8 → 32 for the same reason at the plane: 500 ms of
   a 21 ms producer is 24.

4. **A pull that comes back FULL is not a drain, it is a backlog — pull again,
   under a bound.** `MAX_DRAIN_CONTINUATIONS = 4`; the broker's FIFO holds 64 so
   two continuations clear a completely full queue. This costs zero extra
   requests when there is no backlog and makes the cadence safe for a producer
   this file cannot know about. It is the general form of (3), and it is why (3)
   is a margin rather than a guess.

5. **Every branch that loses or nearly loses audio NAMES it, per subscription.**
   `audio-chunk subscription OVERFLOW — oldest audio overwritten` with the
   capacity and a running `chunksDropped` (also carried onto D461's REAPED
   line), and `audio-chunk poller: backlog — a full batch is not a drain` with
   the drained count and the interval that produced it. Both fire once per
   EPISODE and re-state every 30 s — a per-chunk warn here is ~25 synchronous
   winston writes/s per camera on the broker's event loop, which is the cost the
   `pullPcm` warn coalescing already exists to avoid. `audio-codec: poll
   cadence` states each change with its reason, so "why does this camera's audio
   lag that one" is answerable from the log.

## Consequences

- **Projected, not measured — this worktree is not deployed and must not be.**
  `pullPcm` goes from 4 x 25/s to 4 x 2.5/s while nobody is listening:
  **5 997 → ~600 calls/min, −5 400/min**, which is −48 % of the 11 244
  originations/min the audio plane costs and ~−21 600 of hub-main's ~45 000
  message handlings/min. The confirmation is `socketTopActions`' `pullPcm` count
  on the `[mem] hub-main` line over ten clean minutes with no WebRTC audio
  session open; the failure signal is that it stays near 6 000.
- **The bytes do not move at all.** The same PCM crosses in fewer, larger
  messages (~10 frames x 2.7 kB instead of 1). Reporting a byte saving here
  would be reporting the wrong thing.
- **A camera someone is WATCHING costs exactly what it did**, and only that
  camera. This is the first time the audio decode path has been priced per
  viewer rather than per session.
- **`pullAudioChunks` is left at 200 ms local and that is the answer, not an
  omission.** Its measured rate is 2.08/s per camera, not the nominal 5/s,
  because `tick` awaits `onChunk` and the flush awaits `classify` — the loop is
  already self-throttled to roughly the window it feeds. Moving it to 500 ms
  would save ~100 calls/min of 11 244 and cost 300 ms of window latency on all
  22 cameras. It is not worth it. What WAS worth fixing on that leg is (3)+(4),
  which is correctness.
- **Worst-case added latency to a classification window is 400 ms** on a 1 000 ms
  window with a 90 s watchdog threshold, and only when no one is listening.
- **`AudioChunkSubscription` grows three fields** (`chunksDropped`,
  `overflowing`, `lastOverflowLogAt`) and `Lifecycle` two. All per-subscription,
  all in-process, none on the wire — no cap schema changed, so nothing here
  needs a published server.
- **Deploy order does not matter.** Both changes are inside `addon-pipeline`
  (the broker and the analyzer live in one package), no cap input or output
  moved, and `maxCount` was always a caller-supplied parameter with no upper
  bound in the schema. An old analyzer against a new broker and the reverse both
  behave exactly as today.
- **Not deployed. Committed in a worktree only**; the coordinator merges and
  deploys. Three agents deploying `addon-pipeline` from three worktrees on
  2026-09-11 each shipped their own view of the package and silently reverted
  the others for three hours.
- **`AudioChunkPoller`'s own docblock is now half wrong** where it says "chunks
  arrive only ~every 500ms (the broker's `AudioCodecSession` window)". That
  window was removed and the sentence is the leftover that made D461's 500 ms
  look checked. It is corrected at `PULL_MAX_COUNT`, which is where the number
  is actually decided.

## Enforcement

`audio-codec-poll-cadence.spec.ts` (the idle cadence with no realtime consumer;
the realtime cadence with one; a listener arriving being served within one idle
interval; the batch covering the idle interval against a 42 ms producer; an
absent probe behaving exactly as before), `audio-chunk-drain-batch.spec.ts` (the
batch covering `REMOTE_POLL_INTERVAL_MS` of a 42 ms producer; an immediate
re-poll while the batch comes back full; the continuation STOPPING on a short
batch — without which this is a spin; the backlog line), `audio-chunk-overflow.
spec.ts` (silence while the queue has room; the first overwrite named with its
subscription, tag and capacity; one line per episode, not 200, with the queue
still holding exactly the newest `AUDIO_QUEUE_CAPACITY` chunks so the loss stays
countable). Each guard disarmed and the suite re-run:

| disarmed | red |
| --- | --- |
| the cadence ignores demand and stays at 40 ms | 1 of 5 |
| `MAX_PCM_PER_POLL` back to 16 | 1 of 5 |
| the plane pushes without naming the overflow | 2 of 3 |
| no continuation after a full batch | 3 of 4 |
| `PULL_MAX_COUNT` back to 8 | 1 of 4 |
| the backlog line demoted to `debug` (which the hub does not write, D438) | 1 of 4 |

What is NOT guarded: that the broker keeps PASSING the demand probe. Dropping
the fifth argument at either construction site restores the old 40 ms cadence
and breaks no test, because the probe is optional by design — that optionality
is what makes every other caller of `AudioCodecSession` (the Reolink and
Hikvision intercom paths) unaffected. The `audio-codec: poll cadence` line is
the guard: a hub whose AAC cameras never log `reason: plane-only` is a hub where
the probe is not wired. Review-only.
